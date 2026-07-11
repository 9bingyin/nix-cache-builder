#!/usr/bin/env bun

/**
 * plan-builds
 * 汇总各主机导出的包列表，按 storePath 去重，并发探测缓存，产出包级 build matrix。
 *
 * 输入 env:
 *   PACKAGE_EXPORT_DIR, CACHE_URLS? / CACHIX_NAME?, CACHE_PROBE_CONCURRENCY?
 * 探测范围 = CACHE_URLS ∪ 各主机 extraSubstituters ∪ CACHIX_NAME；
 * 命中但不在本机 substituters 中时标记 foreignCache（仍算 cached，不进 build）。
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
const probeConcurrency = parsePositiveInt(Bun.env.CACHE_PROBE_CONCURRENCY, 8);

type ExportFile = {
  host: HostContext;
  packages: PackageRecord[];
};

type SharedPathNote = {
  storePath: string;
  packageName: string;
  keptHost: string;
  keptAttr: string;
  otherHosts: string[];
  otherAttrs: string[];
};

type ProbeNote = {
  host: string;
  packageName: string;
  packageAttr: string;
  storePath: string;
  status: "missing" | "cached";
  cachedBy?: string;
  foreignCache: boolean;
  hostSubstituters: string[];
};

type DedupeResult = {
  packages: PackageRecord[];
  sharedPaths: SharedPathNote[];
};

type ProbeResult = {
  missing: PackageRecord[];
  notes: ProbeNote[];
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

function hostLabel(pkg: PackageRecord): string {
  return `${pkg.root}.${pkg.host}`;
}

function hostCacheUrls(pkg: PackageRecord): string[] {
  return unique(
    pkg.extraSubstituters
      .split(/\s+/)
      .map((url) => url.trim().replace(/\/$/, ""))
      .filter((url) => url.length > 0),
  );
}

/** 按 storePath 去重；保留字典序更前的 host 记录作为构建上下文 */
function dedupeByStorePath(packages: readonly PackageRecord[]): DedupeResult {
  const sorted = [...packages].sort((left, right) =>
    `${left.root}.${left.host}.${left.packageAttr}`.localeCompare(
      `${right.root}.${right.host}.${right.packageAttr}`,
    ),
  );

  const byPath = new Map<
    string,
    { kept: PackageRecord; others: PackageRecord[] }
  >();

  for (const pkg of sorted) {
    const existing = byPath.get(pkg.packageStorePath);
    if (existing === undefined) {
      byPath.set(pkg.packageStorePath, { kept: pkg, others: [] });
      continue;
    }

    existing.others.push(pkg);
  }

  const uniquePackages: PackageRecord[] = [];
  const sharedPaths: SharedPathNote[] = [];

  for (const [storePath, { kept, others }] of byPath) {
    uniquePackages.push(kept);

    if (others.length === 0) {
      continue;
    }

    const note: SharedPathNote = {
      storePath,
      packageName: kept.packageName,
      keptHost: hostLabel(kept),
      keptAttr: kept.packageAttr,
      otherHosts: unique(others.map((pkg) => hostLabel(pkg))),
      otherAttrs: others.map(
        (pkg) => `${hostLabel(pkg)}:\`${pkg.packageAttr}\``,
      ),
    };
    sharedPaths.push(note);

    console.log(
      `tip: same path shared by ${note.keptHost} (kept) and ${note.otherHosts.join(", ")}; build context uses ${note.keptHost}`,
    );
    console.log(`  path: ${storePath}`);
    console.log(
      `  package: ${note.packageName} (${note.keptAttr}); also as ${others
        .map((pkg) => `${hostLabel(pkg)}:${pkg.packageAttr}`)
        .join(", ")}`,
    );
  }

  sharedPaths.sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );

  return { packages: uniquePackages, sharedPaths };
}

function storePathHash(storePath: string): string {
  const baseName = storePath.split("/").pop();
  if (baseName === undefined || baseName.length < 32) {
    throw new Error(`Invalid store path: ${storePath}`);
  }

  return baseName.slice(0, 32);
}

function collectCacheUrls(packages: readonly PackageRecord[]): string[] {
  // 合并 env 与主机传来的 substituters；命中非本机缓存时由 foreignCache 标记，不提前 return 丢掉主机缓存。
  const fromEnv = (Bun.env.CACHE_URLS ?? "")
    .split(/\s+/)
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter((url) => url.length > 0);

  const fromHosts = packages.flatMap((pkg) =>
    pkg.extraSubstituters
      .split(/\s+/)
      .map((url) => url.trim().replace(/\/$/, ""))
      .filter((url) => url.length > 0),
  );

  const cachixName = Bun.env.CACHIX_NAME;
  const fromCachix =
    cachixName === undefined || cachixName.length === 0
      ? []
      : [`https://${cachixName}.cachix.org`];

  return unique([...fromEnv, ...fromHosts, ...fromCachix]);
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
  // 顺序探测，命中即停，避免对每个 path 同时打满所有 cache
  for (const cacheUrl of cacheUrls) {
    if (await isPresentInCache(cacheUrl, storePath)) {
      return cacheUrl;
    }
  }

  return undefined;
}

async function selectMissing(
  packages: readonly PackageRecord[],
  cacheUrls: readonly string[],
): Promise<ProbeResult> {
  if (cacheUrls.length === 0) {
    console.log("No cache URLs configured; treating all packages as missing");
    return {
      missing: [...packages],
      notes: packages.map((pkg) => ({
        host: hostLabel(pkg),
        packageName: pkg.packageName,
        packageAttr: pkg.packageAttr,
        storePath: pkg.packageStorePath,
        status: "missing" as const,
        foreignCache: false,
        hostSubstituters: hostCacheUrls(pkg),
      })),
    };
  }

  console.log(
    `Probing ${packages.length} unique package(s) against ${cacheUrls.length} cache(s) with concurrency=${probeConcurrency}`,
  );

  const probes = await mapPool(packages, probeConcurrency, async (pkg) => {
    const cachedBy = await findCachedBy(pkg.packageStorePath, cacheUrls);
    const ownCaches = hostCacheUrls(pkg);
    const foreignCache =
      cachedBy !== undefined &&
      ownCaches.length > 0 &&
      !ownCaches.includes(cachedBy);

    const status = cachedBy === undefined ? "missing" : `cached by ${cachedBy}`;
    console.log(
      `${hostLabel(pkg)}.${pkg.packageAttr} (${pkg.packageName}): ${status}`,
    );

    if (foreignCache && cachedBy !== undefined) {
      console.log(
        `tip: ${hostLabel(pkg)} path hit foreign cache ${cachedBy} (not in this host substituters: ${ownCaches.join(" ") || "none"})`,
      );
      console.log(`  path: ${pkg.packageStorePath}`);
    }

    const note: ProbeNote = {
      host: hostLabel(pkg),
      packageName: pkg.packageName,
      packageAttr: pkg.packageAttr,
      storePath: pkg.packageStorePath,
      status: cachedBy === undefined ? "missing" : "cached",
      ...(cachedBy === undefined ? {} : { cachedBy }),
      foreignCache,
      hostSubstituters: ownCaches,
    };

    return { pkg, cachedBy, note };
  });

  probes.sort((left, right) =>
    `${left.note.host}.${left.note.packageAttr}`.localeCompare(
      `${right.note.host}.${right.note.packageAttr}`,
    ),
  );

  return {
    missing: probes
      .filter((probe) => probe.cachedBy === undefined)
      .map((probe) => probe.pkg),
    notes: probes.map((probe) => probe.note),
  };
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

function markdownTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) {
    return ["_none_", ""];
  }

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

function buildSummary(args: {
  exportedCount: number;
  uniqueCount: number;
  missingCount: number;
  cacheUrls: readonly string[];
  sharedPaths: readonly SharedPathNote[];
  probeNotes: readonly ProbeNote[];
  matrix: MatrixOutput<BuildMatrixEntry>;
}): string[] {
  const cached = args.probeNotes.filter((note) => note.status === "cached");
  const foreign = args.probeNotes.filter((note) => note.foreignCache);
  const missingNotes = args.probeNotes.filter(
    (note) => note.status === "missing",
  );

  return [
    "## plan-builds",
    "",
    "### Overview",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Exported records | \`${args.exportedCount}\` |`,
    `| Unique store paths | \`${args.uniqueCount}\` |`,
    `| Shared paths (multi-host) | \`${args.sharedPaths.length}\` |`,
    `| Cached | \`${cached.length}\` |`,
    `| Foreign cache hits | \`${foreign.length}\` |`,
    `| Missing (to build) | \`${args.missingCount}\` |`,
    `| Caches probed | \`${args.cacheUrls.join(" ") || "none"}\` |`,
    `| Probe concurrency | \`${probeConcurrency}\` |`,
    "",
    "### Shared store paths",
    "",
    "Same `storePath` appears on multiple hosts; only one build context is kept.",
    "",
    ...markdownTable(
      ["Package", "Kept host", "Also on", "Store path"],
      args.sharedPaths.map((note) => [
        note.packageName,
        `\`${note.keptHost}\` (\`${note.keptAttr}\`)`,
        note.otherHosts.map((host) => `\`${host}\``).join(", "),
        `\`${note.storePath}\``,
      ]),
    ),
    "### Foreign cache hits",
    "",
    "Path is cached, but the hit URL is **not** in the kept host's own substituters.",
    "",
    ...markdownTable(
      ["Host", "Package", "Hit cache", "Host substituters", "Store path"],
      foreign.map((note) => [
        `\`${note.host}\``,
        note.packageName,
        `\`${note.cachedBy ?? ""}\``,
        note.hostSubstituters.map((url) => `\`${url}\``).join(" ") || "_none_",
        `\`${note.storePath}\``,
      ]),
    ),
    "### Cached packages",
    "",
    ...markdownTable(
      ["Host", "Package", "Cache", "Foreign?", "Store path"],
      cached.map((note) => [
        `\`${note.host}\``,
        note.packageName,
        `\`${note.cachedBy ?? ""}\``,
        note.foreignCache ? "yes" : "no",
        `\`${note.storePath}\``,
      ]),
    ),
    "### Missing packages (build matrix)",
    "",
    ...markdownTable(
      ["System", "Name", "Host", "Attr", "Store path"],
      args.matrix.include.map((entry) => [
        entry.system,
        entry.packageName,
        `\`${entry.root}.${entry.host}\``,
        `\`${entry.packageAttr}\``,
        `\`${entry.packageStorePath}\``,
      ]),
    ),
    // 若 probe 与 matrix 不一致时仍保留 missing notes 细节（一般相同）
    ...(missingNotes.length !== args.matrix.include.length
      ? [
          "### Missing probe notes",
          "",
          ...markdownTable(
            ["Host", "Package", "Attr", "Store path"],
            missingNotes.map((note) => [
              `\`${note.host}\``,
              note.packageName,
              `\`${note.packageAttr}\``,
              `\`${note.storePath}\``,
            ]),
          ),
        ]
      : []),
  ];
}

const allPackages = collectPackages();
const { packages: uniquePackages, sharedPaths } =
  dedupeByStorePath(allPackages);
const cacheUrls = collectCacheUrls(uniquePackages);
const { missing, notes: probeNotes } = await selectMissing(
  uniquePackages,
  cacheUrls,
);
const matrix = toBuildMatrix(missing);

console.log(
  `plan-builds: ${allPackages.length} exported -> ${uniquePackages.length} unique -> ${missing.length} missing builds`,
);
console.log(
  `notes: shared_paths=${sharedPaths.length} foreign_hits=${probeNotes.filter((n) => n.foreignCache).length}`,
);

writeGithubOutput("has_builds", String(matrix.include.length > 0));
writeGithubOutput("matrix", JSON.stringify(matrix));
writeGithubOutput("package_count", String(uniquePackages.length));
writeGithubOutput("missing_count", String(missing.length));

writeGithubSummary(
  buildSummary({
    exportedCount: allPackages.length,
    uniqueCount: uniquePackages.length,
    missingCount: missing.length,
    cacheUrls,
    sharedPaths,
    probeNotes,
    matrix,
  }),
);

console.log(JSON.stringify(matrix, null, 2));
