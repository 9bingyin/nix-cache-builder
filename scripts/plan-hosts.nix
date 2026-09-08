{
  hosts ? builtins.fromJSON (builtins.readFile (builtins.getEnv "HOSTS_JSON_PATH")),
}:
let
  inherit (builtins)
    all
    concatStringsSep
    foldl'
    isAttrs
    isString
    length
    map
    ;
  lib = import ./lib.nix;
  validHost =
    host:
    isAttrs host
    && all (name: isString (host.${name} or null) && host.${name} != "") [
      "root"
      "host"
      "expectedSystem"
      "runner"
      "flakeRev"
      "drvPath"
    ]
    && lib.validRoot host.root;
  ordered = builtins.sort (
    left: right:
    if (left.host == "default") != (right.host == "default") then
      left.host != "default"
    else
      builtins.lessThan "${left.root}.${left.host}" "${right.root}.${right.host}"
  ) hosts;
  deduplicated =
    foldl'
      (
        acc: host:
        if acc.seen ? ${host.drvPath} then
          acc
          // {
            aliases = acc.aliases ++ [ "${host.root}.${host.host} → ${acc.seen.${host.drvPath}}" ];
          }
        else
          {
            seen = acc.seen // {
              ${host.drvPath} = "${host.root}.${host.host}";
            };
            include = acc.include ++ [ host ];
            inherit (acc) aliases;
          }
      )
      {
        seen = { };
        include = [ ];
        aliases = [ ];
      }
      ordered;
  inherit (deduplicated) aliases include;
in
if hosts == [ ] then
  throw "No evaluated host metadata found"
else if !all validHost hosts then
  throw "Invalid evaluated host metadata"
else if length include > 256 then
  throw "Configuration count exceeds GitHub's 256-job matrix limit"
else
  {
    matrix = { inherit include; };
    inherit aliases;
    summary = concatStringsSep "\n" (
      [
        "## Evaluated configuration builds"
        ""
        "Revision: `${(builtins.head include).flakeRev}`"
        ""
        "| Configuration | System | Runner |"
        "| --- | --- | --- |"
      ]
      ++ map (host: "| ${host.root}.${host.host} | ${host.expectedSystem} | ${host.runner} |") include
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
