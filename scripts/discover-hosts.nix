{
  flakePath ? "",
  flake ? builtins.getFlake "path:${flakePath}",
  flakeRev ? "",
  hosts ? (import ./lib.nix).hostFilters (builtins.getEnv "HOSTS"),
  systemOverrides ? (import ./lib.nix).stringMap (builtins.getEnv "HOST_SYSTEM_OVERRIDES"),
  runnerOverrides ? (import ./lib.nix).stringMap (builtins.getEnv "HOST_RUNNER_OVERRIDES"),
  runners ? { },
}:
let
  inherit (builtins)
    attrNames
    concatMap
    concatStringsSep
    elem
    filter
    foldl'
    length
    map
    ;
  lib = import ./lib.nix;
  defaultRunners = {
    aarch64-darwin = lib.envOr "AARCH64_DARWIN_RUNNER" "macos-15";
    x86_64-darwin = lib.envOr "X86_64_DARWIN_RUNNER" "macos-15-intel";
    x86_64-linux = lib.envOr "X86_64_LINUX_RUNNER" "ubuntu-24.04";
    aarch64-linux = lib.envOr "AARCH64_LINUX_RUNNER" "ubuntu-24.04-arm";
  }
  // runners;
  matches = entry: name: name == entry.host || name == "${entry.root}.${entry.host}";
  candidates =
    concatMap (root: map (host: { inherit root host; }) (attrNames (flake.${root} or { })))
      [
        "darwinConfigurations"
        "nixosConfigurations"
      ];
  selected = filter (entry: hosts == [ ] || builtins.any (matches entry) hosts) candidates;
  missing = filter (name: !builtins.any (entry: matches entry name) selected) hosts;
  # 让别名和原名共享一次求值；不再为每个配置启动独立 Nix 进程。
  evaluated = map (
    entry:
    let
      inherit (entry) root host;
      key = "${root}.${host}";
      top = flake.${root}.${host}.config.system.build.toplevel;
      expectedSystem = systemOverrides.${key} or (systemOverrides.${host} or top.system);
      runner =
        runnerOverrides.${key} or (runnerOverrides.${host}
          or (defaultRunners.${expectedSystem} or (throw "Unsupported system ${expectedSystem} for ${key}"))
        );
    in
    {
      inherit
        root
        host
        expectedSystem
        runner
        flakeRev
        ;
      inherit (top) drvPath;
    }
  ) selected;
  ordered =
    filter (entry: entry.host != "default") evaluated
    ++ filter (entry: entry.host == "default") evaluated;
  deduplicated =
    foldl'
      (
        acc: entry:
        # attrset 的键不能携带 store 上下文；只清除索引键，保留输出 drvPath 的上下文。
        let
          drvKey = builtins.unsafeDiscardStringContext entry.drvPath;
        in
        if acc.seen ? ${drvKey} then
          acc // { aliases = acc.aliases ++ [ "${entry.root}.${entry.host} → ${acc.seen.${drvKey}}" ]; }
        else
          {
            seen = acc.seen // {
              ${drvKey} = "${entry.root}.${entry.host}";
            };
            include = acc.include ++ [ entry ];
            inherit (acc) aliases;
          }
      )
      {
        seen = { };
        include = [ ];
        aliases = [ ];
      }
      ordered;
  inherit (deduplicated) include aliases;
in
if missing != [ ] then
  throw "No host matched HOSTS entries: ${concatStringsSep "," missing}"
else if selected == [ ] then
  throw "No NixOS or nix-darwin configurations found"
else if length include > 256 then
  throw "Configuration count exceeds GitHub's 256-job matrix limit"
else
  {
    matrix = { inherit include; };
    inherit aliases;
    summary = concatStringsSep "\n" (
      [
        "## Configuration builds"
        ""
        "Revision: `${flakeRev}`"
        ""
        "| Configuration | System | Runner |"
        "| --- | --- | --- |"
      ]
      ++ map (
        entry: "| ${entry.root}.${entry.host} | ${entry.expectedSystem} | ${entry.runner} |"
      ) include
      ++ (
        if aliases == [ ] then
          [ ]
        else
          [
            ""
            "### Deduplicated aliases"
            ""
          ]
          ++ map (alias: "- ${alias}") aliases
      )
    );
  }
