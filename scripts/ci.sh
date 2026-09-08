#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

evaluate_host() {
  export FLAKE_PATH
  FLAKE_PATH="$(cd "${FLAKE_PATH:?FLAKE_PATH is required}" && pwd -P)"
  nix eval --impure --json --file "$script_dir/prepare-host.nix" \
    --apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; }'
}

case "${1:-}" in
  discover)
    export FLAKE_PATH FLAKE_REV
    FLAKE_PATH="$(cd "${FLAKE_PATH:?FLAKE_PATH is required}" && pwd -P)"
    FLAKE_REV="$(git -C "$FLAKE_PATH" rev-parse HEAD)"
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    nix eval --impure --json --file "$script_dir/discover-hosts.nix" \
      --apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; flakeRev = builtins.getEnv "FLAKE_REV"; }' > "$output"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      printf 'matrix=%s\n' "$(jq -c .matrix "$output")" >> "$GITHUB_OUTPUT"
    fi
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      jq -r .summary "$output" >> "$GITHUB_STEP_SUMMARY"
    fi
    jq . "$output"
    ;;
  evaluate)
    : "${HOST_JSON:?HOST_JSON is required}" "${METADATA_PATH:?METADATA_PATH is required}"
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    evaluate_host > "$output"
    mkdir -p "$(dirname "$METADATA_PATH")"
    jq -c --argjson host "$HOST_JSON" '$host + {drvPath: .drvPath}' "$output" > "$METADATA_PATH"
    jq . "$METADATA_PATH"
    ;;
  plan)
    : "${HOST_METADATA_DIR:?HOST_METADATA_DIR is required}" "${EXPECTED_MATRIX_JSON:?EXPECTED_MATRIX_JSON is required}"
    shopt -s nullglob
    metadata_files=("$HOST_METADATA_DIR"/*.json)
    shopt -u nullglob
    if ((${#metadata_files[@]} == 0)); then
      echo "No evaluated host metadata found" >&2
      exit 1
    fi
    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT
    jq -s --argjson expected "$EXPECTED_MATRIX_JSON" '
      [
        $expected.include[] as $wanted
        | [.[] | select(.artifactId == $wanted.artifactId)] as $matches
        | if ($matches | length) != 1 then
            error("Expected exactly one metadata file for " + $wanted.root + "." + $wanted.host)
          elif (($matches[0] | del(.drvPath)) != $wanted) then
            error("Evaluation metadata does not match discovery for " + $wanted.root + "." + $wanted.host)
          else
            $matches[0]
          end
      ]
    ' "${metadata_files[@]}" > "$temp_dir/hosts.json"
    export HOSTS_JSON_PATH="$temp_dir/hosts.json"
    nix eval --impure --json --file "$script_dir/plan-hosts.nix" --apply 'f: f { }' > "$temp_dir/plan.json"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      printf 'matrix=%s\n' "$(jq -c .matrix "$temp_dir/plan.json")" >> "$GITHUB_OUTPUT"
    fi
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      jq -r .summary "$temp_dir/plan.json" >> "$GITHUB_STEP_SUMMARY"
    fi
    jq . "$temp_dir/plan.json"
    ;;
  prepare)
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    evaluate_host > "$output"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      jq -r 'to_entries[] | "\(.key)=\(.value)"' "$output" >> "$GITHUB_OUTPUT"
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
    echo "Usage: $0 {discover|evaluate|plan|prepare|build}" >&2
    exit 1
    ;;
esac
