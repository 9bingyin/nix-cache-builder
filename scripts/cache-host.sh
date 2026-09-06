#!/usr/bin/env bash
set -euo pipefail

nix profile install nixpkgs#niks3
export PATH="$HOME/.nix-profile/bin:$PATH"

# niks3 按需刷新 OIDC token；只在上传步骤创建脚本。
umask 077
token_script="$(mktemp)"
trap 'rm -f "$token_script"' EXIT
cat >"$token_script" <<'EOF'
#!/bin/sh
set -eu
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https%3A%2F%2Fniks3.bingyin.org" \
  | jq --exit-status '{token: .value, expires_at: ((now + 240) | todateiso8601)}'
EOF
chmod 700 "$token_script"

built_paths=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if [[ "$path" != /nix/store/* ]]; then
    echo "Invalid build output: $path" >&2
    exit 1
  fi
  built_paths+=("$path")
done < "$RUNNER_TEMP/host-paths"
if [[ ${#built_paths[@]} -eq 0 ]]; then
  echo "No configuration outputs to cache" >&2
  exit 1
fi

# niks3 push 会递归上传这些顶层路径的运行时闭包。
niks3 push \
  --server-url "${NIKS3_SERVER}" \
  --auth-token-script "$token_script" \
  "${built_paths[@]}"
