import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

export type HostSeed = {
  host: string;
  root: string;
  runner: string;
  expectedSystem: string;
  flakeAttr: string;
  flakeRev: string;
};

export function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

export function normalizeFlakeRef(ref: string): string {
  // 使用绝对 path: 输入，避免 macOS 上浅克隆的 git+file: 问题。
  return `path:${resolve(toFilesystemPath(ref))}`;
}

export function toFilesystemPath(ref: string): string {
  return ref.startsWith("path:") ? ref.slice(5) : ref;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runRequired(command: string, args: readonly string[]): string {
  const result = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command} ${args.join(" ")}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function writeGithubOutput(name: string, value: string): void {
  if (/[\r\n]/.test(value))
    throw new Error(`Multiline output is not supported: ${name}`);
  if (Bun.env.GITHUB_OUTPUT)
    appendFileSync(Bun.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function writeGithubSummary(lines: readonly string[]): void {
  if (Bun.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(Bun.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

export function parseStringMap(
  value: string | undefined,
): Record<string, string> {
  if (!value?.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed))
    throw new Error("Host overrides must be a JSON object");
  const entries = Object.entries(parsed).map(
    ([key, entry]): [string, string] => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error(`Host override ${key} must be a non-empty string`);
      }
      return [key, entry];
    },
  );
  return Object.fromEntries(entries);
}

export function parseHostSeedJson(raw: string): HostSeed {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    typeof value.host !== "string" ||
    typeof value.root !== "string" ||
    typeof value.runner !== "string" ||
    typeof value.expectedSystem !== "string" ||
    typeof value.flakeAttr !== "string" ||
    typeof value.flakeRev !== "string"
  )
    throw new Error("Invalid HostSeed JSON");
  return {
    host: value.host,
    root: value.root,
    runner: value.runner,
    expectedSystem: value.expectedSystem,
    flakeAttr: value.flakeAttr,
    flakeRev: value.flakeRev,
  };
}

export function nixString(value: string): string {
  return JSON.stringify(value).replaceAll("${", "\\${");
}

export function toplevelAttr(root: string, host: string): string {
  if (root !== "nixosConfigurations" && root !== "darwinConfigurations") {
    throw new Error(`Unsupported configuration root: ${root}`);
  }
  return `${root}.${nixString(host)}.config.system.build.toplevel`;
}
