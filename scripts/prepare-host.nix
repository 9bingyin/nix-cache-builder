{
  flakePath ? "",
  host ? builtins.fromJSON (builtins.getEnv "HOST_JSON"),
  flake ? builtins.getFlake "git+file://${flakePath}?rev=${host.flakeRev}",
  currentSystem ? builtins.currentSystem,
}:
let
  lib = import ./lib.nix;
  config = flake.${host.root}.${host.host}.config;
  top = config.system.build.toplevel;
  # 禁用 Nix 管理的 nix-darwin 配置不能读取 nix.settings。
  settings =
    if config.determinateNix.enable or false then
      config.determinateNix.customSettings or { }
    else if config.nix.enable or true then
      config.nix.settings or { }
    else
      { };
  unique =
    values:
    builtins.foldl' (acc: value: if builtins.elem value acc then acc else acc ++ [ value ]) [ ] values;
  normalizeCache =
    value:
    let
      # 保留原有策略：排除教育网镜像，并固定 numtide 的缓存优先级。
      url = builtins.match "([A-Za-z][A-Za-z0-9+.-]*://)([^/?#:]+)(.*)" (lib.setting value);
      domain = if url == null then "" else builtins.elemAt url 1;
      queryParts = builtins.filter builtins.isString (builtins.split "[?&]" value);
      withoutPriority = builtins.filter (part: builtins.match "priority=.*" part == null) (
        builtins.tail queryParts
      );
    in
    if domain == "edu.cn" || builtins.match ".*\\.edu\\.cn" domain != null then
      null
    else if domain == "cache.numtide.com" then
      builtins.head queryParts
      + "?"
      + builtins.concatStringsSep "&" (withoutPriority ++ [ "priority=41" ])
    else
      value;
  substituters = builtins.filter (value: value != null) (
    map normalizeCache ((settings.substituters or [ ]) ++ (settings.extra-substituters or [ ]))
  );
  keys = map lib.setting (
    (settings.trusted-public-keys or [ ]) ++ (settings.extra-trusted-public-keys or [ ])
  );
in
if !lib.validRoot host.root then
  throw "Unsupported configuration root: ${host.root}"
else if top.system != host.expectedSystem || top.system != currentSystem then
  throw "Platform mismatch: configuration=${top.system}, expected=${host.expectedSystem}, runner=${currentSystem}"
else if host ? drvPath && top.drvPath != host.drvPath then
  throw "Derivation changed since evaluation: expected ${host.drvPath}, got ${top.drvPath}"
else
  {
    drvPath = lib.setting top.drvPath;
    extraSubstituters = builtins.concatStringsSep " " (unique substituters);
    extraTrustedPublicKeys = builtins.concatStringsSep " " (unique keys);
  }
