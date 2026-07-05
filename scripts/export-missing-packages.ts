#!/usr/bin/env bun

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const textDecoder = new TextDecoder();

function normalizeFlakeRef(ref: string): string {
  // 将本地路径统一规范化为 `path:` 输入，避免 Nix/Lix 在 macOS 上将目录识别为
  // `git+file:` 输入时因 shallow git 仓库或 git 子进程问题触发 `Broken pipe`。
  // 显式协议头保持不变，以兼容远程 flake 输入。
  const trimmed = ref.trim();
  if (
    trimmed.startsWith("path:") ||
    trimmed.startsWith("git+file:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("gitlab:") ||
    trimmed.startsWith("sourcehut:") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git+")
  ) {
    return trimmed;
  }
  return `path:${trimmed}`;
}

const flakeRef = normalizeFlakeRef(requireEnv("FLAKE_REF"));
const flakeAttr = requireEnv("FLAKE_ATTR");
const outputPath = Bun.env.PACKAGE_MATRIX_PATH ?? "package-matrix.json";
const selectorPath =
  Bun.env.HOST_PACKAGES_SELECTOR ?? "scripts/host-packages.nix";

const hostEntry = {
  host: requireEnv("HOST_NAME"),
  root: requireEnv("HOST_ROOT"),
  system: requireEnv("HOST_SYSTEM"),
  runner: requireEnv("HOST_RUNNER"),
  installer: requireEnv("HOST_INSTALLER"),
  expectedSystem: requireEnv("HOST_EXPECTED_SYSTEM"),
  flakeAttr,
  nixPackageName: requireEnv("HOST_NIX_PACKAGE_NAME"),
  extraSubstituters: Bun.env.HOST_EXTRA_SUBSTITUTERS ?? "",
  extraTrustedPublicKeys: Bun.env.HOST_EXTRA_TRUSTED_PUBLIC_KEYS ?? "",
  matrixKey: requireEnv("HOST_MATRIX_KEY"),
};

const cacheUrls = getCacheUrls();

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type PackageInfo = {
  attr: string;
  storePath: string;
};

type MatrixEntry = typeof hostEntry & {
  packageAttr: string;
  packageAttrJson: string;
  packageStorePath: string;
};

type MatrixOutput = {
  include: MatrixEntry[];
};

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function run(command: string, args: readonly string[]): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      NIXPKGS_ALLOW_UNFREE: "1",
    },
  });

  return {
    stdout: textDecoder.decode(result.stdout),
    stderr: textDecoder.decode(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}

function runRequired(command: string, args: readonly string[]): CommandResult {
  const result = run(command, args);
  if (result.exitCode === 0) {
    return result;
  }

  throw new Error(
    [
      `Command failed: ${[command, ...args].join(" ")}`,
      result.stdout,
      result.stderr,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(items: readonly string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.length > 0)));
}

function getCacheUrls(): string[] {
  const configured = Bun.env.CACHE_URLS ?? hostEntry.extraSubstituters;
  const urls = configured
    .split(/\s+/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  if (urls.length > 0) {
    return unique(urls);
  }

  const cachixName = Bun.env.CACHIX_NAME;
  return cachixName === undefined || cachixName.length === 0
    ? []
    : [`https://${cachixName}.cachix.org`];
}

function getHostPackages(): PackageInfo[] {
  const selector = readFileSync(selectorPath, "utf8");
  const expression = `host: builtins.mapAttrs (attr: package: { inherit attr; storePath = package.outPath; }) ((${selector}) host)`;
  const result = runRequired("nix", [
    "eval",
    "--json",
    `${flakeRef}#${flakeAttr}`,
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
        typeof value.storePath !== "string"
      ) {
        throw new Error(
          `Unexpected package metadata for ${attr}: ${JSON.stringify(value)}`,
        );
      }

      return { attr, storePath: value.storePath };
    })
    .sort((left, right) => left.attr.localeCompare(right.attr));
}

function pathInfoExists(parsed: unknown, storePath: string): boolean {
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      throw new Error(
        `Unexpected cache query result for ${storePath}: ${JSON.stringify(parsed)}`,
      );
    }

    const [pathInfo] = parsed;
    return (
      isRecord(pathInfo) &&
      (pathInfo.valid === undefined || pathInfo.valid === true)
    );
  }

  if (isRecord(parsed)) {
    if (!Object.hasOwn(parsed, storePath)) {
      throw new Error(
        `Unexpected cache query result for ${storePath}: ${JSON.stringify(parsed)}`,
      );
    }

    const pathInfo = parsed[storePath];
    if (pathInfo === null) {
      return false;
    }

    return (
      !isRecord(pathInfo) ||
      pathInfo.valid === undefined ||
      pathInfo.valid === true
    );
  }

  throw new Error(
    `Unexpected cache query result for ${storePath}: ${JSON.stringify(parsed)}`,
  );
}

function isCachedInStore(storeUrl: string, storePath: string): boolean {
  const result = run("nix", [
    "path-info",
    "--json",
    "--store",
    storeUrl,
    storePath,
  ]);

  if (result.exitCode !== 0) {
    return false;
  }

  return pathInfoExists(JSON.parse(result.stdout), storePath);
}

function cachedStoreUrl(storePath: string): string | undefined {
  return cacheUrls.find((storeUrl) => isCachedInStore(storeUrl, storePath));
}

function deduplicateByStorePath(
  packages: readonly PackageInfo[],
): PackageInfo[] {
  const seen = new Set<string>();

  return packages.filter((pkg) => {
    if (seen.has(pkg.storePath)) {
      console.log(
        `${hostEntry.root}.${hostEntry.host}.${pkg.attr}: duplicate ${pkg.storePath}`,
      );
      return false;
    }

    seen.add(pkg.storePath);
    return true;
  });
}

function buildMatrix(): MatrixOutput {
  const packages = deduplicateByStorePath(getHostPackages());
  const missing: PackageInfo[] = [];

  for (const pkg of packages) {
    const cachedBy = cachedStoreUrl(pkg.storePath);
    const status = cachedBy === undefined ? "missing" : `cached by ${cachedBy}`;
    console.log(
      `${hostEntry.root}.${hostEntry.host}.${pkg.attr}: ${status} ${pkg.storePath}`,
    );

    if (cachedBy === undefined) {
      missing.push(pkg);
    }
  }

  return {
    include: missing.map((pkg) => ({
      ...hostEntry,
      packageAttr: pkg.attr,
      packageAttrJson: JSON.stringify(pkg.attr),
      packageStorePath: pkg.storePath,
    })),
  };
}

function writeGithubOutput(name: string, value: string): void {
  const output = Bun.env.GITHUB_OUTPUT;
  if (output === undefined || output.length === 0) {
    return;
  }

  appendFileSync(output, `${name}=${value}\n`);
}

function writeGithubSummary(matrix: MatrixOutput): void {
  const summary = Bun.env.GITHUB_STEP_SUMMARY;
  if (summary === undefined || summary.length === 0) {
    return;
  }

  const rows = matrix.include
    .map(
      (entry) =>
        `| ${entry.root}.${entry.host} | ${entry.packageAttr} | ${entry.packageStorePath} |`,
    )
    .join("\n");

  appendFileSync(
    summary,
    [
      `## Missing packages: ${hostEntry.root}.${hostEntry.host}`,
      "",
      `Caches: \`${cacheUrls.join(" ") || "none"}\``,
      "",
      "| Host | Package | Store path |",
      "| --- | --- | --- |",
      rows || "| - | - | all cached |",
      "",
    ].join("\n"),
  );
}

const matrix = buildMatrix();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(matrix)}\n`);
writeGithubOutput("has_missing", String(matrix.include.length > 0));
writeGithubOutput("matrix", JSON.stringify(matrix));
writeGithubSummary(matrix);
console.log(JSON.stringify(matrix, null, 2));
