# Authoritative factory backend - development slice.
#
# Pinned runtime: Bun 1.4.2 on the official image, running as the non-root
# `bun` user. The service only needs the backend entrypoint plus the existing
# engine/domain modules it imports: no npm dependencies, no lockfile, no UI, no
# env files, no Godot project and no node_modules are copied.
FROM oven/bun:1.4.2

WORKDIR /app

COPY package.json ./
COPY backend ./backend
COPY src/domain ./src/domain
COPY src/engine ./src/engine

# Inside the container the service must listen on all interfaces so the
# published port can reach it. Compose keeps the published port on loopback.
ENV GF_HOST=0.0.0.0 \
    GF_PORT=8787

USER bun

EXPOSE 8787

# GF_API_TOKEN is intentionally not baked into the image; the health route does
# not need credentials, so the check stays unauthenticated.
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.GF_PORT || '8787') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "backend/main.ts"]
