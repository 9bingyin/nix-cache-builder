#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export FLAKE_PATH="$tmp/flake" RUNNER_TEMP="$tmp"
export HOSTS='' HOST_SYSTEM_OVERRIDES='' HOST_RUNNER_OVERRIDES=''
export IFD_TEST_NONCE="$$"
export AARCH64_DARWIN_RUNNER='' X86_64_DARWIN_RUNNER='' X86_64_LINUX_RUNNER='' AARCH64_LINUX_RUNNER=''
export GITHUB_OUTPUT="$tmp/output" GITHUB_STEP_SUMMARY="$tmp/summary"
# 最小本地测试使用系统 shell，不下载 nixpkgs 或 Bun。
export NIX_CONFIG="experimental-features = nix-command flakes
sandbox = false
post-build-hook = $tmp/hook
"
cat > "$tmp/hook" <<EOF
#!/bin/sh
printf '%s\n' "\$OUT_PATHS" >> '$tmp/queued-paths'
EOF
chmod +x "$tmp/hook"
# daemon 也会调用 hook，先由当前用户创建记录文件，避免 root 创建后无法追加。
: > "$tmp/queued-paths"
mkdir "$FLAKE_PATH"
cat > "$FLAKE_PATH/flake.nix" <<'EOF'
{
  outputs = { self }:
    let
      ifdSystem = import (builtins.derivation {
        name = "nix-cache-ci-ifd-${builtins.getEnv "IFD_TEST_NONCE"}";
        system = builtins.currentSystem;
        builder = "/bin/sh";
        args = [ "-c" "printf '%s\\n' '\"${builtins.currentSystem}\"' > $out" ];
      });
    in
    {
      darwinConfigurations = rec {
        native.config = {
          nix.enable = false;
          nix.settings = throw "Disabled nix.settings accessed";
          determinateNix = {
            enable = true;
            customSettings.extra-substituters = [ "https://cache.numtide.com" ];
          };
          system.build.toplevel = builtins.derivation {
            name = "nix-cache-ci-smoke";
            system = builtins.currentSystem;
            src = ./payload;
            builder = "/bin/sh";
            args = [ "-c" "echo ci-smoke > $out" ];
          };
        };
        default = native;
        z-alias = native;
        ifd.config = {
          nix.enable = false;
          system.build.toplevel = builtins.derivation {
            name = "nix-cache-ci-ifd-result-${builtins.getEnv "IFD_TEST_NONCE"}";
            system = ifdSystem;
            src = ./payload;
            builder = "/bin/sh";
            args = [ "-c" "echo ifd-smoke > $out" ];
          };
        };
      };
    };
}
EOF
printf 'source-sensitive\n' > "$FLAKE_PATH/payload"
git -C "$FLAKE_PATH" init -q
git -C "$FLAKE_PATH" add flake.nix payload
git -C "$FLAKE_PATH" -c user.name=Test -c user.email=test@example.org -c commit.gpgsign=false commit -qm fixture

current_system="$(nix eval --raw --impure --expr builtins.currentSystem)"
HOST_SYSTEM_OVERRIDES="$(jq -cn --arg system "$current_system" \
  '{default:$system,native:$system,"z-alias":$system,ifd:$system}')"
export HOST_SYSTEM_OVERRIDES

nix eval --json --file "$repo/tests/ci.nix" | jq -e '. == true'
HOSTS='native,default,z-alias' "$repo/scripts/ci.sh" discover > "$tmp/discovered.json"
jq -e '.matrix.include | length == 3' "$tmp/discovered.json"
jq -e 'all(.matrix.include[]; (.artifactId | test("^[0-9a-f]{16}$")))' "$tmp/discovered.json"
grep -q 'Ubuntu evaluates each target system without IFD first' "$GITHUB_STEP_SUMMARY"

metadata_dir="$tmp/host-metadata"
HOST_MATRIX_JSON="$(jq -c .matrix "$tmp/discovered.json")" \
  HOST_METADATA_DIR="$metadata_dir" \
  "$repo/scripts/ci.sh" evaluate-fast > "$tmp/fast-evaluation.json"
jq -e '
  .fallbackRequired == false
  and .metadataCount == 3
  and (.fallbackMatrix.include | length) == 0
' "$tmp/fast-evaluation.json"
test "$(find "$metadata_dir" -name '*.json' | wc -l | tr -d ' ')" = 3
jq -e 'all(.[]; (.drvPath | endswith(".drv")))' \
  < <(jq -s '.' "$metadata_dir"/*.json)

EXPECTED_MATRIX_JSON="$(jq -c .matrix "$tmp/discovered.json")" \
  HOST_METADATA_DIR="$metadata_dir" "$repo/scripts/ci.sh" plan > "$tmp/planned.json"
jq -e '(.matrix.include | length) == 1 and (.aliases | length) == 2' "$tmp/planned.json"
grep -q 'default → darwinConfigurations.native' "$GITHUB_STEP_SUMMARY"

HOSTS='native,ifd' HOST_RUNNER_OVERRIDES='{"ifd":"custom-native"}' \
  "$repo/scripts/ci.sh" discover > "$tmp/ifd-discovered.json"
ifd_fast_metadata="$tmp/ifd-fast-metadata"
HOST_MATRIX_JSON="$(jq -c .matrix "$tmp/ifd-discovered.json")" \
  HOST_METADATA_DIR="$ifd_fast_metadata" \
  "$repo/scripts/ci.sh" evaluate-fast \
  > "$tmp/ifd-routing.json" 2> "$tmp/ifd-fast-error"
grep -q "allow-import-from-derivation.*disabled" "$tmp/ifd-fast-error"
jq -e '
  .fallbackRequired == true
  and .metadataCount == 0
  and (.fallbackMatrix.include | length) == 2
  and all(.fallbackMatrix.include[]; (.hosts | length) == 1)
' "$tmp/ifd-routing.json"
test ! -d "$ifd_fast_metadata"

fallback_metadata="$tmp/ifd-fallback-metadata"
while IFS= read -r fallback_group; do
  group_id="$(jq -r .groupId <<< "$fallback_group")"
  HOSTS_JSON="$(jq -c .hosts <<< "$fallback_group")" \
    HOST_METADATA_DIR="$fallback_metadata" \
    "$repo/scripts/ci.sh" evaluate-group > "$tmp/ifd-evaluated-$group_id.json"
done < <(jq -c '.fallbackMatrix.include[]' "$tmp/ifd-routing.json")
test "$(find "$fallback_metadata" -name '*.json' | wc -l | tr -d ' ')" = 2
EXPECTED_MATRIX_JSON="$(jq -c .matrix "$tmp/ifd-discovered.json")" \
  HOST_METADATA_DIR="$fallback_metadata" \
  "$repo/scripts/ci.sh" plan > "$tmp/ifd-planned.json"
jq -e '(.matrix.include | length) == 2 and any(.matrix.include[]; .host == "ifd")' \
  "$tmp/ifd-planned.json"

export HOST_JSON
HOST_JSON="$(jq -c '.matrix.include[0]' "$tmp/planned.json")"
"$repo/scripts/ci.sh" prepare > "$tmp/prepared.json"
jq -e '.extraSubstituters == "https://cache.numtide.com?priority=41"' "$tmp/prepared.json"
original_flake_path="$FLAKE_PATH"
git clone -q "$FLAKE_PATH" "$tmp/flake-copy"
FLAKE_PATH="$tmp/flake-copy" "$repo/scripts/ci.sh" prepare > "$tmp/prepared-copy.json"
FLAKE_PATH="$original_flake_path"
jq -e --arg drv "$(jq -r .drvPath "$tmp/prepared.json")" '.drvPath == $drv' "$tmp/prepared-copy.json"
export DRV_PATH
DRV_PATH="$(jq -er .drvPath "$tmp/prepared.json")"
test -f "$DRV_PATH"
"$repo/scripts/ci.sh" build
result="$(< "$RUNNER_TEMP/host-paths")"
test "$(< "$result")" = ci-smoke
grep -Fxq "$result" "$tmp/queued-paths"
# 再次构建完全命中本地 store，仍须显式将顶层送入 action 的队列。
: > "$tmp/queued-paths"
"$repo/scripts/ci.sh" build
grep -Fxq "$result" "$tmp/queued-paths"

if HOST_JSON="$(jq -c '.matrix.include[0] + {drvPath:"/nix/store/wrong.drv"}' "$tmp/planned.json")" \
  "$repo/scripts/ci.sh" prepare > "$tmp/error" 2>&1; then
  echo "Expected drvPath mismatch to fail" >&2
  exit 1
fi
grep -q 'Derivation changed since evaluation' "$tmp/error"
if HOSTS=missing "$repo/scripts/ci.sh" discover > "$tmp/error" 2>&1; then
  echo "Expected unknown host to fail" >&2
  exit 1
fi
tampered_dir="$tmp/tampered-metadata"
cp -R "$metadata_dir" "$tampered_dir"
for tampered_file in "$tampered_dir"/*.json; do
  break
done
jq '.flakeRev = "stale-revision"' "$tampered_file" > "$tmp/tampered.json"
mv "$tmp/tampered.json" "$tampered_file"
if EXPECTED_MATRIX_JSON="$(jq -c .matrix "$tmp/discovered.json")" \
  HOST_METADATA_DIR="$tampered_dir" "$repo/scripts/ci.sh" plan > "$tmp/error" 2>&1; then
  echo "Expected stale metadata to fail" >&2
  exit 1
fi
grep -q 'Evaluation metadata does not match discovery' "$tmp/error"
if EXPECTED_MATRIX_JSON="$(jq -c .matrix "$tmp/discovered.json")" \
  HOST_METADATA_DIR="$tmp/missing" "$repo/scripts/ci.sh" plan > "$tmp/error" 2>&1; then
  echo "Expected missing metadata to fail" >&2
  exit 1
fi
if NIX_CONFIG=$'experimental-features = nix-command flakes\npost-build-hook =\n' \
  "$repo/scripts/ci.sh" build > "$tmp/error" 2>&1; then
  echo "Expected missing upload hook to fail" >&2
  exit 1
fi
printf 'CI integration tests passed\n'
