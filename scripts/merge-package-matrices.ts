#!/usr/bin/env bun

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const matrixDir = Bun.env.PACKAGE_MATRIX_DIR ?? "package-matrices";

type PackageMatrixEntry = {
  host: string;
  root: string;
  system: string;
  runner: string;
  installer: string;
  expectedSystem: string;
  flakeAttr: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
  matrixKey: string;
  packageAttr: string;
  packageAttrJson: string;
  packageName?: string;
  packageStorePath: string;
};

type HostBuildEntry = {
  host: string;
  root: string;
  system: string;
  runner: string;
  installer: string;
  expectedSystem: string;
  flakeAttr: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
  matrixKey: string;
  packageCount: number;
  packageAttrsJson: string;
  packageNames: string;
};

type PackageMatrixOutput = {
  include: PackageMatrixEntry[];
};

type HostMatrixOutput = {
  include: HostBuildEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageMatrixEntry(value: unknown): value is PackageMatrixEntry {
  return (
    isRecord(value) &&
    typeof value.host === "string" &&
    typeof value.root === "string" &&
    typeof value.system === "string" &&
    typeof value.runner === "string" &&
    typeof value.installer === "string" &&
    typeof value.expectedSystem === "string" &&
    typeof value.flakeAttr === "string" &&
    typeof value.nixPackageName === "string" &&
    typeof value.extraSubstituters === "string" &&
    typeof value.extraTrustedPublicKeys === "string" &&
    typeof value.matrixKey === "string" &&
    typeof value.packageAttr === "string" &&
    typeof value.packageAttrJson === "string" &&
    typeof value.packageStorePath === "string" &&
    (value.packageName === undefined || typeof value.packageName === "string")
  );
}

function listJsonFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      return listJsonFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
  });
}

function readMatrix(path: string): PackageMatrixOutput {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.include)) {
    throw new Error(`Unexpected matrix file: ${path}`);
  }

  if (!parsed.include.every(isPackageMatrixEntry)) {
    throw new Error(`Unexpected matrix entry in ${path}`);
  }

  return { include: parsed.include };
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    return;
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}

function packageLabel(entry: PackageMatrixEntry): string {
  return entry.packageName ?? entry.packageAttr;
}

/** 跨主机按 store path 去重，避免同一路径被多个 host job 重复构建 */
function dedupeByStorePath(
  entries: readonly PackageMatrixEntry[],
): PackageMatrixEntry[] {
  const sorted = [...entries].sort((left, right) =>
    `${left.root}.${left.host}.${left.packageAttr}`.localeCompare(
      `${right.root}.${right.host}.${right.packageAttr}`,
    ),
  );

  const seen = new Set<string>();
  const unique: PackageMatrixEntry[] = [];

  for (const entry of sorted) {
    if (seen.has(entry.packageStorePath)) {
      console.log(
        `dedupe ${entry.root}.${entry.host}.${entry.packageAttr}: ${entry.packageStorePath}`,
      );
      continue;
    }

    seen.add(entry.packageStorePath);
    unique.push(entry);
  }

  return unique;
}

/** 按 host 聚合，供 job 内 nix-fast-build 并发构建多个包 */
function groupByHost(entries: readonly PackageMatrixEntry[]): HostBuildEntry[] {
  const groups = new Map<string, PackageMatrixEntry[]>();

  for (const entry of entries) {
    const key = entry.matrixKey;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const [head] = group;
      if (head === undefined) {
        throw new Error("Unexpected empty host group");
      }

      const attrs = group
        .map((entry) => entry.packageAttr)
        .sort((left, right) => left.localeCompare(right));
      const names = group
        .map((entry) => packageLabel(entry))
        .sort((left, right) => left.localeCompare(right));

      return {
        host: head.host,
        root: head.root,
        system: head.system,
        runner: head.runner,
        installer: head.installer,
        expectedSystem: head.expectedSystem,
        flakeAttr: head.flakeAttr,
        nixPackageName: head.nixPackageName,
        extraSubstituters: head.extraSubstituters,
        extraTrustedPublicKeys: head.extraTrustedPublicKeys,
        matrixKey: head.matrixKey,
        packageCount: attrs.length,
        packageAttrsJson: JSON.stringify(attrs),
        packageNames: names.join(", "),
      };
    })
    .sort((left, right) =>
      `${left.root}.${left.host}`.localeCompare(`${right.root}.${right.host}`),
    );
}

const packageEntries = listJsonFiles(matrixDir).flatMap(
  (path) => readMatrix(path).include,
);
const uniqueEntries = dedupeByStorePath(packageEntries);
const hostMatrix: HostMatrixOutput = {
  include: groupByHost(uniqueEntries),
};

console.log(
  `Merged ${packageEntries.length} package entr(y/ies) -> ${uniqueEntries.length} unique path(s) -> ${hostMatrix.include.length} host job(s)`,
);

writeGithubOutput("has_missing", String(hostMatrix.include.length > 0));
writeGithubOutput("matrix", JSON.stringify(hostMatrix));
console.log(JSON.stringify(hostMatrix, null, 2));
