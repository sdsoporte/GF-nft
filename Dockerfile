# Authoritative factory backend. Locked Zod is the only external runtime package;
# frontend dependencies remain in the build stage, never the final image.
FROM oven/bun:1.4.2 AS dependencies
WORKDIR /deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && mkdir -p /runtime \
    && cp -RL node_modules/zod /runtime/zod

FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /runtime/zod ./node_modules/zod
COPY backend ./backend
COPY src/domain ./src/domain
COPY src/engine ./src/engine
COPY src/mcp ./src/mcp
# Versioned migrations include legacy grant retirement; plan reissuance first.
COPY src/persistence ./src/persistence

RUN mkdir -p /data && chown bun /data

ENV GF_HOST=0.0.0.0 \
    GF_PORT=8787
USER bun
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.GF_PORT || '8787') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "backend/main.ts"]
