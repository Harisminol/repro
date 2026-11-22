#!/usr/bin/env bash
# Repro — deploy dari GitHub Codespaces (HP-friendly).
# Cara pakai: bash codespace-deploy.sh
# Token API Atlassian ditempel sekali saat diminta (tidak tampil di layar — normal).
set -euo pipefail
export XDG_CONFIG_HOME=/tmp/forge-config
mkdir -p "$XDG_CONFIG_HOME"
forge settings set usage-analytics false >/dev/null 2>&1 || true

echo "== 1/5 Login Forge =="
# Pakai token dari env bila sudah ada (Terminal 4 codespace sudah menyimpannya),
# kalau tidak, minta tempel sekali (tidak tampil di layar — normal).
if [ -n "${FORGE_API_TOKEN:-}" ]; then
  FORGE_TOKEN="$FORGE_API_TOKEN"
else
  read -r -s -p "Tempel API token Atlassian lalu tekan Enter: " FORGE_TOKEN
  echo
fi
forge login -u "haris.minol@gmail.com" -t "$FORGE_TOKEN" --non-interactive
unset FORGE_TOKEN
forge whoami

echo "== 2/5 Register app =="
forge register repro -y || forge register repro || echo "(register dilewati — mungkin app sudah terdaftar)"

echo "== 3/5 Lint =="
forge lint

echo "== 4/5 Deploy (development) =="
forge deploy -e development --non-interactive

echo "== 5/5 Install ke situs demo =="
forge install --site harisminol-dev.atlassian.net -p Jira -e development --non-interactive --confirm-scopes

echo
echo "== SELESAI =="
forge deploy list
echo "Kirim screenshot / output terakhir ke Bre Ku."
