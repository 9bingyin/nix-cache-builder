#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

resolve_flake_path() {
  export FLAKE_PATH
  FLAKE_PATH="$(cd "${FLAKE_PATH:?FLAKE_PATH is required}" && pwd -P)"
}

evaluate_host() {
  resolve_flake_path
  nix eval --impure --json --file "$script_dir/prepare-host.nix" \
    --apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; }'
}

evaluate_hosts() {
  local hosts_json="$1"
  local eval_system="$2"
  local allow_ifd="$3"
  local -a args=(nix eval --impure --json)

  resolve_flake_path
  export HOSTS_JSON="$hosts_json"
  if [[ -n "$eval_system" ]]; then
    args+=(--option eval-system "$eval_system")
  fi
  args+=(--option allow-import-from-derivation "$allow_ifd")
  args+=(--file "$script_dir/evaluate-hosts.nix")
  args+=(--apply 'f: f { flakePath = builtins.getEnv "FLAKE_PATH"; }')
  "${args[@]}"
}

write_metadata_files() {
  local evaluated_path="$1"
  local metadata_dir="$2"

  mkdir -p "$metadata_dir"
  while IFS= read -r host_json; do
    local artifact_id
    artifact_id="$(jq -er '.artifactId | select(test("^[0-9a-f]{16}$"))' <<< "$host_json")"
    jq -c . <<< "$host_json" > "$metadata_dir/$artifact_id.json"
  done < <(jq -c '.[]' "$evaluated_path")
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
  evaluate-fast)
    : "${HOST_MATRIX_JSON:?HOST_MATRIX_JSON is required}" "${HOST_METADATA_DIR:?HOST_METADATA_DIR is required}"
    jq -e '
      (.include | type == "array" and length > 0)
      and all(.include[];
        (.expectedSystem | type == "string" and length > 0)
        and (.runner | type == "string" and length > 0)
        and (.artifactId | type == "string" and test("^[0-9a-f]{16}$"))
      )
    ' <<< "$HOST_MATRIX_JSON" > /dev/null

    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT
    : > "$temp_dir/fallback.jsonl"
    : > "$temp_dir/routes.jsonl"
    metadata_count=0

    while IFS= read -r hosts_json; do
      expected_system="$(jq -er '.[0].expectedSystem' <<< "$hosts_json")"
      host_count="$(jq -er 'length' <<< "$hosts_json")"
      if evaluate_hosts "$hosts_json" "$expected_system" false \
        > "$temp_dir/evaluated.json" 2> "$temp_dir/evaluation-error"; then
        write_metadata_files "$temp_dir/evaluated.json" "$HOST_METADATA_DIR"
        metadata_count=$((metadata_count + host_count))
        jq -cn --arg system "$expected_system" --argjson hosts "$host_count" \
          '{system:$system, route:"Ubuntu fast eval", hosts:$hosts}' >> "$temp_dir/routes.jsonl"
      else
        cat "$temp_dir/evaluation-error" >&2
        printf '::warning::Fast evaluation failed for %s; using native fallback.\n' "$expected_system" >&2
        jq -cn --arg system "$expected_system" --argjson hosts "$host_count" \
          '{system:$system, route:"Native fallback", hosts:$hosts}' >> "$temp_dir/routes.jsonl"
        jq -c '
          sort_by(.runner)
          | group_by(.runner)[]
          | {
              expectedSystem: .[0].expectedSystem,
              runner: .[0].runner,
              flakeRev: .[0].flakeRev,
              groupId: .[0].artifactId,
              hosts: .
            }
        ' <<< "$hosts_json" >> "$temp_dir/fallback.jsonl"
      fi
    done < <(
      jq -c '.include | sort_by(.expectedSystem) | group_by(.expectedSystem)[]' \
        <<< "$HOST_MATRIX_JSON"
    )

    fallback_matrix="$(jq -sc '{include: .}' "$temp_dir/fallback.jsonl")"
    fallback_count="$(jq -r '.include | length' <<< "$fallback_matrix")"
    fallback_required=false
    if ((fallback_count > 0)); then
      fallback_required=true
    fi

    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      {
        printf 'fallbackMatrix=%s\n' "$fallback_matrix"
        printf 'fallbackRequired=%s\n' "$fallback_required"
        printf 'metadataCount=%s\n' "$metadata_count"
      } >> "$GITHUB_OUTPUT"
    fi
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        printf '\n## Evaluation routing\n\n'
        printf '| System | Hosts | Route |\n'
        printf '| --- | ---: | --- |\n'
        jq -rs '.[] | "| \(.system) | \(.hosts) | \(.route) |"' "$temp_dir/routes.jsonl"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
    jq -n \
      --argjson fallbackMatrix "$fallback_matrix" \
      --argjson fallbackRequired "$fallback_required" \
      --argjson metadataCount "$metadata_count" \
      '{fallbackMatrix:$fallbackMatrix, fallbackRequired:$fallbackRequired, metadataCount:$metadataCount}'
    ;;
  evaluate-group)
    : "${HOSTS_JSON:?HOSTS_JSON is required}" "${HOST_METADATA_DIR:?HOST_METADATA_DIR is required}"
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    evaluate_hosts "$HOSTS_JSON" "" true > "$output"
    write_metadata_files "$output" "$HOST_METADATA_DIR"
    jq . "$output"
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
    echo "Usage: $0 {discover|evaluate-fast|evaluate-group|plan|prepare|build}" >&2
    exit 1
    ;;
esac
