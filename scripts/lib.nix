let
  inherit (builtins)
    all
    attrValues
    elemAt
    filter
    fromJSON
    getEnv
    isAttrs
    isString
    map
    match
    split
    ;
in
rec {
  trim =
    value:
    let
      parts = match "[[:space:]]*(.*[^[:space:]])[[:space:]]*" value;
    in
    if parts == null then "" else elemAt parts 0;

  hostFilters = value: filter (s: s != "") (map trim (filter isString (split "," value)));

  envOr =
    name: fallback:
    let
      value = getEnv name;
    in
    if value == "" then fallback else value;

  stringMap =
    value:
    let
      parsed = if trim value == "" then { } else fromJSON value;
    in
    if isAttrs parsed && all (v: isString v && trim v != "") (attrValues parsed) then
      parsed
    else
      throw "Host overrides must be an object with non-empty string values";

  validRoot =
    root:
    builtins.elem root [
      "darwinConfigurations"
      "nixosConfigurations"
    ];

  # GitHub 单行输出不能包含换行，避免缓存设置意外生成额外输出项。
  setting =
    value:
    if isString value && match ".*[\r\n].*" value == null then
      value
    else
      throw "Cache settings must be single-line strings";
}
