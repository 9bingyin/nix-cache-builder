host:
# 从 nix-darwin / NixOS 主机配置中自动收集需要二进制缓存的包根。
# 只做 eval，不构建 toplevel；输出为 attrName -> derivation。
let
  attrValues = attrs: builtins.map (name: attrs.${name}) (builtins.attrNames attrs);

  concatMap = f: values: builtins.concatLists (builtins.map f values);

  isDerivation = value: builtins.isAttrs value && value ? type && value.type == "derivation";

  # fixed-output（源码 tarball 等）不需要我们构建二进制
  isFixedOutput =
    package: (package.outputHash or null) != null || (package.outputHashAlgo or null) != null;

  packageName =
    package:
    if package ? pname && package.pname != null && package.pname != "" then
      package.pname
    else if package ? name && package.name != null && package.name != "" then
      package.name
    else if package ? outPath then
      baseNameOf package.outPath
    else
      "package";

  sanitize =
    value:
    let
      replaced =
        builtins.replaceStrings
          [
            "/"
            ":"
            " "
            "."
            "+"
            "["
            "]"
            "("
            ")"
            "_"
          ]
          [
            "-"
            "-"
            "-"
            "-"
            "-"
            "-"
            "-"
            "-"
            "-"
            "-"
          ]
          value;
      # builtins.split 会夹带匹配组 list，只保留非空字符串段
      parts = builtins.filter (part: builtins.isString part && part != "") (builtins.split "-+" replaced);
      collapsed = builtins.concatStringsSep "-" parts;
    in
    if collapsed == "" then "package" else collapsed;

  # 内部/元数据包，单独构建没有意义或与真实包列表重叠
  isNoise =
    package:
    let
      name = packageName package;
      lower = builtins.stringLength name;
    in
    name == "home-manager-path"
    || name == "hm-session-vars.sh"
    || name == "home-configuration-reference-manpage"
    || name == "darwin-uninstaller"
    || name == "darwin-version"
    || name == "darwin-option"
    # 由主机配置生成的版本信息脚本；没有可复用的二进制构建价值，
    # 且 store 路径可能在 plan 与独立 build job 的重新求值间变化。
    || name == "nixos-version"
    || name == "nixos-wsl-version"
    # 纯 shell 片段 / 生成文件
    || (lower > 3 && builtins.substring (lower - 3) 3 name == ".sh");

  shouldInclude = package: isDerivation package && !isFixedOutput package && !isNoise package;

  collect = packages: builtins.filter shouldInclude packages;

  cfg = host.config or { };

  environmentPackages = cfg.environment.systemPackages or [ ];

  defaultPackages = cfg.environment.defaultPackages or [ ];

  fontPackages = if cfg ? fonts then cfg.fonts.packages or [ ] else [ ];

  userPackages =
    if cfg ? users && cfg.users ? users then
      concatMap (user: user.packages or [ ]) (attrValues cfg.users.users)
    else
      [ ];

  homeManagerUsers =
    if cfg ? home-manager && cfg.home-manager ? users then attrValues cfg.home-manager.users else [ ];

  homeManagerUserPackages = concatMap (
    user: if user ? home then user.home.packages or [ ] else [ ]
  ) homeManagerUsers;

  nixPackage = if cfg ? nix && cfg.nix ? package then cfg.nix.package else null;

  allPackages = collect (
    environmentPackages
    ++ defaultPackages
    ++ fontPackages
    ++ userPackages
    ++ homeManagerUserPackages
    ++ (if isDerivation nixPackage then [ nixPackage ] else [ ])
  );

  # 按 outPath 去重，保留首次出现（来源优先级：system → default → fonts → users → hm → nix）
  dedupeByStorePath =
    packages:
    let
      step =
        acc: package:
        let
          path = builtins.unsafeDiscardStringContext package.outPath;
        in
        if builtins.elem path acc.seen then
          acc
        else
          {
            seen = acc.seen ++ [ path ];
            packages = acc.packages ++ [ package ];
          };
      result = builtins.foldl' step {
        seen = [ ];
        packages = [ ];
      } packages;
    in
    result.packages;

  uniquePackages = dedupeByStorePath allPackages;

  # 稳定 attr：sanitize(name) + store hash 前 8 位（与列表顺序无关）
  # outPath 带 string context，不能直接进 attr 名，需 discard
  attrName =
    package:
    let
      base = sanitize (packageName package);
      path = builtins.unsafeDiscardStringContext package.outPath;
      hash = builtins.substring 11 8 path;
    in
    "${base}-${hash}";

  packageAttrs = builtins.listToAttrs (
    builtins.map (package: {
      name = attrName package;
      value = package;
    }) uniquePackages
  );

  # 按 attr 名排序，保证 eval JSON 稳定
  sortedNames = builtins.sort builtins.lessThan (builtins.attrNames packageAttrs);
in
builtins.listToAttrs (
  builtins.map (name: {
    inherit name;
    value = packageAttrs.${name};
  }) sortedNames
)
