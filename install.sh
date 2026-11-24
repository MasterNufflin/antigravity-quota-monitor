#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HOME}/.gemini/config/plugins/quota-monitor"
REPO_URL="https://github.com/MasterNufflin/antigravity-quota-monitor.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Antigravity Quota Monitor to ${TARGET_DIR}..."
mkdir -p "${HOME}/.gemini/config/plugins"

if [[ -f "${SCRIPT_DIR}/plugin.json" && -d "${SCRIPT_DIR}/sidecars/quota_panel" ]]; then
  rm -rf "${TARGET_DIR}"
  mkdir -p "${TARGET_DIR}"
  cp "${SCRIPT_DIR}/plugin.json" "${TARGET_DIR}/"
  cp "${SCRIPT_DIR}/README.md" "${TARGET_DIR}/" 2>/dev/null || true
  cp -R "${SCRIPT_DIR}/assets" "${TARGET_DIR}/assets"
  mkdir -p "${TARGET_DIR}/sidecars/quota_panel"
  for f in package.json sidecar.json main.mjs menubar.swift index.html styles.css app.js; do
    cp "${SCRIPT_DIR}/sidecars/quota_panel/${f}" "${TARGET_DIR}/sidecars/quota_panel/${f}"
  done
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  git clone --depth 1 "${REPO_URL}" "${TMP_DIR}/repo"
  rm -rf "${TARGET_DIR}"
  mkdir -p "${TARGET_DIR}"
  cp "${TMP_DIR}/repo/plugin.json" "${TARGET_DIR}/"
  cp "${TMP_DIR}/repo/README.md" "${TARGET_DIR}/" 2>/dev/null || true
  cp -R "${TMP_DIR}/repo/assets" "${TARGET_DIR}/assets"
  mkdir -p "${TARGET_DIR}/sidecars/quota_panel"
  for f in package.json sidecar.json main.mjs menubar.swift index.html styles.css app.js; do
    cp "${TMP_DIR}/repo/sidecars/quota_panel/${f}" "${TARGET_DIR}/sidecars/quota_panel/${f}"
  done
fi

echo ""
echo "Done! Antigravity discovers the plugin automatically."
echo "Open the '+' menu in Antigravity's right side pane -> Quota Monitor."
echo "On macOS, the native Menu Bar gauge compiles automatically on first launch."
