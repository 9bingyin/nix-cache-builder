#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

const textDecoder = new TextDecoder();

const flakeRef = Bun.env.FLAKE_REF ?? "./flake-config";
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

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type HostInfo = {
  root: string;
  hostName: string;
  canonicalHostName: string;
  hostSystem: string;
  nixPackageName: string;
  substituters: string[];
  trustedPublicKeys: string[];
};

type MatrixEntry = {
  host: string;
  root: string;
  system: SupportedSystem;
  runner: string;
  installer: Installer;
  expectedSystem: string;
  flakeAttr: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
  matrixKey: string;
};

type MatrixOutput = {
  include: MatrixEntry[];
};

type PlanOutput = {
  hasHosts: boolean;
  flakeRev: string;
  matrix: MatrixOutput;
  allHosts: MatrixOutput;
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

function nixAttrSegment(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : JSON.stringify(name);
}

function flakeAttrForHost(root: string, host: string): string {
  return `${root}.${nixAttrSegment(host)}`;
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

function matrixKeyForHost(root: string, host: string): string {
  return `${root}-${host}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function getFlakeRev(): string {
  return runRequired("git", [
    "-C",
    flakeRef,
    "rev-parse",
    "HEAD",
  ]).stdout.trim();
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
      typeof (value as HostInfo).hostName !== "string" ||
      typeof (value as HostInfo).canonicalHostName !== "string" ||
      typeof (value as HostInfo).hostSystem !== "string" ||
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

function deduplicateHostAliases(hosts: readonly HostInfo[]): HostInfo[] {
  const byCanonicalName = new Map<string, HostInfo>();

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
        `${existing.root}.${existing.hostName}: alias of ${existing.canonicalHostName}, skipped from host matrix`,
      );
      byCanonicalName.set(key, host);
      continue;
    }

    console.log(
      `${host.root}.${host.hostName}: alias of ${host.canonicalHostName}, skipped from host matrix`,
    );
  }

  return Array.from(byCanonicalName.values());
}

function buildPlan(): PlanOutput {
  const allHosts = deduplicateHostAliases(
    getHosts().filter(
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

  const entries = allHosts.map((host): MatrixEntry => {
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
    console.log(
      `  host cache config: ${substituters.length} substituter(s), ${trustedPublicKeys.length} trusted public key(s)`,
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

  return {
    hasHosts: entries.length > 0,
    flakeRev: getFlakeRev(),
    matrix: { include: entries },
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
        `| ${entry.root}.${entry.host} | ${entry.system} | ${entry.runner} | ${entry.installer} | ${entry.nixPackageName} | ${entry.extraSubstituters.split(" ").filter(Boolean).length} | ${entry.extraTrustedPublicKeys.split(" ").filter(Boolean).length} |`,
    )
    .join("\n");

  appendFileSync(
    summaryPath,
    [
      "## Host package cache plan",
      "",
      `Flake: \`${flakeRef}\``,
      `Flake revision: \`${plan.flakeRev}\``,
      `Roots: \`${configRoots.join(",")}\``,
      "",
      "| Host | System | Runner | Installer | nix.package | Substituters | Keys |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      rows,
      "",
    ].join("\n"),
  );
}

const plan = buildPlan();
const matrix = JSON.stringify(plan.matrix);
const allHosts = JSON.stringify(plan.allHosts);

writeGithubOutput("has_hosts", String(plan.hasHosts));
writeGithubOutput("flake_rev", plan.flakeRev);
writeGithubOutput("matrix", matrix);
writeGithubOutput("all_hosts", allHosts);
writeGithubSummary(plan);

console.log(JSON.stringify(plan, null, 2));
