host:
let
  attrValues = attrs: builtins.map (name: attrs.${name}) (builtins.attrNames attrs);

  concatMap = f: values: builtins.concatLists (builtins.map f values);

  isDerivation = value: builtins.isAttrs value && value ? type && value.type == "derivation";

  packageName =
    package:
    if package ? pname then
      package.pname
    else if package ? name then
      package.name
    else if package ? outPath then
      baseNameOf package.outPath
    else
      "package";

  sanitize =
    value:
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
      ]
      value;

  listToPackageAttrs =
    prefix: packages:
    let
      derivations = builtins.filter isDerivation packages;
    in
    builtins.listToAttrs (
      builtins.genList (
        index:
        let
          package = builtins.elemAt derivations index;
        in
        {
          name = "${prefix}-${toString index}-${sanitize (packageName package)}";
          value = package;
        }
      ) (builtins.length derivations)
    );

  optionalPackageAttr = name: package: if isDerivation package then { ${name} = package; } else { };

  cfg = host.config or { };

  environmentPackages = cfg.environment.systemPackages or [ ];

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
in
listToPackageAttrs "environment-systemPackages" environmentPackages
// listToPackageAttrs "users-users-packages" userPackages
// listToPackageAttrs "home-manager-users-home-packages" homeManagerUserPackages
// optionalPackageAttr "nix-package" nixPackage
