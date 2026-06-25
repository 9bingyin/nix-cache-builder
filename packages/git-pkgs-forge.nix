# Based on nixpkgs PR #516028 (git-pkgs-forge), version bumped to upstream v0.5.1.
{
  lib,
  buildGoModule,
  fetchFromGitHub,
}:

buildGoModule (finalAttrs: {
  __structuredAttrs = true;

  pname = "git-pkgs-forge";
  version = "0.5.1";

  src = fetchFromGitHub {
    owner = "git-pkgs";
    repo = "forge";
    tag = "v${finalAttrs.version}";
    hash = "sha256-oLkaqnyCV8dOs33bz1FqhQT7A/smupk2Y5kaAuD1F3M=";
  };

  vendorHash = "sha256-HqO2GsPkpACAlNSm6VGoyAWKzWgkADmDrevLHIHNTaI=";

  preConfigure = ''
    rm -rf vendor
  '';

  ldflags = [
    "-s"
    "-X github.com/git-pkgs/forge/internal/cli.Version=${finalAttrs.version}"
  ];

  # forges_test.go uses httptest local listener; fails under Nix sandbox on Darwin.
  doCheck = false;

  meta = {
    description = "Go library and CLI for working with git forges";
    mainProgram = "forge";
    homepage = "https://github.com/git-pkgs/forge";
    changelog = "https://github.com/git-pkgs/forge/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.mit;
  };
})
