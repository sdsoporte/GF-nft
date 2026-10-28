# Authoritative factory backend. Locked Zod is the only external runtime
# package; the archived web demo, tests, game project and dev tooling never
# reach the image. The build context is the repository root (see compose.yaml)
# because the dependency stage needs the root workspace manifest and lockfile.
FROM oven/bun:1.4.2 AS dependencies
WORKDIR /deps
COPY package.json bun.lock ./
COPY backend/package.json ./backend/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && mkdir -p /runtime/backend/node_modules \
    && if [ -d node_modules/zod ]; then \
         cp -RL node_modules/zod /runtime/backend/node_modules/zod; \
       else \
         cp -RL node_modules/.bun/zod@*/node_modules/zod /runtime/backend/node_modules/zod; \
       fi \
    && test -f /runtime/backend/node_modules/zod/package.json

FROM oven/bun:1.4.2
WORKDIR /app
COPY backend/package.json ./backend/package.json
COPY --from=dependencies /runtime/backend/node_modules/zod ./backend/node_modules/zod
COPY backend/main.ts ./backend/main.ts
# Versioned migrations include legacy grant retirement; plan reissuance first.
COPY backend/src ./backend/src

RUN mkdir -p /data && chown bun /data

ENV GF_HOST=0.0.0.0 \
    GF_PORT=8787
USER bun
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.GF_PORT || '8787') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "backend/main.ts"]
