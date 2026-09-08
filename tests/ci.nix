let
  discover = import ../scripts/discover-hosts.nix;
  plan = import ../scripts/plan-hosts.nix;
  prepare = import ../scripts/prepare-host.nix;
  lib = import ../scripts/lib.nix;
  system = "aarch64-darwin";
  mkHost = drvPath: {
    config = {
      networking.hostName = "same-hostname";
      system.build.toplevel = { inherit system drvPath; };
      nix.settings = {
        substituters = [
          "https://cache.numtide.com"
          "https://cache.numtide.com?priority=99"
          "https://cache.numtide.com?trusted=1&priority=1"
          "https://cache.example.org"
          "https://mirrors.ustc.edu.cn/nix-channels/store"
        ];
        extra-substituters = [ "https://cache.example.org" ];
        trusted-public-keys = [ "example:key" ];
        extra-trusted-public-keys = [ "example:key" ];
      };
    };
  };
  flake = {
    darwinConfigurations = rec {
      workstation = mkHost "/nix/store/shared.drv";
      default = workstation;
      z-alias = workstation;
      distinct = mkHost "/nix/store/distinct.drv";
      "odd.\"name\${value}" = mkHost "/nix/store/quoted.drv";
    };
    nixosConfigurations.linux.config.system.build.toplevel = {
      system = "x86_64-linux";
      drvPath = "/nix/store/linux.drv";
    };
  };
  args = {
    inherit flake;
    flakeRev = "revision";
    hosts = [ ];
    systemOverrides = { };
    runnerOverrides = { };
  };
  result = discover args;
  evaluated = map (
    host:
    host
    // {
      drvPath = flake.${host.root}.${host.host}.config.system.build.toplevel.drvPath;
    }
  ) result.matrix.include;
  planned = plan { hosts = evaluated; };
  selected = discover (args // { hosts = [ "workstation" ]; });
  host = builtins.head selected.matrix.include;
  prepared = prepare {
    inherit flake host;
    currentSystem = system;
  };
  findHost =
    root: name:
    builtins.head (
      builtins.filter (entry: entry.root == root && entry.host == name) result.matrix.include
    );
  fails = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
  tests = {
    filters =
      lib.hostFilters " workstation, darwinConfigurations.default, ,linux " == [
        "workstation"
        "darwinConfigurations.default"
        "linux"
      ];
    discoversAllConfigurationNames = builtins.length result.matrix.include == 6;
    uniqueArtifactIds =
      builtins.length (
        builtins.attrNames (
          builtins.listToAttrs (
            map (host: {
              name = host.artifactId;
              value = true;
            }) result.matrix.include
          )
        )
      ) == builtins.length result.matrix.include;
    shallowDiscovery =
      let
        lazy = discover (
          args
          // {
            flake = {
              darwinConfigurations.unforced = throw "Configuration was forced during discovery";
            };
          }
        );
      in
      builtins.deepSeq lazy ((builtins.head lazy.matrix.include).host == "unforced");
    deduplicatesEvaluatedDerivations = builtins.length planned.matrix.include == 4;
    defaultAlias = builtins.elem "darwinConfigurations.default → darwinConfigurations.workstation" planned.aliases;
    arbitraryAlias = builtins.elem "darwinConfigurations.z-alias → darwinConfigurations.workstation" planned.aliases;
    defaultDarwinSystem =
      (findHost "darwinConfigurations" "workstation").expectedSystem == "aarch64-darwin";
    defaultLinuxSystem = (findHost "nixosConfigurations" "linux").expectedSystem == "x86_64-linux";
    explicitDefault =
      (builtins.head (discover (args // { hosts = [ "default" ]; })).matrix.include).host == "default";
    qualifiedSelection =
      let
        discovered = discover (
          args
          // {
            hosts = [
              "darwinConfigurations.workstation"
              "default"
            ];
          }
        );
        entries = map (
          entry:
          entry // { drvPath = flake.${entry.root}.${entry.host}.config.system.build.toplevel.drvPath; }
        ) discovered.matrix.include;
      in
      builtins.length (plan { hosts = entries; }).matrix.include == 1;
    missingFilter = fails (
      discover (
        args
        // {
          hosts = [
            "workstation"
            "missing"
          ];
        }
      )
    );
    emptyFlake = fails (discover (args // { flake = { }; }));
    onlyOneRoot =
      builtins.length
        (discover (args // { flake = { inherit (flake) nixosConfigurations; }; })).matrix.include == 1;
    runnerOverrides =
      (builtins.head
        (discover (
          args
          // {
            hosts = [ "workstation" ];
            runnerOverrides.workstation = "custom";
          }
        )).matrix.include
      ).runner == "custom";
    unknownSystem = fails (
      discover (
        args
        // {
          hosts = [ "workstation" ];
          systemOverrides.workstation = "unknown";
        }
      )
    );
    emptyPlan = fails (plan {
      hosts = [ ];
    });
    invalidPlan = fails (plan {
      hosts = [ { root = "packages"; } ];
    });
    invalidOverrideMap = fails (lib.stringMap ''{"host":1}'');
    invalidRoot = fails (prepare {
      inherit flake;
      host = host // {
        root = "packages";
      };
      currentSystem = system;
    });
    wrongPlatform = fails (prepare {
      inherit flake host;
      currentSystem = "x86_64-linux";
    });
    changedDerivation = fails (prepare {
      inherit flake;
      host = host // {
        drvPath = "/nix/store/changed.drv";
      };
      currentSystem = system;
    });
    evaluatesDerivationOnTargetRunner = prepared.drvPath == "/nix/store/shared.drv";
    cachePriorityAndFiltering =
      prepared.extraSubstituters
      == "https://cache.numtide.com?priority=41 https://cache.numtide.com?trusted=1&priority=41 https://cache.example.org";
    uniqueKeys = prepared.extraTrustedPublicKeys == "example:key";
    noMultilineSettings = fails (lib.setting "bad\nsetting");
    determinate =
      let
        managed = {
          darwinConfigurations.workstation.config = {
            system.build.toplevel = {
              inherit system;
              drvPath = "/nix/store/managed.drv";
            };
            nix = {
              enable = false;
              settings = throw "Disabled nix.settings must not be accessed";
            };
            determinateNix = {
              enable = true;
              customSettings = {
                extra-substituters = [ "https://cache.numtide.com?priority=5" ];
                extra-trusted-public-keys = [ "example:key" ];
              };
            };
          };
        };
        value = prepare {
          flake = managed;
          inherit host;
          currentSystem = system;
        };
      in
      builtins.deepSeq value (
        value.drvPath == "/nix/store/managed.drv"
        && value.extraSubstituters == "https://cache.numtide.com?priority=41"
        && value.extraTrustedPublicKeys == "example:key"
      );
    matrixLimit = fails (
      discover (
        args
        // {
          flake.nixosConfigurations = builtins.listToAttrs (
            builtins.genList (i: {
              name = "host-${toString i}";
              value = mkHost "/nix/store/host-${toString i}.drv";
            }) 257
          );
        }
      )
    );
  };
  failures = builtins.filter (name: !tests.${name}) (builtins.attrNames tests);
in
if failures == [ ] then
  true
else
  throw "CI tests failed: ${builtins.concatStringsSep ", " failures}"
