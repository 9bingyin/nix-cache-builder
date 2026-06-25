{
  description = "Build selected nixpkgs packages on Darwin and publish them to Cachix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      nixpkgs,
      llm-agents,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ llm-agents.overlays.default ];
              config.allowUnfree = true;
            }
          )
        );

      packagesFor = pkgs: {
        git-pkgs-forge = pkgs.callPackage ./packages/git-pkgs-forge.nix { };
      };
    in
    {
      formatter = forAllSystems (pkgs: pkgs.nixfmt);

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
