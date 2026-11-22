#!/bin/sh
set -e
mkdir -p "${DATA_DIR:-/data}" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
    chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
    exec su-exec node:node env PORT="${PORT:-3000}" node src/server.js
fi
exec node src/server.js
