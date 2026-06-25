{
  description = "Build selected nixpkgs packages on Darwin and publish them to Cachix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents,
      treefmt-nix,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (pkgsFor system));

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ llm-agents.overlays.default ];
          config.allowUnfree = true;
        };

      treefmtEval = nixpkgs.lib.genAttrs systems (
        system:
        treefmt-nix.lib.evalModule (pkgsFor system) {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.prettier.enable = true;
        }
      );

      packagesFor = pkgs: {
        git-pkgs-forge = pkgs.callPackage ./packages/git-pkgs-forge.nix { };
      };
    in
    {
      formatter = nixpkgs.lib.genAttrs systems (system: treefmtEval.${system}.config.build.wrapper);

      checks = nixpkgs.lib.genAttrs systems (system: {
        formatting = treefmtEval.${system}.config.build.check self;
      });

      apps = forAllSystems (pkgs: {
        nix-fast-build = {
          type = "app";
          program = "${pkgs.nix-fast-build}/bin/nix-fast-build";
        };
      });

      legacyPackages = forAllSystems (pkgs: pkgs);

      packages = forAllSystems packagesFor;

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            cachix
            nixfmt
          ];
        };
      });
    };
}
