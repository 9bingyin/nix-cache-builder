#!/usr/bin/env nix
/*
#!nix shell github:NixOS/nixpkgs/nixos-unstable#bun --command bun
*/

import {
  isRecord,
  nixString,
  normalizeFlakeRef,
  parseHostSeedJson,
  requireEnv,
  runRequired,
  toplevelAttr,
  writeGithubOutput,
} from "./lib/common.ts";

const host = parseHostSeedJson(requireEnv("HOST_JSON"));
const flakeRef = normalizeFlakeRef(requireEnv("FLAKE_REF"));
const attr = toplevelAttr(host.root, host.host);
const metadata: unknown = JSON.parse(
  runRequired("nix", [
    "eval",
    "--impure",
    "--json",
    "--expr",
    `let
    host = (builtins.getFlake ${nixString(flakeRef)}).${host.root}.${nixString(host.host)};
    # nix-darwin 禁用 Nix 管理时，读取 nix.settings 会抛错，不能只用 or {}。
    settings =
      if host.config.determinateNix.enable or false then
        host.config.determinateNix.customSettings or {}
      else if host.config.nix.enable or true then
        host.config.nix.settings or {}
      else
        {};
  in {
    system = host.config.system.build.toplevel.system;
    substituters = (settings.substituters or []) ++ (settings.extra-substituters or []);
    trustedPublicKeys = (settings.trusted-public-keys or []) ++ (settings.extra-trusted-public-keys or []);
  }`,
  ]),
);

function stringList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("Expected a list of cache settings");
  }
  return [...new Set(value)];
}

if (!isRecord(metadata)) {
  throw new Error("Invalid host metadata");
}
const runnerSystem = runRequired("nix", [
  "eval",
  "--impure",
  "--raw",
  "--expr",
  "builtins.currentSystem",
]);
if (
  metadata.system !== host.expectedSystem ||
  metadata.system !== runnerSystem
) {
  throw new Error(
    `Platform mismatch: configuration=${metadata.system}, expected=${host.expectedSystem}, runner=${runnerSystem}. Check HOST_SYSTEM_OVERRIDES and HOST_RUNNER_OVERRIDES.`,
  );
}
const substituters = stringList(metadata.substituters).filter((substituter) => {
  // 保留原有策略：不使用教育网镜像。
  try {
    const { hostname } = new URL(substituter);
    return hostname !== "edu.cn" && !hostname.endsWith(".edu.cn");
  } catch {
    // Nix 也接受本地 store 路径；交给 Nix 校验。
    return true;
  }
});
writeGithubOutput("extra_substituters", substituters.join(" "));
writeGithubOutput(
  "extra_trusted_public_keys",
  stringList(metadata.trustedPublicKeys).join(" "),
);
writeGithubOutput("installable", `${flakeRef}#${attr}`);
