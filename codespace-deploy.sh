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
# Idempotent: register ONLY when the manifest still holds the placeholder id.
# Re-running `forge register` on an already-registered app creates a SECOND
# app (22 Nov 2026: a duplicate install shadowed the fixed one in Jira).
APP_ID=$(grep -E 'id: ari:cloud:ecosystem::app/' manifest.yml | awk '{print $2}' || true)
if [ -z "$APP_ID" ] || [ "$APP_ID" = "ari:cloud:ecosystem::app/00000000-0000-0000-0000-000000000000" ]; then
  forge register repro -y || forge register repro || echo "(register dilewati — mungkin app sudah terdaftar)"
else
  echo "(app sudah terdaftar: $APP_ID — register dilewati)"
fi

echo "== 3/5 Lint =="
# `forge lint` exits non-zero on a major-version approval (scope change)
# as well as on real errors. Only the approval may be ignored.
set +e
forge lint > /tmp/repro-lint.log 2>&1
LINT_STATUS=$?
set -e
if [ $LINT_STATUS -ne 0 ]; then
  if grep -q "MAJOR_VERSION_RULE" /tmp/repro-lint.log; then
    echo "(lint: hanya approval major-version karena perubahan scope — lanjut)"
  else
    cat /tmp/repro-lint.log
    echo "LINT GAGAL — perbaiki dulu"
    exit 1
  fi
fi

echo "== 4/5 Deploy (development) =="
# A scope change is a major version: the plain deploy refuses and asks for
# --approve MAJOR_VERSION_RULE. Retry with the approval when that happens.
if ! forge deploy -e development --non-interactive; then
  echo "(deploy butuh persetujuan major-version — coba lagi dengan --approve)"
  forge deploy -e development --non-interactive --approve MAJOR_VERSION_RULE
fi

echo "== 5/5 Install ke situs demo =="
# After a major version the plain install may refuse; --upgrade is the
# fallback that installs the newest version over the existing one.
if ! forge install --site harisminol-dev.atlassian.net -p Jira -e development --non-interactive --confirm-scopes; then
  echo "(install biasa gagal — coba --upgrade)"
  forge install --upgrade --site harisminol-dev.atlassian.net -p Jira -e development --non-interactive --confirm-scopes
fi

echo
echo "== SELESAI =="
forge deploy list
echo "Kirim screenshot / output terakhir ke Bre Ku."
