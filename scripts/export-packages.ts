#!/usr/bin/env bun

/**
 * export-packages
 * 阶段 1：在主机的原生 system 上完整求值配置，导出缓存设置与包根列表。
 *
 * 输入 env:
 *   FLAKE_REF, HOST_JSON (HostSeed), HOST_PACKAGES_SELECTOR?,
 *   PACKAGE_EXPORT_PATH?
 *
 * 输出:
 *   JSON 文件 { host, packages: PackageRecord[] }
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type HostContext,
  type HostSeed,
  type PackageRecord,
  isRecord,
  normalizeFlakeRef,
  parseHostSeedJson,
  requireEnv,
  runRequired,
  unique,
  writeGithubOutput,
  writeGithubSummary,
} from "./lib/common.ts";

const flakeRef = normalizeFlakeRef(requireEnv("FLAKE_REF"));
const hostSeed = parseHostSeedJson(requireEnv("HOST_JSON"));
const selectorPath =
  Bun.env.HOST_PACKAGES_SELECTOR ?? "scripts/host-packages.nix";
const outputPath =
  Bun.env.PACKAGE_EXPORT_PATH ?? `package-export/${hostSeed.matrixKey}.json`;

// 屏蔽所有教育网镜像（如 mirrors.ustc.edu.cn），域名以 .edu.cn 结尾即排除
function isExcludedSubstituter(substituter: string): boolean {
  try {
    const { hostname } = new URL(substituter);
    return hostname === "edu.cn" || hostname.endsWith(".edu.cn");
  } catch {
    return false;
  }
}

type ExportedPackage = {
  attr: string;
  name: string;
  storePath: string;
};

type ExportFile = {
  host: HostContext;
  packages: PackageRecord[];
};

type EvaluatedHostMetadata = {
  system: string;
  nixPackageName: string;
  substituters: string[];
  trustedPublicKeys: string[];
};

type EvaluatedExport = {
  host: EvaluatedHostMetadata;
  packages: ExportedPackage[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function installerFromNixPackage(nixPackageName: string): "lix" | "nix" {
  return nixPackageName.toLowerCase().includes("lix") ? "lix" : "nix";
}

function filterSubstituters(substituters: readonly string[]): string[] {
  return unique(substituters).filter((substituter) => {
    if (isExcludedSubstituter(substituter)) {
      console.log(`excluded substituter: ${substituter}`);
      return false;
    }

    return true;
  });
}

function getHostExport(seed: HostSeed): EvaluatedExport {
  const selector = readFileSync(selectorPath, "utf8");
  const expression = `host:
let
  getSystem = cfg:
    if cfg ? pkgs && cfg.pkgs ? stdenv && cfg.pkgs.stdenv ? hostPlatform && cfg.pkgs.stdenv.hostPlatform ? system then
      cfg.pkgs.stdenv.hostPlatform.system
    else if cfg ? config && cfg.config ? nixpkgs && cfg.config.nixpkgs ? hostPlatform then
      let
        hostPlatform = cfg.config.nixpkgs.hostPlatform;
      in
      if builtins.isString hostPlatform then
        hostPlatform
      else if hostPlatform ? system then
        hostPlatform.system
      else
        throw "Cannot infer nixpkgs.hostPlatform.system"
    else
      throw "Cannot infer host system";

  getNixPackageName = cfg:
    if cfg ? config && cfg.config ? nix && cfg.config.nix ? package then
      let
        pkg = cfg.config.nix.package;
      in
      if builtins.isAttrs pkg && pkg ? pname then
        pkg.pname
      else if builtins.isAttrs pkg && pkg ? name then
        pkg.name
      else
        "nix"
    else
      "nix";

  getNixSetting = cfg: name:
    if cfg ? config && cfg.config ? nix && cfg.config.nix ? settings && builtins.hasAttr name cfg.config.nix.settings then
      builtins.getAttr name cfg.config.nix.settings
    else
      [];

  packages = ((${selector}) host);
in
{
  host = {
    system = getSystem host;
    nixPackageName = getNixPackageName host;
    substituters = getNixSetting host "substituters" ++ getNixSetting host "extra-substituters";
    trustedPublicKeys = getNixSetting host "trusted-public-keys" ++ getNixSetting host "extra-trusted-public-keys";
  };
  packages = builtins.mapAttrs (attr: package: {
    inherit attr;
    name = package.pname or package.name or attr;
    storePath = package.outPath;
  }) packages;
}`;

  const result = runRequired("nix", [
    "eval",
    "--json",
    `${flakeRef}#${seed.flakeAttr}`,
    "--apply",
    expression,
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (
    !isRecord(parsed) ||
    !isRecord(parsed.host) ||
    !isRecord(parsed.packages) ||
    typeof parsed.host.system !== "string" ||
    typeof parsed.host.nixPackageName !== "string" ||
    !isStringArray(parsed.host.substituters) ||
    !isStringArray(parsed.host.trustedPublicKeys)
  ) {
    throw new Error(`Unexpected host export: ${result.stdout}`);
  }

  const packages = Object.entries(parsed.packages)
    .map(([attr, value]) => {
      if (
        !isRecord(value) ||
        value.attr !== attr ||
        typeof value.storePath !== "string" ||
        typeof value.name !== "string"
      ) {
        throw new Error(
          `Unexpected package metadata for ${attr}: ${JSON.stringify(value)}`,
        );
      }

      return { attr, name: value.name, storePath: value.storePath };
    })
    .sort((left, right) => left.attr.localeCompare(right.attr));

  return {
    host: {
      system: parsed.host.system,
      nixPackageName: parsed.host.nixPackageName,
      substituters: parsed.host.substituters,
      trustedPublicKeys: parsed.host.trustedPublicKeys,
    },
    packages,
  };
}

function completeHostContext(
  seed: HostSeed,
  metadata: EvaluatedHostMetadata,
): HostContext {
  if (metadata.system !== seed.expectedSystem) {
    throw new Error(
      `${seed.root}.${seed.host} evaluates to ${metadata.system}, but its discovery runner expects ${seed.expectedSystem}. Set HOST_SYSTEM_OVERRIDES for this host.`,
    );
  }

  return {
    ...seed,
    system: metadata.system,
    installer: installerFromNixPackage(metadata.nixPackageName),
    nixPackageName: metadata.nixPackageName,
    extraSubstituters: filterSubstituters(metadata.substituters).join(" "),
    extraTrustedPublicKeys: unique(metadata.trustedPublicKeys).join(" "),
  };
}

function toRecords(
  host: HostContext,
  packages: readonly ExportedPackage[],
): PackageRecord[] {
  const seen = new Set<string>();
  const records: PackageRecord[] = [];

  for (const pkg of packages) {
    if (seen.has(pkg.storePath)) {
      console.log(
        `${host.root}.${host.host}.${pkg.attr}: duplicate ${pkg.storePath}`,
      );
      continue;
    }

    seen.add(pkg.storePath);
    records.push({
      ...host,
      packageAttr: pkg.attr,
      packageName: pkg.name,
      packageStorePath: pkg.storePath,
    });
  }

  return records;
}

const evaluated = getHostExport(hostSeed);
const host = completeHostContext(hostSeed, evaluated.host);
const packages = toRecords(host, evaluated.packages);
const exportFile: ExportFile = { host, packages };

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(exportFile)}\n`);

writeGithubOutput("package_count", String(packages.length));
writeGithubSummary([
  `## export-packages: ${host.root}.${host.host}`,
  "",
  `System: \`${host.system}\``,
  `Packages: \`${packages.length}\``,
  "",
  "| Name | Attr | Store path |",
  "| --- | --- | --- |",
  ...packages
    .slice(0, 50)
    .map(
      (pkg) =>
        `| ${pkg.packageName} | \`${pkg.packageAttr}\` | \`${pkg.packageStorePath}\` |`,
    ),
  ...(packages.length > 50 ? [`| ... | ${packages.length - 50} more | |`] : []),
  "",
]);

console.log(
  JSON.stringify(
    {
      host: `${host.root}.${host.host}`,
      system: host.system,
      packageCount: packages.length,
      outputPath,
    },
    null,
    2,
  ),
);
