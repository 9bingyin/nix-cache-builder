{
  flakePath ? "",
  hosts ? builtins.fromJSON (builtins.getEnv "HOSTS_JSON"),
  flake ? builtins.getFlake "git+file://${flakePath}?rev=${(builtins.head hosts).flakeRev}",
  currentSystem ? builtins.currentSystem,
}:
let
  inherit (builtins)
    all
    head
    isAttrs
    isString
    map
    ;
  prepare = import ./prepare-host.nix;
  requiredFields = [
    "root"
    "host"
    "artifactId"
    "expectedSystem"
    "runner"
    "flakeRev"
  ];
  validHost =
    host:
    isAttrs host && all (name: isString (host.${name} or null) && host.${name} != "") requiredFields;
  first = head hosts;
  sameRevision = all (host: host.flakeRev == first.flakeRev) hosts;
  sameSystem = all (host: host.expectedSystem == first.expectedSystem) hosts;
  evaluate =
    host:
    host
    // {
      inherit
        (prepare {
          inherit flake host currentSystem;
        })
        drvPath
        ;
    };
in
if hosts == [ ] then
  throw "No hosts to evaluate"
else if !all validHost hosts then
  throw "Invalid host evaluation metadata"
else if !sameRevision then
  throw "Host evaluation group contains multiple revisions"
else if !sameSystem then
  throw "Host evaluation group contains multiple systems"
else
  map evaluate hosts
