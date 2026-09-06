#!/usr/bin/env nix
/*
#!nix shell github:NixOS/nixpkgs/nixos-unstable#bun --command bun
*/

// 求值配置顶层的平台和 derivation 路径，用于选择 runner 并合并别名；不执行构建。
import {
  type HostSeed,
  isRecord,
  nixString,
  normalizeFlakeRef,
  parseStringMap,
  runRequired,
  toFilesystemPath,
  toplevelAttr,
  writeGithubOutput,
  writeGithubSummary,
} from "./lib/common.ts";

const flakeRef = normalizeFlakeRef(Bun.env.FLAKE_REF ?? "./flake-config");
const roots = ["darwinConfigurations", "nixosConfigurations"];
const filters = (Bun.env.HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const systemOverrides = parseStringMap(Bun.env.HOST_SYSTEM_OVERRIDES);
const runnerOverrides = parseStringMap(Bun.env.HOST_RUNNER_OVERRIDES);
const runners: Record<string, string> = {
  "aarch64-darwin": Bun.env.AARCH64_DARWIN_RUNNER || "macos-15",
  "x86_64-darwin": Bun.env.X86_64_DARWIN_RUNNER || "macos-15-intel",
  "x86_64-linux": Bun.env.X86_64_LINUX_RUNNER || "ubuntu-24.04",
  "aarch64-linux": Bun.env.AARCH64_LINUX_RUNNER || "ubuntu-24.04-arm",
};

const flakeRev = runRequired("git", [
  "-C",
  toFilesystemPath(flakeRef),
  "rev-parse",
  "HEAD",
]);
const names: unknown = JSON.parse(
  runRequired("nix", [
    "eval",
    "--impure",
    "--json",
    "--expr",
    `let flake = builtins.getFlake ${nixString(flakeRef)}; in {
    darwinConfigurations = builtins.attrNames (flake.darwinConfigurations or {});
    nixosConfigurations = builtins.attrNames (flake.nixosConfigurations or {});
  }`,
  ]),
);
if (!isRecord(names)) throw new Error("Unexpected configuration list");

const hosts: (HostSeed & { drvPath: string })[] = [];
for (const root of roots) {
  const entries = names[root];
  if (
    !Array.isArray(entries) ||
    !entries.every((name) => typeof name === "string")
  ) {
    throw new Error(`Invalid host list for ${root}`);
  }
  for (const host of entries) {
    const key = `${root}.${host}`;
    if (filters.length && !filters.includes(host) && !filters.includes(key))
      continue;
    const flakeAttr = toplevelAttr(root, host);
    const metadata: unknown = JSON.parse(
      runRequired("nix", [
        "eval",
        "--impure",
        "--json",
        `${flakeRef}#${flakeAttr}`,
        "--apply",
        "toplevel: { inherit (toplevel) system drvPath; }",
      ]),
    );
    if (
      !isRecord(metadata) ||
      typeof metadata.system !== "string" ||
      typeof metadata.drvPath !== "string" ||
      !metadata.drvPath
    ) {
      throw new Error(`Invalid toplevel metadata for ${key}`);
    }
    const system =
      systemOverrides[key] ?? systemOverrides[host] ?? metadata.system;
    const runner =
      runnerOverrides[key] ?? runnerOverrides[host] ?? runners[system];
    if (!runner)
      throw new Error(
        `Unsupported system ${system} for ${key}; set HOST_RUNNER_OVERRIDES`,
      );
    hosts.push({
      host,
      root,
      runner,
      expectedSystem: system,
      flakeAttr,
      flakeRev,
      drvPath: metadata.drvPath,
    });
  }
}
for (const filter of filters) {
  if (
    !hosts.some(
      (host) => host.host === filter || `${host.root}.${host.host}` === filter,
    )
  ) {
    throw new Error(`No host matched HOSTS entry: ${filter}`);
  }
}
if (!hosts.length)
  throw new Error("No NixOS or nix-darwin configurations found");
// 先筛选并验证，再去重。显式只选 default 时，不会被未选中的主机替代。
const uniqueHosts = new Map<string, (typeof hosts)[number]>();
const aliases: string[] = [];
for (const host of hosts.sort(
  (left, right) =>
    Number(left.host === "default") - Number(right.host === "default"),
)) {
  const existing = uniqueHosts.get(host.drvPath);
  if (existing) {
    aliases.push(
      `${host.root}.${host.host} → ${existing.root}.${existing.host}`,
    );
  } else {
    uniqueHosts.set(host.drvPath, host);
  }
}
if (uniqueHosts.size > 256)
  throw new Error("Configuration count exceeds GitHub's 256-job matrix limit");

const matrix = { include: [...uniqueHosts.values()] };
writeGithubOutput("has_hosts", "true");
writeGithubOutput("matrix", JSON.stringify(matrix));
writeGithubSummary([
  "## Configuration builds",
  "",
  `Revision: \`${flakeRev}\``,
  "",
  "| Configuration | System | Runner |",
  "| --- | --- | --- |",
  ...matrix.include.map(
    (host) =>
      `| ${host.root}.${host.host} | ${host.expectedSystem} | ${host.runner} |`,
  ),
  ...(aliases.length
    ? [
        "",
        "### Deduplicated aliases",
        "",
        ...aliases.map((alias) => `- ${alias}`),
      ]
    : []),
]);
for (const alias of aliases) console.error(`Deduplicated: ${alias}`);
console.log(JSON.stringify(matrix, null, 2));
