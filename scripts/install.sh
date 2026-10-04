#!/bin/bash
set -eu
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$HOME/Desktop/veylo}"
if [ -e "$target" ]; then
  echo "Destination already exists: $target. Choose a new folder; existing files were not changed."
  exit 1
fi
mkdir -p "$target"
cp -R "$source_dir"/. "$target"/
echo "Veylo installed: $target"
echo "Next: cd \"$target\" && npm test && npm run dev"
