#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

case "${1:-}" in
  discover|prepare)
    export FLAKE_PATH
    FLAKE_PATH="$(cd "${FLAKE_PATH:?FLAKE_PATH is required}" && pwd -P)"
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    if [[ "$1" == discover ]]; then
      export FLAKE_REV
      FLAKE_REV="$(git -C "$FLAKE_PATH" rev-parse HEAD)"
      nix eval --impure --json --file "$script_dir/discover-hosts.nix" \
        --apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; flakeRev = builtins.getEnv "FLAKE_REV"; }' > "$output"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        printf 'matrix=%s\n' "$(jq -c .matrix "$output")" >> "$GITHUB_OUTPUT"
      fi
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        jq -r .summary "$output" >> "$GITHUB_STEP_SUMMARY"
      fi
    else
      # 实例化并写入 .drv，下一步直接构建它，不再求值 flake 属性。
      nix eval --impure --json --file "$script_dir/prepare-host.nix" \
        --apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; }' > "$output"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        jq -r 'to_entries[] | "\(.key)=\(.value)"' "$output" >> "$GITHUB_OUTPUT"
      fi
    fi
    jq . "$output"
    ;;
  build)
    : "${DRV_PATH:?DRV_PATH is required}" "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    # action 配置失败时不静默退化为只构建、不上传。
    hook="$(nix config show --json | jq -er '."post-build-hook".value | select(length > 0)')"
    test -x "$hook"
    nix build "${DRV_PATH}^*" \
      --out-link "$RUNNER_TEMP/host-result" --print-build-logs --print-out-paths \
      --option extra-substituters "${EXTRA_SUBSTITUTERS:-}" \
      --option extra-trusted-public-keys "${EXTRA_TRUSTED_PUBLIC_KEYS:-}" \
      > "$RUNNER_TEMP/host-paths"
    test -s "$RUNNER_TEMP/host-paths"
    # 完全命中其他缓存时 Nix 不运行 post-build-hook，仍需将顶层加入 action 队列。
    # GC root 保留到 action 的 post-job 上传收尾结束。
    OUT_PATHS="$(< "$RUNNER_TEMP/host-paths")" DRV_PATH="$DRV_PATH" "$hook"
    ;;
  *)
    echo "Usage: $0 {discover|prepare|build}" >&2
    exit 1
    ;;
esac
