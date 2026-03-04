\
#!/usr/bin/env bash
set -euo pipefail

ZIP="${1:-}"

if [[ -z "$ZIP" || ! -f "$ZIP" ]]; then
  echo "Usage: bash deploy_from_zip.sh update.zip"
  echo "Tip: upload ONE zip file into Replit, then run this script."
  exit 1
fi

TMP=".deploy_tmp"
rm -rf "$TMP"
mkdir -p "$TMP"

echo "[1/4] Extracting: $ZIP"
unzip -q "$ZIP" -d "$TMP"

ROOT="$TMP"

# If zip contains a single top-level folder with package.json — use it as root
shopt -s nullglob
items=("$TMP"/*)
if [[ ${#items[@]} -eq 1 && -d "${items[0]}" ]]; then
  if [[ -f "${items[0]}/package.json" ]]; then
    ROOT="${items[0]}"
  fi
fi

echo "[2/4] Deploy root: $ROOT"
echo "[3/4] Copying files into project (excluding .replit, node_modules, .git, .env)"

# tar copy keeps structure and overwrites existing files safely
tar \
  --exclude='.replit' \
  --exclude='replit.nix' \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  -C "$ROOT" -cf - . | tar -C . -xf -

echo "[4/4] Cleaning temp"
rm -rf "$TMP"

echo "✅ Done. If dependencies changed: run 'npm install'. Then Run."
