#!/usr/bin/env bash
# Off-plan escrow MVP — setup and run.
#   ./run.sh          install, test, serve on :8000
#   ./run.sh test     tests only
set -euo pipefail
cd "$(dirname "$0")"

SOLC_VERSION=v0.8.24
SOLC="$HOME/bin/solc"

if ! command -v solc >/dev/null 2>&1 && [ ! -x "$SOLC" ]; then
  echo "→ fetching solc $SOLC_VERSION"
  mkdir -p "$HOME/bin"
  curl -sL -o "$SOLC" \
    "https://github.com/ethereum/solidity/releases/download/$SOLC_VERSION/solc-static-linux"
  chmod +x "$SOLC"
fi

if [ ! -d .venv ]; then
  echo "→ creating virtualenv"
  python3 -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  ./.venv/bin/pip install -q -r requirements.txt
fi
PY=./.venv/bin/python

echo "→ contract tests"
$PY tests/test_escrow.py
echo "→ evidence tests"
$PY tests/test_evidence.py
echo "→ public data tests"
$PY tests/test_data.py

[ "${1:-}" = "test" ] && exit 0

echo
echo "→ http://localhost:8000"
exec $PY app.py
