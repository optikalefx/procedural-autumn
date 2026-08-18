#!/bin/zsh
# Retry wrapper: peers editing the tree trigger Vite full-reloads mid-capture.
DIR="$1"; shift
VIEWS=${@:-"hero drive meadow forest river backlit dawn"}
cd /Users/sean/htdocs/procedural-fall
for v in ${=VIEWS}; do
  for i in 1 2 3 4; do
    if node tools/shot.mjs --view "$v" --out "$DIR/$v.png" --w 1600 --h 900 >/dev/null 2>&1; then
      echo "ok $v"; break
    fi
    echo "retry $v ($i)"; sleep 3
  done
done
