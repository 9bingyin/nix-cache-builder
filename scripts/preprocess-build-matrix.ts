#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

const textDecoder = new TextDecoder();

const flakeRef = Bun.env.FLAKE_REF ?? "./flake-config";
const configRoots = (Bun.env.CONFIG_ROOTS ?? Bun.env.FLAKE_ATTR_ROOT ?? "darwinConfigurations,nixosConfigurations")
  .split(",")
  .map((root) => root.trim())
  .filter((root) => root.length > 0);
const cachixName = Bun.env.CACHIX_NAME;
const cacheUrl =
  Bun.env.NIX_BINARY_CACHE_URL ??
  (cachixName === undefined || cachixName.length === 0
    ? undefined
    : `https://${cachixName}.cachix.org`);
const buildOnlyMissing = (Bun.env.BUILD_ONLY_MISSING ?? "true") !== "false";
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

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type HostInfo = {
  root: string;
  hostName: string;
  hostSystem: string;
  storePath: string;
  nixPackageName: string;
  substituters: string[];
  trustedPublicKeys: string[];
};

type CachePathInfo = {
  path: string;
  valid?: boolean;
};

type MatrixEntry = {
  host: string;
  root: string;
  system: SupportedSystem;
  runner: string;
  installer: Installer;
  expectedSystem: string;
  flakeAttr: string;
  storePath: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
  cached: boolean;
};

type MatrixOutput = {
  include: MatrixEntry[];
};

type PlanOutput = {
  hasMissing: boolean;
  matrix: MatrixOutput;
  allHosts: MatrixOutput;
};

function parseRunnerOverrides(value: string | undefined): Record<string, string> {
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
    throw new Error("HOST_RUNNER_OVERRIDES must be a JSON object of host to runner label");
  }

  return parsed as Record<string, string>;
}

function isSupportedSystem(system: string): system is SupportedSystem {
  return Object.hasOwn(systemDefaults, system);
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
    [`Command failed: ${[command, ...args].join(" ")}`, result.stdout, result.stderr]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

function nixAttrSegment(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name)
    ? name
    : JSON.stringify(name);
}

function flakeAttrForHost(root: string, host: string): string {
  const configAttr = `${root}.${nixAttrSegment(host)}`;

  if (root === "darwinConfigurations") {
    return `${configAttr}.system`;
  }

  if (root === "nixosConfigurations") {
    return `${configAttr}.config.system.build.toplevel`;
  }

  throw new Error(`Unsupported config root for build attr: ${root}`);
}

function installerFromNixPackage(nixPackageName: string): Installer {
  return nixPackageName.toLowerCase().includes("lix") ? "lix" : "nix";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

function unique(items: readonly string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.length > 0)));
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

function getHostsForRoot(root: string): HostInfo[] {
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

  getStorePath = cfg:
    if cfg ? system then
      cfg.system.outPath
    else if cfg ? config && cfg.config ? system && cfg.config.system ? build && cfg.config.system.build ? toplevel then
      cfg.config.system.build.toplevel.outPath
    else
      throw "Cannot infer system build output";

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
in
configs: builtins.mapAttrs (hostName: cfg: {
  hostName = hostName;
  hostSystem = getSystem cfg;
  storePath = getStorePath cfg;
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
    console.warn(`Skipping ${flakeRef}#${root}: evaluation failed or attribute is absent`);
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
      typeof (value as HostInfo).hostName !== "string" ||
      typeof (value as HostInfo).hostSystem !== "string" ||
      typeof (value as HostInfo).storePath !== "string" ||
      typeof (value as HostInfo).nixPackageName !== "string" ||
      !isStringArray((value as HostInfo).substituters) ||
      !isStringArray((value as HostInfo).trustedPublicKeys)
    ) {
      throw new Error(`Unexpected host metadata: ${JSON.stringify(value)}`);
    }

    return {
      ...(value as Omit<HostInfo, "root">),
      root,
    };
  });
}

function getHosts(): HostInfo[] {
  return configRoots.flatMap((root) => getHostsForRoot(root));
}

function isCached(storePath: string): boolean {
  if (cacheUrl === undefined) {
    return false;
  }

  const result = runRequired("nix", [
    "path-info",
    "--json",
    "--store",
    cacheUrl,
    storePath,
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Unexpected cache query result for ${storePath}: ${result.stdout}`);
  }

  const [pathInfo] = parsed as CachePathInfo[];
  return pathInfo?.valid === true;
}

function deduplicateBuildEntries(entries: MatrixEntry[]): MatrixEntry[] {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const key = `${entry.system}:${entry.storePath}`;
    if (seen.has(key)) {
      console.log(`${entry.root}.${entry.host}: duplicate store path, skipped from build matrix`);
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildPlan(): PlanOutput {
  const allHosts = getHosts()
    .filter((host) => hostFilters.size === 0 || hostFilters.has(host.hostName))
    .sort((left, right) => `${left.root}.${left.hostName}`.localeCompare(`${right.root}.${right.hostName}`));

  if (allHosts.length === 0) {
    throw new Error(
      hostFilters.size === 0
        ? `No hosts found under ${flakeRef}#${configRoots.join(",")}`
        : `No hosts matched HOSTS=${Array.from(hostFilters).join(",")}`,
    );
  }

  const entries = allHosts.map((host): MatrixEntry => {
    if (!isSupportedSystem(host.hostSystem)) {
      throw new Error(
        `Unsupported host system for ${host.root}.${host.hostName}: ${host.hostSystem}. Supported: ${Object.keys(
          systemDefaults,
        ).join(", ")}`,
      );
    }

    const defaults = systemDefaults[host.hostSystem];
    const cached = isCached(host.storePath);
    const installer = installerFromNixPackage(host.nixPackageName);
    const substituters = filterSubstituters(host.substituters);
    const trustedPublicKeys = unique(host.trustedPublicKeys);

    console.log(
      `${host.root}.${host.hostName}: ${host.hostSystem} ${installer} ${cached ? "cached" : "missing"} ${host.storePath}`,
    );
    console.log(
      `  host cache config: ${substituters.length} substituter(s), ${trustedPublicKeys.length} trusted public key(s)`,
    );

    return {
      host: host.hostName,
      root: host.root,
      system: host.hostSystem,
      runner: runnerOverrides[`${host.root}.${host.hostName}`] ?? runnerOverrides[host.hostName] ?? defaults.runner,
      installer,
      expectedSystem: defaults.currentSystem,
      flakeAttr: flakeAttrForHost(host.root, host.hostName),
      storePath: host.storePath,
      nixPackageName: host.nixPackageName,
      extraSubstituters: substituters.join(" "),
      extraTrustedPublicKeys: trustedPublicKeys.join(" "),
      cached,
    };
  });

  const candidateEntries = buildOnlyMissing
    ? entries.filter((entry) => !entry.cached)
    : entries;
  const buildEntries = deduplicateBuildEntries(candidateEntries);

  return {
    hasMissing: buildEntries.length > 0,
    matrix: { include: buildEntries },
    allHosts: { include: entries },
  };
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    return;
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}

function writeGithubSummary(plan: PlanOutput): void {
  const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.length === 0) {
    return;
  }

  const rows = plan.allHosts.include
    .map(
      (entry) =>
        `| ${entry.root}.${entry.host} | ${entry.system} | ${entry.runner} | ${entry.installer} | ${entry.nixPackageName} | ${entry.extraSubstituters.split(" ").filter(Boolean).length} | ${entry.extraTrustedPublicKeys.split(" ").filter(Boolean).length} | ${entry.cached ? "cached" : "missing"} | ${entry.storePath} |`,
    )
    .join("\n");

  appendFileSync(
    summaryPath,
    [
      "## Host cache plan",
      "",
      `Flake: \`${flakeRef}\``,
      `Roots: \`${configRoots.join(",")}\``,
      `Cache: \`${cacheUrl ?? "none"}\``,
      "",
      "| Host | System | Runner | Installer | nix.package | Substituters | Keys | Cache | Store path |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      rows,
      "",
    ].join("\n"),
  );
}

const plan = buildPlan();
const matrix = JSON.stringify(plan.matrix);
const allHosts = JSON.stringify(plan.allHosts);

writeGithubOutput("has_missing", String(plan.hasMissing));
writeGithubOutput("matrix", matrix);
writeGithubOutput("all_hosts", allHosts);
writeGithubSummary(plan);

console.log(JSON.stringify(plan, null, 2));
