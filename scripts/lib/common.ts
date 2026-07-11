import { appendFileSync } from "node:fs";

const textDecoder = new TextDecoder();

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * 阶段 0 仅从 flake attrset 惰性导出的主机候选项。
 * 不包含完整配置的求值结果，因而可安全运行在非目标平台的 runner 上。
 */
export type HostSeed = {
  host: string;
  root: string;
  runner: string;
  expectedSystem: string;
  flakeAttr: string;
  flakeRev: string;
  matrixKey: string;
};

/** 阶段 1 在目标平台求值配置后补全的主机上下文。 */
export type HostContext = HostSeed & {
  system: string;
  installer: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
};

/** 从主机配置导出的包记录 */
export type PackageRecord = HostContext & {
  packageAttr: string;
  packageName: string;
  packageStorePath: string;
};

/** 去重后的构建矩阵项（包级） */
export type BuildMatrixEntry = HostContext & {
  packageAttr: string;
  packageAttrJson: string;
  packageName: string;
  packageStorePath: string;
};

export type MatrixOutput<T> = {
  include: T[];
};

export function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`);
  }

  return parsed;
}

export function normalizeFlakeRef(ref: string): string {
  // 将本地路径统一规范化为 `path:` 输入，避免 Nix/Lix 在 macOS 上将目录识别为
  // `git+file:` 输入时因 shallow git 仓库或 git 子进程问题触发 `Broken pipe`。
  const trimmed = ref.trim();
  if (
    trimmed.startsWith("path:") ||
    trimmed.startsWith("git+file:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("gitlab:") ||
    trimmed.startsWith("sourcehut:") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git+")
  ) {
    return trimmed;
  }
  return `path:${trimmed}`;
}

export function toFilesystemPath(ref: string): string {
  return ref.startsWith("path:") ? ref.slice("path:".length) : ref;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unique(items: readonly string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.length > 0)));
}

export function run(command: string, args: readonly string[]): CommandResult {
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

export function runRequired(
  command: string,
  args: readonly string[],
): CommandResult {
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

export function writeGithubOutput(name: string, value: string): void {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    return;
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}

export function writeGithubSummary(lines: readonly string[]): void {
  const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.length === 0) {
    return;
  }

  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

export function isHostSeed(value: unknown): value is HostSeed {
  return (
    isRecord(value) &&
    typeof value.host === "string" &&
    typeof value.root === "string" &&
    typeof value.runner === "string" &&
    typeof value.expectedSystem === "string" &&
    typeof value.flakeAttr === "string" &&
    typeof value.flakeRev === "string" &&
    typeof value.matrixKey === "string"
  );
}

export function isHostContext(value: unknown): value is HostContext {
  if (!isHostSeed(value)) {
    return false;
  }

  const context = value as HostContext;
  return (
    typeof context.system === "string" &&
    typeof context.installer === "string" &&
    typeof context.nixPackageName === "string" &&
    typeof context.extraSubstituters === "string" &&
    typeof context.extraTrustedPublicKeys === "string"
  );
}

export function isPackageRecord(value: unknown): value is PackageRecord {
  return (
    isHostContext(value) &&
    isRecord(value) &&
    typeof (value as { packageAttr?: unknown }).packageAttr === "string" &&
    typeof (value as { packageName?: unknown }).packageName === "string" &&
    typeof (value as { packageStorePath?: unknown }).packageStorePath ===
      "string"
  );
}

export function parseHostSeedJson(raw: string): HostSeed {
  const parsed: unknown = JSON.parse(raw);
  if (!isHostSeed(parsed)) {
    throw new Error(`Invalid HostSeed JSON: ${raw}`);
  }

  return parsed;
}

export function parseHostContextJson(raw: string): HostContext {
  const parsed: unknown = JSON.parse(raw);
  if (!isHostContext(parsed)) {
    throw new Error(`Invalid HostContext JSON: ${raw}`);
  }

  return parsed;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        results[index] = await mapper(items[index] as T, index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
