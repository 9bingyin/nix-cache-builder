{
  description = "Build remote Nix host configurations and publish them to Cachix and niks3";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
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

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            cachix
            nixfmt
          ];
        };
      });
    };
}
