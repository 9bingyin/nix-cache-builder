let
  lock = builtins.fromJSON (builtins.readFile ./flake.lock);
  nixpkgsInput = lock.nodes.root.inputs.nixpkgs;
  nixpkgs = builtins.fetchTree lock.nodes.${nixpkgsInput}.locked;
  pkgs = import nixpkgs {
    system = "aarch64-darwin";
    config.allowUnfree = true;
  };
in
{
  inherit (pkgs)
    element-desktop
    google-chrome
    keka
    librewolf
    lmstudio
    mise
    motrix-next
    nh
    nodejs_latest
    orbstack
    qq
    raycast
    shottr
    typora
    winbox
    zed-editor
    ;
}
