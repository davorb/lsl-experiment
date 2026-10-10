#!/bin/sh
set -e
# The original game files are never baked into the image: mount your LSL1 install at /app/game-data.
# Extraction takes about a second, so it simply runs on every start.
if [ -f /app/game-data/VOL.0 ]; then
  npm run extract --silent
else
  echo "WARNING: no game files in /app/game-data (mount your LSL1 install there); falling back to the placeholder engine." >&2
fi
exec "$@"
