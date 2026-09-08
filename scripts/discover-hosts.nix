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
    filter
    length
    map
    ;
  lib = import ./lib.nix;
  defaultSystems = {
    darwinConfigurations = "aarch64-darwin";
    nixosConfigurations = "x86_64-linux";
  };
  defaultRunners = {
    aarch64-darwin = lib.envOr "AARCH64_DARWIN_RUNNER" "macos-15";
    x86_64-darwin = lib.envOr "X86_64_DARWIN_RUNNER" "macos-15-intel";
    x86_64-linux = lib.envOr "X86_64_LINUX_RUNNER" "ubuntu-24.04";
    aarch64-linux = lib.envOr "AARCH64_LINUX_RUNNER" "ubuntu-24.04-arm";
  }
  // runners;
  matches = entry: name: name == entry.host || name == "${entry.root}.${entry.host}";
  candidates =
    concatMap
      (
        root:
        map (
          host:
          let
            key = "${root}.${host}";
          in
          {
            inherit root host;
            expectedSystem = systemOverrides.${key} or (systemOverrides.${host} or defaultSystems.${root});
          }
        ) (attrNames (flake.${root} or { }))
      )
      [
        "darwinConfigurations"
        "nixosConfigurations"
      ];
  selected = filter (entry: hosts == [ ] || builtins.any (matches entry) hosts) candidates;
  missing = filter (name: !builtins.any (entry: matches entry name) selected) hosts;
  include = map (
    entry:
    let
      key = "${entry.root}.${entry.host}";
      runner =
        runnerOverrides.${key} or (runnerOverrides.${entry.host} or (defaultRunners.${entry.expectedSystem}
          or (throw "Unsupported system ${entry.expectedSystem} for ${key}")
        )
        );
    in
    entry
    // {
      inherit runner flakeRev;
    }
  ) selected;
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
    summary = concatStringsSep "\n" (
      [
        "## Configuration builds"
        ""
        "Revision: `${flakeRev}`"
        ""
        "Discovery only reads configuration names. Each toplevel is evaluated on its target runner."
        "Routing defaults to aarch64-darwin for Darwin and x86_64-linux for NixOS; use HOST_SYSTEM_OVERRIDES for exceptions."
        ""
        "| Configuration | System | Runner |"
        "| --- | --- | --- |"
      ]
      ++ map (
        entry: "| ${entry.root}.${entry.host} | ${entry.expectedSystem} | ${entry.runner} |"
      ) include
    );
  }
