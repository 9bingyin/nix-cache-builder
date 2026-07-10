#!/usr/bin/env bun

/**
 * discover-hosts
 * 从 flake 枚举 darwinConfigurations / nixosConfigurations，产出主机矩阵。
 *
 * 输入 env:
 *   FLAKE_REF, CONFIG_ROOTS?, HOSTS?, HOST_RUNNER_OVERRIDES?,
 *   AARCH64_DARWIN_RUNNER?, X86_64_DARWIN_RUNNER?,
 *   X86_64_LINUX_RUNNER?, AARCH64_LINUX_RUNNER?
 *
 * 输出 GITHUB_OUTPUT:
 *   has_hosts, flake_rev, matrix, hosts
 */

import {
  type HostContext,
  type MatrixOutput,
  normalizeFlakeRef,
  run,
  runRequired,
  toFilesystemPath,
  unique,
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

const excludedSubstituters = new Set([
  "https://mirrors.ustc.edu.cn/nix-channels/store",
]);

const hostFilters = new Set(
  (Bun.env.HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0),
);

const runnerOverrides = parseRunnerOverrides(Bun.env.HOST_RUNNER_OVERRIDES);

const systemDefaults = {
  "aarch64-darwin": {
    runner: Bun.env.AARCH64_DARWIN_RUNNER ?? "macos-15",
    currentSystem: "aarch64-darwin",
  },
  "x86_64-darwin": {
    runner: Bun.env.X86_64_DARWIN_RUNNER ?? "macos-15-intel",
    currentSystem: "x86_64-darwin",
  },
  "x86_64-linux": {
    runner: Bun.env.X86_64_LINUX_RUNNER ?? "ubuntu-24.04",
    currentSystem: "x86_64-linux",
  },
  "aarch64-linux": {
    runner: Bun.env.AARCH64_LINUX_RUNNER ?? "ubuntu-24.04-arm",
    currentSystem: "aarch64-linux",
  },
} as const;

type SupportedSystem = keyof typeof systemDefaults;
type Installer = "lix" | "nix";

type RawHostInfo = {
  root: string;
  hostName: string;
  canonicalHostName: string;
  hostSystem: string;
  nixPackageName: string;
  substituters: string[];
  trustedPublicKeys: string[];
};

type DiscoverOutput = {
  hasHosts: boolean;
  flakeRev: string;
  matrix: MatrixOutput<HostContext>;
  hosts: MatrixOutput<HostContext>;
};

function parseRunnerOverrides(
  value: string | undefined,
): Record<string, string> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }

  const parsed: unknown = JSON.parse(value);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((runner) => typeof runner === "string")
  ) {
    throw new Error(
      "HOST_RUNNER_OVERRIDES must be a JSON object of host to runner label",
    );
  }

  return parsed as Record<string, string>;
}

function isSupportedSystem(system: string): system is SupportedSystem {
  return Object.hasOwn(systemDefaults, system);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

function nixAttrSegment(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : JSON.stringify(name);
}

function flakeAttrForHost(root: string, host: string): string {
  return `${root}.${nixAttrSegment(host)}`;
}

function installerFromNixPackage(nixPackageName: string): Installer {
  return nixPackageName.toLowerCase().includes("lix") ? "lix" : "nix";
}

function filterSubstituters(substituters: readonly string[]): string[] {
  return unique(substituters).filter((substituter) => {
    if (excludedSubstituters.has(substituter)) {
      console.log(`excluded substituter: ${substituter}`);
      return false;
    }

    return true;
  });
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

function getHostsForRoot(root: string): RawHostInfo[] {
  const expression = String.raw`
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

  getHostCacheSettings = cfg: {
    substituters = getNixSetting cfg "substituters" ++ getNixSetting cfg "extra-substituters";
    trustedPublicKeys = getNixSetting cfg "trusted-public-keys" ++ getNixSetting cfg "extra-trusted-public-keys";
  };

  getCanonicalHostName = hostName: cfg:
    if cfg ? config && cfg.config ? local && cfg.config.local ? host && cfg.config.local.host ? name then
      cfg.config.local.host.name
    else if cfg ? config && cfg.config ? networking && cfg.config.networking ? hostName then
      cfg.config.networking.hostName
    else
      hostName;
in
configs: builtins.mapAttrs (hostName: cfg: {
  hostName = hostName;
  canonicalHostName = getCanonicalHostName hostName cfg;
  hostSystem = getSystem cfg;
  nixPackageName = getNixPackageName cfg;
} // getHostCacheSettings cfg) configs
`;

  const result = run("nix", [
    "eval",
    "--json",
    `${flakeRef}#${root}`,
    "--apply",
    expression,
  ]);

  if (result.exitCode !== 0) {
    console.warn(
      `Skipping ${flakeRef}#${root}: evaluation failed or attribute is absent`,
    );
    console.warn(result.stderr.trim());
    return [];
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unexpected ${root} evaluation result: ${result.stdout}`);
  }

  return Object.values(parsed).map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as RawHostInfo).hostName !== "string" ||
      typeof (value as RawHostInfo).canonicalHostName !== "string" ||
      typeof (value as RawHostInfo).hostSystem !== "string" ||
      typeof (value as RawHostInfo).nixPackageName !== "string" ||
      !isStringArray((value as RawHostInfo).substituters) ||
      !isStringArray((value as RawHostInfo).trustedPublicKeys)
    ) {
      throw new Error(`Unexpected host metadata: ${JSON.stringify(value)}`);
    }

    return {
      ...(value as Omit<RawHostInfo, "root">),
      root,
    };
  });
}

function deduplicateHostAliases(hosts: readonly RawHostInfo[]): RawHostInfo[] {
  const byCanonicalName = new Map<string, RawHostInfo>();

  for (const host of hosts) {
    const key = `${host.root}:${host.canonicalHostName}`;
    const existing = byCanonicalName.get(key);
    if (existing === undefined) {
      byCanonicalName.set(key, host);
      continue;
    }

    const existingIsAlias = existing.hostName !== existing.canonicalHostName;
    const hostIsAlias = host.hostName !== host.canonicalHostName;
    if (existingIsAlias && !hostIsAlias) {
      console.log(
        `${existing.root}.${existing.hostName}: alias of ${existing.canonicalHostName}, skipped`,
      );
      byCanonicalName.set(key, host);
      continue;
    }

    console.log(
      `${host.root}.${host.hostName}: alias of ${host.canonicalHostName}, skipped`,
    );
  }

  return Array.from(byCanonicalName.values());
}

function discover(): DiscoverOutput {
  const allHosts = deduplicateHostAliases(
    configRoots
      .flatMap((root) => getHostsForRoot(root))
      .filter(
        (host) =>
          hostFilters.size === 0 ||
          hostFilters.has(host.hostName) ||
          hostFilters.has(host.canonicalHostName),
      ),
  ).sort((left, right) =>
    `${left.root}.${left.hostName}`.localeCompare(
      `${right.root}.${right.hostName}`,
    ),
  );

  if (allHosts.length === 0) {
    throw new Error(
      hostFilters.size === 0
        ? `No hosts found under ${flakeRef}#${configRoots.join(",")}`
        : `No hosts matched HOSTS=${Array.from(hostFilters).join(",")}`,
    );
  }

  const entries = allHosts.map((host): HostContext => {
    if (!isSupportedSystem(host.hostSystem)) {
      throw new Error(
        `Unsupported host system for ${host.root}.${host.hostName}: ${host.hostSystem}. Supported: ${Object.keys(
          systemDefaults,
        ).join(", ")}`,
      );
    }

    const defaults = systemDefaults[host.hostSystem];
    const installer = installerFromNixPackage(host.nixPackageName);
    const substituters = filterSubstituters(host.substituters);
    const trustedPublicKeys = unique(host.trustedPublicKeys);

    console.log(
      `${host.root}.${host.hostName}: ${host.hostSystem} ${installer}`,
    );

    return {
      host: host.hostName,
      root: host.root,
      system: host.hostSystem,
      runner:
        runnerOverrides[`${host.root}.${host.hostName}`] ??
        runnerOverrides[host.hostName] ??
        defaults.runner,
      installer,
      expectedSystem: defaults.currentSystem,
      flakeAttr: flakeAttrForHost(host.root, host.hostName),
      nixPackageName: host.nixPackageName,
      extraSubstituters: substituters.join(" "),
      extraTrustedPublicKeys: trustedPublicKeys.join(" "),
      matrixKey: matrixKeyForHost(host.root, host.hostName),
    };
  });

  const matrix: MatrixOutput<HostContext> = { include: entries };

  return {
    hasHosts: entries.length > 0,
    flakeRev: getFlakeRev(),
    matrix,
    hosts: matrix,
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
  `Flake: \`${flakeRef}\``,
  `Flake revision: \`${result.flakeRev}\``,
  `Roots: \`${configRoots.join(",")}\``,
  "",
  "| Host | System | Runner | Installer | nix.package |",
  "| --- | --- | --- | --- | --- |",
  ...result.hosts.include.map(
    (entry) =>
      `| ${entry.root}.${entry.host} | ${entry.system} | ${entry.runner} | ${entry.installer} | ${entry.nixPackageName} |`,
  ),
  "",
]);

console.log(JSON.stringify(result, null, 2));
