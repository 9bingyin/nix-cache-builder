#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export FLAKE_PATH="$tmp/flake" RUNNER_TEMP="$tmp"
export HOSTS='' HOST_SYSTEM_OVERRIDES='' HOST_RUNNER_OVERRIDES=''
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
  outputs = { self }: {
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
          builder = "/bin/sh";
          args = [ "-c" "echo ci-smoke > $out" ];
        };
      };
      default = native;
      z-alias = native;
    };
  };
}
EOF
git -C "$FLAKE_PATH" init -q
git -C "$FLAKE_PATH" add flake.nix
git -C "$FLAKE_PATH" -c user.name=Test -c user.email=test@example.org -c commit.gpgsign=false commit -qm fixture

current_system="$(nix eval --raw --impure --expr builtins.currentSystem)"
HOST_SYSTEM_OVERRIDES="$(jq -cn --arg system "$current_system" '{default:$system,native:$system,"z-alias":$system}')"
export HOST_SYSTEM_OVERRIDES

nix eval --json --file "$repo/tests/ci.nix" | jq -e '. == true'
"$repo/scripts/ci.sh" discover > "$tmp/discovered.json"
jq -e '.matrix.include | length == 3' "$tmp/discovered.json"
jq -e '.matrix.include[0].host == "default" and .matrix.include[1].host == "native" and .matrix.include[2].host == "z-alias"' "$tmp/discovered.json"
grep -q 'Each toplevel is evaluated on its target runner' "$GITHUB_STEP_SUMMARY"
export HOST_JSON
HOST_JSON="$(jq -c '.matrix.include[0]' "$tmp/discovered.json")"
"$repo/scripts/ci.sh" prepare > "$tmp/prepared.json"
jq -e '.extraSubstituters == "https://cache.numtide.com?priority=41"' "$tmp/prepared.json"
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

if HOSTS=missing "$repo/scripts/ci.sh" discover > "$tmp/error" 2>&1; then
  echo "Expected unknown host to fail" >&2
  exit 1
fi
if NIX_CONFIG=$'experimental-features = nix-command flakes\npost-build-hook =\n' \
  "$repo/scripts/ci.sh" build > "$tmp/error" 2>&1; then
  echo "Expected missing upload hook to fail" >&2
  exit 1
fi
printf 'CI integration tests passed\n'
