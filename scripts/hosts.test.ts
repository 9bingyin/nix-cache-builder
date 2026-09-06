import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nixString, parseStringMap, toplevelAttr } from "./lib/common.ts";

const directory = mkdtempSync(join(tmpdir(), "host-build-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("configuration attributes quote names and reject unsupported roots", () => {
  expect(toplevelAttr("darwinConfigurations", "my.mac")).toBe(
    'darwinConfigurations."my.mac".config.system.build.toplevel',
  );
  expect(nixString('${throw "oops"}')).toBe('"\\${throw \\"oops\\"}"');
  expect(() => toplevelAttr("packages", "default")).toThrow("Unsupported");
});

test("override maps require non-empty string values", () => {
  expect(parseStringMap("")).toEqual({});
  expect(parseStringMap('{"Mac":"macos-15"}')).toEqual({ Mac: "macos-15" });
  for (const value of ["[]", "null", '{"Mac":1}', '{"Mac":""}']) {
    expect(() => parseStringMap(value)).toThrow();
  }
});

function command(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync(args, {
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("cache uploader passes toplevel paths, removes token script, and propagates failure", () => {
  const home = join(directory, "cache-home");
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "push.json");
  writeFileSync(join(bin, "nix"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "niks3"),
    `#!${process.execPath}\nawait Bun.write(Bun.env.PUSH_LOG, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(Bun.env.PUSH_EXIT ?? 0));\n`,
    { mode: 0o755 },
  );
  const env = {
    HOME: home,
    PATH: `${bin}:${Bun.env.PATH}`,
    RUNNER_TEMP: home,
    NIKS3_SERVER: "https://cache.example.org",
    PUSH_LOG: log,
  };
  writeFileSync(join(home, "host-paths"), "/nix/store/test-system\n");
  const result = command(["bash", resolve("scripts/cache-host.sh")], env);
  expect(result.exitCode).toBe(0);
  const args: string[] = JSON.parse(readFileSync(log, "utf8"));
  expect(args.slice(0, 4)).toEqual([
    "push",
    "--server-url",
    env.NIKS3_SERVER,
    "--auth-token-script",
  ]);
  expect(args.at(-1)).toBe("/nix/store/test-system");
  expect(existsSync(args[4] ?? "")).toBe(false);
  expect(
    command(["bash", resolve("scripts/cache-host.sh")], {
      ...env,
      PUSH_EXIT: "7",
    }).exitCode,
  ).toBe(7);
  rmSync(log);
  for (const content of ["", "/tmp/not-a-store-path\n"]) {
    writeFileSync(join(home, "host-paths"), content);
    expect(
      command(["bash", resolve("scripts/cache-host.sh")], env).exitCode,
    ).not.toBe(0);
    expect(existsSync(log)).toBe(false);
  }
});

const nixAvailable = Bun.which("nix") !== null;
describe.skipIf(!nixAvailable)("Nix configuration discovery", () => {
  const fixture = join(directory, "flake");
  const init = command(["git", "init", fixture]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  writeFileSync(
    join(fixture, "flake.nix"),
    `{
    outputs = { self }: {
      darwinConfigurations = {
        default = {
          pkgs.stdenv.hostPlatform.system = "aarch64-darwin";
          config.system.build.toplevel = { system = "aarch64-darwin"; drvPath = "/nix/store/default.drv"; };
        };
        "intel.mac".config.system.build.toplevel = { system = "x86_64-darwin"; drvPath = "/nix/store/intel.drv"; };
      };
      nixosConfigurations.native = {
        pkgs.stdenv.hostPlatform.system = builtins.currentSystem;
        config = {
          system.build.toplevel = { system = builtins.currentSystem; drvPath = "/nix/store/native.drv"; };
          nix.settings = {
            substituters = [ "https://cache.example.org" "https://mirrors.ustc.edu.cn/nix-channels/store" ];
            extra-substituters = [ "https://cache.example.org" ];
            trusted-public-keys = [ "example:key" ];
          };
        };
      };
    };
  }`,
  );
  command(["git", "-C", fixture, "add", "flake.nix"]);
  const commit = command([
    "git",
    "-C",
    fixture,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.org",
    "commit",
    "-m",
    "fixture",
  ]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());

  let invocation = 0;
  function runScript(script: string, env: Record<string, string> = {}) {
    const output = join(directory, `output-${invocation++}`);
    writeFileSync(output, "");
    const result = command([process.execPath, resolve("scripts", script)], {
      FLAKE_REF: fixture,
      HOSTS: "",
      HOST_SYSTEM_OVERRIDES: "",
      HOST_RUNNER_OVERRIDES: "",
      AARCH64_DARWIN_RUNNER: "",
      X86_64_DARWIN_RUNNER: "",
      X86_64_LINUX_RUNNER: "",
      AARCH64_LINUX_RUNNER: "",
      NIX_CONFIG: "experimental-features = nix-command flakes\n",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: "",
      ...env,
    });
    return {
      ...result,
      outputs: Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      ),
    };
  }

  test("discovers toplevel platforms and keeps a distinct default host", () => {
    const result = runScript("discover-hosts.ts");
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const matrix = JSON.parse(result.outputs.matrix ?? "{}");
    expect(matrix.include).toHaveLength(3);
    expect(matrix.include[2]).toMatchObject({
      host: "default",
      runner: "macos-15",
    });
    expect(matrix.include[0]).toMatchObject({
      host: "intel.mac",
      runner: "macos-15-intel",
    });
    expect(matrix.include[0].flakeRev).toMatch(/^[a-f0-9]{40}$/);
  });

  test("filters qualified hosts and rejects unmatched entries", () => {
    const result = runScript("discover-hosts.ts", {
      HOSTS: "darwinConfigurations.intel.mac",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.outputs.matrix ?? "{}").include).toHaveLength(1);
    expect(
      runScript("discover-hosts.ts", { HOSTS: "default,missing" }).exitCode,
    ).not.toBe(0);
  });

  test("prepares native toplevel and cache settings; rejects platform mismatch", () => {
    const discovery = runScript("discover-hosts.ts", { HOSTS: "native" });
    expect(discovery.exitCode).toBe(0);
    const host = JSON.parse(discovery.outputs.matrix ?? "{}").include[0];
    const result = runScript("prepare-host.ts", {
      HOST_JSON: JSON.stringify(host),
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.outputs.extra_substituters).toBe("https://cache.example.org");
    expect(result.outputs.extra_trusted_public_keys).toBe("example:key");
    expect(result.outputs.installable).toEndWith(
      '#nixosConfigurations."native".config.system.build.toplevel',
    );
    expect(
      runScript("prepare-host.ts", {
        HOST_JSON: JSON.stringify({ ...host, expectedSystem: "wrong" }),
      }).exitCode,
    ).not.toBe(0);
  });

  test("deduplicates by derivation after filtering, preferring non-default names", () => {
    writeFileSync(
      join(fixture, "flake.nix"),
      `{
      outputs = { self }: {
        darwinConfigurations = rec {
          workstation.config = {
            networking.hostName = "same-name";
            system.build.toplevel = { system = "aarch64-darwin"; drvPath = "/nix/store/shared.drv"; };
          };
          default = workstation;
          z-alias = workstation;
          distinct.config = {
            networking.hostName = "same-name";
            system.build.toplevel = { system = "aarch64-darwin"; drvPath = "/nix/store/distinct.drv"; };
          };
        };
      };
    }`,
    );
    const result = runScript("discover-hosts.ts");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.outputs.matrix ?? "{}").include).toMatchObject([
      { host: "distinct" },
      { host: "workstation" },
    ]);
    expect(result.stderr.toString()).toContain(
      "darwinConfigurations.default → darwinConfigurations.workstation",
    );
    expect(result.stderr.toString()).toContain(
      "darwinConfigurations.z-alias → darwinConfigurations.workstation",
    );
    for (const filters of ["default", "default,workstation,z-alias"]) {
      const selected = runScript("discover-hosts.ts", { HOSTS: filters });
      expect(selected.exitCode).toBe(0);
      expect(JSON.parse(selected.outputs.matrix ?? "{}").include).toMatchObject(
        [{ host: filters === "default" ? "default" : "workstation" }],
      );
    }
  });

  test("reads Determinate caches without forcing disabled nix.settings", () => {
    writeFileSync(
      join(fixture, "flake.nix"),
      `{
      outputs = { self }: {
        darwinConfigurations.managed = {
          pkgs.stdenv.hostPlatform.system = builtins.currentSystem;
          config = {
            system.build.toplevel = { system = builtins.currentSystem; drvPath = "/nix/store/managed.drv"; };
            nix.enable = false;
            nix.settings = throw "nix.settings accessed when nix.enable is off";
            determinateNix = {
              enable = true;
              customSettings = {
                extra-substituters = [ "https://cache.example.org?priority=41" ];
                extra-trusted-public-keys = [ "example:key" ];
              };
            };
          };
        };
      };
    }`,
    );
    const discovery = runScript("discover-hosts.ts");
    expect(discovery.exitCode).toBe(0);
    const host = JSON.parse(discovery.outputs.matrix ?? "{}").include[0];
    const result = runScript("prepare-host.ts", {
      HOST_JSON: JSON.stringify(host),
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.extra_substituters).toBe(
      "https://cache.example.org?priority=41",
    );
    expect(result.outputs.extra_trusted_public_keys).toBe("example:key");
  });

  test("allows a flake with only one configuration root", () => {
    writeFileSync(
      join(fixture, "flake.nix"),
      `{
      outputs = { self }: {
        nixosConfigurations.only.config.system.build.toplevel = { system = "aarch64-linux"; drvPath = "/nix/store/only.drv"; };
      };
    }`,
    );
    const result = runScript("discover-hosts.ts");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.outputs.matrix ?? "{}").include).toMatchObject([
      { host: "only", runner: "ubuntu-24.04-arm" },
    ]);
  });
});
