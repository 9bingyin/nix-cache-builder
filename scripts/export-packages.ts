#!/usr/bin/env bun

/**
 * export-packages
 * 在原生 system 上 eval 主机配置，导出包根列表（不做缓存探测）。
 *
 * 输入 env:
 *   FLAKE_REF, HOST_JSON (HostContext), HOST_PACKAGES_SELECTOR?,
 *   PACKAGE_EXPORT_PATH?
 *
 * 输出:
 *   JSON 文件 { host, packages: PackageRecord[] }
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type HostContext,
  type PackageRecord,
  isRecord,
  normalizeFlakeRef,
  parseHostContextJson,
  requireEnv,
  runRequired,
  writeGithubOutput,
  writeGithubSummary,
} from "./lib/common.ts";

const flakeRef = normalizeFlakeRef(requireEnv("FLAKE_REF"));
const host = parseHostContextJson(requireEnv("HOST_JSON"));
const selectorPath =
  Bun.env.HOST_PACKAGES_SELECTOR ?? "scripts/host-packages.nix";
const outputPath =
  Bun.env.PACKAGE_EXPORT_PATH ?? `package-export/${host.matrixKey}.json`;

type ExportedPackage = {
  attr: string;
  name: string;
  storePath: string;
};

type ExportFile = {
  host: HostContext;
  packages: PackageRecord[];
};

function getHostPackages(): ExportedPackage[] {
  const selector = readFileSync(selectorPath, "utf8");
  const expression = `host: builtins.mapAttrs (attr: package: {
    inherit attr;
    name = package.pname or package.name or attr;
    storePath = package.outPath;
  }) ((${selector}) host)`;

  const result = runRequired("nix", [
    "eval",
    "--json",
    `${flakeRef}#${host.flakeAttr}`,
    "--apply",
    expression,
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (!isRecord(parsed)) {
    throw new Error(`Unexpected package metadata: ${result.stdout}`);
  }

  return Object.entries(parsed)
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
}

function toRecords(packages: readonly ExportedPackage[]): PackageRecord[] {
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

const packages = toRecords(getHostPackages());
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
