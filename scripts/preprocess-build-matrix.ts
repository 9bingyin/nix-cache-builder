#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

const textDecoder = new TextDecoder();

const flakeRef = Bun.env.FLAKE_REF ?? "./flake-config";
const flakeAttrRoot = Bun.env.FLAKE_ATTR_ROOT ?? "darwinConfigurations";
const cachixName = Bun.env.CACHIX_NAME;
const cacheUrl =
  Bun.env.NIX_BINARY_CACHE_URL ??
  (cachixName === undefined || cachixName.length === 0
    ? undefined
    : `https://${cachixName}.cachix.org`);
const buildOnlyMissing = (Bun.env.BUILD_ONLY_MISSING ?? "true") !== "false";

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
    lixSystem: "aarch64-darwin",
  },
  "x86_64-darwin": {
    runner: Bun.env.X86_64_DARWIN_RUNNER ?? "macos-15-intel",
    lixSystem: "x86_64-darwin",
  },
} as const;

type SupportedSystem = keyof typeof systemDefaults;

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type HostInfo = {
  hostName: string;
  hostSystem: string;
  storePath: string;
};

type CachePathInfo = {
  path: string;
  valid?: boolean;
};

type MatrixEntry = {
  host: string;
  system: SupportedSystem;
  runner: string;
  lixSystem: string;
  flakeAttr: string;
  storePath: string;
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

function flakeAttrForHost(host: string): string {
  return `${flakeAttrRoot}.${nixAttrSegment(host)}.system`;
}

function getHosts(): HostInfo[] {
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
      throw "Cannot infer darwin configuration system";
in
configs: builtins.mapAttrs (hostName: cfg: {
  hostName = hostName;
  hostSystem = getSystem cfg;
  storePath = cfg.system.outPath;
}) configs
`;

  const result = runRequired("nix", [
    "eval",
    "--json",
    `${flakeRef}#${flakeAttrRoot}`,
    "--apply",
    expression,
  ]);

  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unexpected ${flakeAttrRoot} evaluation result: ${result.stdout}`);
  }

  return Object.values(parsed).map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as HostInfo).hostName !== "string" ||
      typeof (value as HostInfo).hostSystem !== "string" ||
      typeof (value as HostInfo).storePath !== "string"
    ) {
      throw new Error(`Unexpected host metadata: ${JSON.stringify(value)}`);
    }

    return value as HostInfo;
  });
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
      console.log(`${entry.host}: duplicate store path, skipped from build matrix`);
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildPlan(): PlanOutput {
  const allHosts = getHosts()
    .filter((host) => hostFilters.size === 0 || hostFilters.has(host.hostName))
    .sort((left, right) => left.hostName.localeCompare(right.hostName));

  if (allHosts.length === 0) {
    throw new Error(
      hostFilters.size === 0
        ? `No hosts found under ${flakeRef}#${flakeAttrRoot}`
        : `No hosts matched HOSTS=${Array.from(hostFilters).join(",")}`,
    );
  }

  const entries = allHosts.map((host): MatrixEntry => {
    if (!isSupportedSystem(host.hostSystem)) {
      throw new Error(
        `Unsupported host system for ${host.hostName}: ${host.hostSystem}. Supported: ${Object.keys(
          systemDefaults,
        ).join(", ")}`,
      );
    }

    const defaults = systemDefaults[host.hostSystem];
    const cached = isCached(host.storePath);

    console.log(
      `${host.hostName}: ${host.hostSystem} ${cached ? "cached" : "missing"} ${host.storePath}`,
    );

    return {
      host: host.hostName,
      system: host.hostSystem,
      runner: runnerOverrides[host.hostName] ?? defaults.runner,
      lixSystem: defaults.lixSystem,
      flakeAttr: flakeAttrForHost(host.hostName),
      storePath: host.storePath,
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
        `| ${entry.host} | ${entry.system} | ${entry.runner} | ${entry.cached ? "cached" : "missing"} | ${entry.storePath} |`,
    )
    .join("\n");

  appendFileSync(
    summaryPath,
    [
      "## Darwin host cache plan",
      "",
      `Flake: \`${flakeRef}#${flakeAttrRoot}\``,
      `Cache: \`${cacheUrl ?? "none"}\``,
      "",
      "| Host | System | Runner | Cache | Store path |",
      "| --- | --- | --- | --- | --- |",
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
