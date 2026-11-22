FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ENV PORT=3000 \
    NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# better-sqlite3 quirk 33a: npm's auto-gyp demands Python even though prebuilds are
# bundled -> --ignore-scripts install + in-build smoke test so ABI drift fails HERE;
# npm rebuild fallback covers alpine-musl if the bundled prebuild misses the arch.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && (node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1')" \
   || (npm rebuild better-sqlite3 && node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1')"))

COPY src/ ./src/
COPY public/ ./public/
COPY watcher/ ./watcher/

RUN apk add --no-cache su-exec \
 && chmod +x /app/src/entrypoint.sh \
 && mkdir -p /data && chown node:node /app /data

EXPOSE 3000

# Entrypoint chowns the (root-owned on Railway) /data volume to node, then drops
# privileges so the server never runs as root against the persistent volume.
ENTRYPOINT ["/app/src/entrypoint.sh"]
