#!/usr/bin/env bun

/**
 * plan-builds
 * 汇总各主机导出的包列表，按 storePath 去重，并发探测缓存，产出包级 build matrix。
 *
 * 输入 env:
 *   PACKAGE_EXPORT_DIR, CACHE_URLS? / CACHIX_NAME?, CACHE_PROBE_CONCURRENCY?
 *
 * 输出 GITHUB_OUTPUT:
 *   has_builds, matrix, package_count, missing_count
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BuildMatrixEntry,
  type HostContext,
  type MatrixOutput,
  type PackageRecord,
  isHostContext,
  isPackageRecord,
  isRecord,
  mapPool,
  parsePositiveInt,
  unique,
  writeGithubOutput,
  writeGithubSummary,
} from "./lib/common.ts";

const exportDir = Bun.env.PACKAGE_EXPORT_DIR ?? "package-exports";
const probeConcurrency = parsePositiveInt(Bun.env.CACHE_PROBE_CONCURRENCY, 32);

type ExportFile = {
  host: HostContext;
  packages: PackageRecord[];
};

function listJsonFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      return listJsonFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
  });
}

function readExportFile(path: string): ExportFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) ||
    !isHostContext(parsed.host) ||
    !Array.isArray(parsed.packages) ||
    !parsed.packages.every(isPackageRecord)
  ) {
    throw new Error(`Unexpected package export file: ${path}`);
  }

  return {
    host: parsed.host,
    packages: parsed.packages,
  };
}

function collectPackages(): PackageRecord[] {
  return listJsonFiles(exportDir).flatMap(
    (path) => readExportFile(path).packages,
  );
}

/** 按 storePath 去重；保留字典序更前的 host 记录作为构建上下文 */
function dedupeByStorePath(
  packages: readonly PackageRecord[],
): PackageRecord[] {
  const sorted = [...packages].sort((left, right) =>
    `${left.root}.${left.host}.${left.packageAttr}`.localeCompare(
      `${right.root}.${right.host}.${right.packageAttr}`,
    ),
  );

  const seen = new Set<string>();
  const uniquePackages: PackageRecord[] = [];

  for (const pkg of sorted) {
    if (seen.has(pkg.packageStorePath)) {
      console.log(
        `dedupe ${pkg.root}.${pkg.host}.${pkg.packageAttr}: ${pkg.packageStorePath}`,
      );
      continue;
    }

    seen.add(pkg.packageStorePath);
    uniquePackages.push(pkg);
  }

  return uniquePackages;
}

function storePathHash(storePath: string): string {
  const baseName = storePath.split("/").pop();
  if (baseName === undefined || baseName.length < 32) {
    throw new Error(`Invalid store path: ${storePath}`);
  }

  return baseName.slice(0, 32);
}

function collectCacheUrls(packages: readonly PackageRecord[]): string[] {
  const fromEnv = (Bun.env.CACHE_URLS ?? "")
    .split(/\s+/)
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter((url) => url.length > 0);

  if (fromEnv.length > 0) {
    return unique(fromEnv);
  }

  const fromHosts = packages.flatMap((pkg) =>
    pkg.extraSubstituters
      .split(/\s+/)
      .map((url) => url.trim().replace(/\/$/, ""))
      .filter((url) => url.length > 0),
  );

  if (fromHosts.length > 0) {
    return unique(fromHosts);
  }

  const cachixName = Bun.env.CACHIX_NAME;
  return cachixName === undefined || cachixName.length === 0
    ? []
    : [`https://${cachixName}.cachix.org`];
}

async function isPresentInCache(
  cacheUrl: string,
  storePath: string,
): Promise<boolean> {
  const url = `${cacheUrl.replace(/\/$/, "")}/${storePathHash(storePath)}.narinfo`;

  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) {
      return true;
    }

    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, { method: "GET" });
      return get.ok;
    }

    return false;
  } catch {
    return false;
  }
}

async function findCachedBy(
  storePath: string,
  cacheUrls: readonly string[],
): Promise<string | undefined> {
  if (cacheUrls.length === 0) {
    return undefined;
  }

  const hits = await Promise.all(
    cacheUrls.map(async (cacheUrl) => {
      const present = await isPresentInCache(cacheUrl, storePath);
      return present ? cacheUrl : undefined;
    }),
  );

  return hits.find((hit) => hit !== undefined);
}

async function selectMissing(
  packages: readonly PackageRecord[],
  cacheUrls: readonly string[],
): Promise<PackageRecord[]> {
  if (cacheUrls.length === 0) {
    console.log("No cache URLs configured; treating all packages as missing");
    return [...packages];
  }

  console.log(
    `Probing ${packages.length} unique package(s) against ${cacheUrls.length} cache(s) with concurrency=${probeConcurrency}`,
  );

  const probes = await mapPool(packages, probeConcurrency, async (pkg) => {
    const cachedBy = await findCachedBy(pkg.packageStorePath, cacheUrls);
    const status = cachedBy === undefined ? "missing" : `cached by ${cachedBy}`;
    console.log(
      `${pkg.root}.${pkg.host}.${pkg.packageAttr} (${pkg.packageName}): ${status}`,
    );
    return { pkg, cachedBy };
  });

  return probes
    .filter((probe) => probe.cachedBy === undefined)
    .map((probe) => probe.pkg);
}

function toBuildMatrix(
  packages: readonly PackageRecord[],
): MatrixOutput<BuildMatrixEntry> {
  const include = packages
    .map(
      (pkg): BuildMatrixEntry => ({
        ...pkg,
        packageAttrJson: JSON.stringify(pkg.packageAttr),
      }),
    )
    .sort((left, right) =>
      `${left.system}.${left.packageAttr}`.localeCompare(
        `${right.system}.${right.packageAttr}`,
      ),
    );

  return { include };
}

const allPackages = collectPackages();
const uniquePackages = dedupeByStorePath(allPackages);
const cacheUrls = collectCacheUrls(uniquePackages);
const missing = await selectMissing(uniquePackages, cacheUrls);
const matrix = toBuildMatrix(missing);

console.log(
  `plan-builds: ${allPackages.length} exported -> ${uniquePackages.length} unique -> ${missing.length} missing builds`,
);

writeGithubOutput("has_builds", String(matrix.include.length > 0));
writeGithubOutput("matrix", JSON.stringify(matrix));
writeGithubOutput("package_count", String(uniquePackages.length));
writeGithubOutput("missing_count", String(missing.length));

writeGithubSummary([
  "## plan-builds",
  "",
  `Exported records: \`${allPackages.length}\``,
  `Unique store paths: \`${uniquePackages.length}\``,
  `Missing (to build): \`${missing.length}\``,
  `Caches: \`${cacheUrls.join(" ") || "none"}\``,
  `Probe concurrency: \`${probeConcurrency}\``,
  "",
  "| System | Name | Host | Attr |",
  "| --- | --- | --- | --- |",
  ...matrix.include
    .slice(0, 80)
    .map(
      (entry) =>
        `| ${entry.system} | ${entry.packageName} | ${entry.root}.${entry.host} | \`${entry.packageAttr}\` |`,
    ),
  ...(matrix.include.length > 80
    ? [`| ... | ${matrix.include.length - 80} more | | |`]
    : matrix.include.length === 0
      ? ["| - | all cached | - | - |"]
      : []),
  "",
]);

console.log(JSON.stringify(matrix, null, 2));
