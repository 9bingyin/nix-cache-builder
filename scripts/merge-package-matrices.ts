#!/usr/bin/env bun

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const matrixDir = Bun.env.PACKAGE_MATRIX_DIR ?? "package-matrices";

type MatrixEntry = {
  host: string;
  root: string;
  system: string;
  runner: string;
  installer: string;
  expectedSystem: string;
  flakeAttr: string;
  nixPackageName: string;
  extraSubstituters: string;
  extraTrustedPublicKeys: string;
  matrixKey: string;
  packageAttr: string;
  packageAttrJson: string;
  packageStorePath: string;
};

type MatrixOutput = {
  include: MatrixEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMatrixEntry(value: unknown): value is MatrixEntry {
  return (
    isRecord(value) &&
    typeof value.host === "string" &&
    typeof value.root === "string" &&
    typeof value.system === "string" &&
    typeof value.runner === "string" &&
    typeof value.installer === "string" &&
    typeof value.expectedSystem === "string" &&
    typeof value.flakeAttr === "string" &&
    typeof value.nixPackageName === "string" &&
    typeof value.extraSubstituters === "string" &&
    typeof value.extraTrustedPublicKeys === "string" &&
    typeof value.matrixKey === "string" &&
    typeof value.packageAttr === "string" &&
    typeof value.packageAttrJson === "string" &&
    typeof value.packageStorePath === "string"
  );
}

function listJsonFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      return listJsonFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
  });
}

function readMatrix(path: string): MatrixOutput {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.include)) {
    throw new Error(`Unexpected matrix file: ${path}`);
  }

  if (!parsed.include.every(isMatrixEntry)) {
    throw new Error(`Unexpected matrix entry in ${path}`);
  }

  return { include: parsed.include };
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    return;
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}

const matrix: MatrixOutput = {
  include: listJsonFiles(matrixDir).flatMap((path) => readMatrix(path).include),
};

matrix.include.sort((left, right) =>
  `${left.root}.${left.host}.${left.packageAttr}`.localeCompare(
    `${right.root}.${right.host}.${right.packageAttr}`,
  ),
);

writeGithubOutput("has_missing", String(matrix.include.length > 0));
writeGithubOutput("matrix", JSON.stringify(matrix));
console.log(JSON.stringify(matrix, null, 2));
