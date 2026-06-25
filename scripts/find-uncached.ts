#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type MatrixEntry = {
  name: string;
  attr: string;
};

type MatrixOutput = {
  include: MatrixEntry[];
};

type PlanResult = {
  hasMissing: boolean;
  matrix: MatrixOutput;
};

const textDecoder = new TextDecoder();
const ciNixPath = Bun.env.CI_NIX_PATH ?? "ci.nix";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
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

function parseMissingDerivations(output: string): string[] {
  const derivations: string[] = [];
  let readingBuildSection = false;

  for (const line of output.split(/\r?\n/)) {
    if (
      readingBuildSection &&
      (line.includes("will be fetched") ||
        line.startsWith("don't know how to build these paths"))
    ) {
      break;
    }

    if (line.includes("will be built:")) {
      readingBuildSection = true;
      continue;
    }

    if (!readingBuildSection) {
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("/nix/store/") && trimmed.endsWith(".drv")) {
      derivations.push(trimmed);
    }
  }

  return derivations;
}

function getCiAttributes(): string[] {
  const result = runRequired("nix", [
    "eval",
    "--json",
    "--file",
    ciNixPath,
    "--apply",
    "builtins.attrNames",
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (!isStringArray(parsed)) {
    throw new Error(`Unexpected ci.nix attribute list: ${result.stdout}`);
  }

  return parsed;
}

function dryRunAttribute(attr: string): string[] {
  const result = runRequired("nix-build", [
    "--dry-run",
    "--pure",
    "--no-out-link",
    ciNixPath,
    "-A",
    attr,
  ]);

  return parseMissingDerivations(`${result.stdout}\n${result.stderr}`);
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    return;
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}

function writeGithubSummary(markdown: string): void {
  const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.length === 0) {
    return;
  }

  appendFileSync(summaryPath, markdown);
}

function buildPlan(): PlanResult {
  const attrs = getCiAttributes();
  const missing: MatrixEntry[] = [];

  for (const attr of attrs) {
    console.log(`Checking ${attr}`);
    const missingDerivations = dryRunAttribute(attr);

    if (missingDerivations.length === 0) {
      console.log("  cached");
      continue;
    }

    console.log(`  uncached: ${missingDerivations.length} derivation(s)`);
    missing.push({ name: attr, attr });
  }

  return {
    hasMissing: missing.length > 0,
    matrix: { include: missing },
  };
}

const plan = buildPlan();

writeGithubOutput("matrix", JSON.stringify(plan.matrix));
writeGithubOutput("has_missing", String(plan.hasMissing));

writeGithubSummary(
  `## Darwin Cachix plan\n\n${
    plan.hasMissing
      ? plan.matrix.include.map((entry) => `- ${entry.name}`).join("\n")
      : "All ci.nix entries are cached."
  }\n`,
);

console.log(JSON.stringify(plan, null, 2));
