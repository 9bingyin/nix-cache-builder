#!/usr/bin/env bun

/**
 * discover-hosts
 * 阶段 0：只惰性枚举 flake 配置 attrset 中的主机名，不求值主机配置。
 * 完整配置会在 export-packages 阶段的目标平台 runner 上求值。
 *
 * 输入 env:
 *   FLAKE_REF, CONFIG_ROOTS?, HOSTS?, HOST_SYSTEM_OVERRIDES?,
 *   HOST_RUNNER_OVERRIDES?, AARCH64_DARWIN_RUNNER?, X86_64_DARWIN_RUNNER?,
 *   X86_64_LINUX_RUNNER?, AARCH64_LINUX_RUNNER?
 *
 * 输出 GITHUB_OUTPUT:
 *   has_hosts, flake_rev, matrix, hosts
 */

import {
  type HostSeed,
  type MatrixOutput,
  normalizeFlakeRef,
  runRequired,
  toFilesystemPath,
  writeGithubOutput,
  writeGithubSummary,
} from "./lib/common.ts";

const flakeRef = normalizeFlakeRef(Bun.env.FLAKE_REF ?? "./flake-config");
const configRoots = (
  Bun.env.CONFIG_ROOTS ??
  Bun.env.FLAKE_ATTR_ROOT ??
  "darwinConfigurations,nixosConfigurations"
)
  .split(",")
  .map((root) => root.trim())
  .filter((root) => root.length > 0);

const hostFilters = new Set(
  (Bun.env.HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0),
);

const hostSystemOverrides = parseStringMap(Bun.env.HOST_SYSTEM_OVERRIDES);
const runnerOverrides = parseStringMap(Bun.env.HOST_RUNNER_OVERRIDES);

const systemDefaults = {
  "aarch64-darwin": {
    runner: Bun.env.AARCH64_DARWIN_RUNNER ?? "macos-15",
  },
  "x86_64-darwin": {
    runner: Bun.env.X86_64_DARWIN_RUNNER ?? "macos-15-intel",
  },
  "x86_64-linux": {
    runner: Bun.env.X86_64_LINUX_RUNNER ?? "ubuntu-24.04",
  },
  "aarch64-linux": {
    runner: Bun.env.AARCH64_LINUX_RUNNER ?? "ubuntu-24.04-arm",
  },
} as const;

type SupportedSystem = keyof typeof systemDefaults;

// 不改 flake 时，配置根只能给出默认系统。非默认架构必须显式覆盖，
// 以避免把完整配置求值放到错误 runner 上。
const rootDefaultSystems: Record<string, SupportedSystem> = {
  darwinConfigurations: "aarch64-darwin",
  nixosConfigurations: "x86_64-linux",
};

type DiscoverOutput = {
  hasHosts: boolean;
  flakeRev: string;
  matrix: MatrixOutput<HostSeed>;
  hosts: MatrixOutput<HostSeed>;
};

function parseStringMap(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }

  const parsed: unknown = JSON.parse(value);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((entry) => typeof entry === "string")
  ) {
    throw new Error("Host overrides must be a JSON object with string values");
  }

  return parsed as Record<string, string>;
}

function isSupportedSystem(system: string): system is SupportedSystem {
  return Object.hasOwn(systemDefaults, system);
}

function nixAttrSegment(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : JSON.stringify(name);
}

function flakeAttrForHost(root: string, host: string): string {
  return `${root}.${nixAttrSegment(host)}`;
}

function matrixKeyForHost(root: string, host: string): string {
  return `${root}-${host}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function getFlakeRev(): string {
  return runRequired("git", [
    "-C",
    toFilesystemPath(flakeRef),
    "rev-parse",
    "HEAD",
  ]).stdout.trim();
}

function getHostsForRoot(root: string): string[] {
  // builtins.attrNames 不会强制求值 attrset 的值；这使 Linux discovery
  // 不会实现 Darwin 专用的 derivation 或触发其 platform mismatch。
  const result = runRequired("nix", [
    "eval",
    "--json",
    `${flakeRef}#${root}`,
    "--apply",
    "configs: builtins.attrNames configs",
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (!Array.isArray(parsed) || !parsed.every((host) => typeof host === "string")) {
    throw new Error(`Unexpected ${root} host list: ${result.stdout}`);
  }

  return parsed;
}

function isSyntheticConfigAlias(root: string, host: string): boolean {
  // 9bingyin/flake 为默认 Darwin 主机额外导出 `darwinConfigurations.default`。
  // 它指向同一配置，阶段 0 不应为它再派发一个重复的 export job。
  return root === "darwinConfigurations" && host === "default";
}

function configuredSystem(root: string, host: string): SupportedSystem {
  const override =
    hostSystemOverrides[`${root}.${host}`] ?? hostSystemOverrides[host];
  const system = override ?? rootDefaultSystems[root];

  if (system === undefined) {
    throw new Error(
      `No default system for ${root}.${host}; set HOST_SYSTEM_OVERRIDES for this host`,
    );
  }
  if (!isSupportedSystem(system)) {
    throw new Error(
      `Unsupported system for ${root}.${host}: ${system}. Supported: ${Object.keys(systemDefaults).join(", ")}`,
    );
  }

  return system;
}

function configuredRunner(root: string, host: string, system: SupportedSystem): string {
  return (
    runnerOverrides[`${root}.${host}`] ??
    runnerOverrides[host] ??
    systemDefaults[system].runner
  );
}

function discover(): DiscoverOutput {
  const flakeRev = getFlakeRev();
  const hosts = configRoots
    .flatMap((root) =>
      getHostsForRoot(root)
        .filter((host) => !isSyntheticConfigAlias(root, host))
        .map((host) => {
          const system = configuredSystem(root, host);
          return {
            host,
            root,
            runner: configuredRunner(root, host, system),
            expectedSystem: system,
            flakeAttr: flakeAttrForHost(root, host),
            flakeRev,
            matrixKey: matrixKeyForHost(root, host),
          } satisfies HostSeed;
        }),
    )
    .filter((host) => hostFilters.size === 0 || hostFilters.has(host.host))
    .sort((left, right) =>
      `${left.root}.${left.host}`.localeCompare(`${right.root}.${right.host}`),
    );

  if (hosts.length === 0) {
    throw new Error(
      hostFilters.size === 0
        ? `No hosts found under ${flakeRef}#${configRoots.join(",")}`
        : `No hosts matched HOSTS=${Array.from(hostFilters).join(",")}`,
    );
  }

  return {
    hasHosts: true,
    flakeRev,
    matrix: { include: hosts },
    hosts: { include: hosts },
  };
}

const result = discover();

writeGithubOutput("has_hosts", String(result.hasHosts));
writeGithubOutput("flake_rev", result.flakeRev);
writeGithubOutput("matrix", JSON.stringify(result.matrix));
writeGithubOutput("hosts", JSON.stringify(result.hosts));

writeGithubSummary([
  "## discover-hosts",
  "",
  "Only configuration names are enumerated here; full configurations are evaluated on their native runners during export-packages.",
  "",
  `Flake: \`${flakeRef}\``,
  `Flake revision: \`${result.flakeRev}\``,
  `Roots: \`${configRoots.join(",")}\``,
  "",
  "| Host | Expected system | Runner |",
  "| --- | --- | --- |",
  ...result.hosts.include.map(
    (entry) =>
      `| ${entry.root}.${entry.host} | ${entry.expectedSystem} | ${entry.runner} |`,
  ),
  "",
]);

console.log(JSON.stringify(result, null, 2));
