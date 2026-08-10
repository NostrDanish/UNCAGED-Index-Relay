# UNCAGED Index Relay

# https://hub.docker.com/r/oven/bun — pinned major for reproducibility
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies (lockfile-first for reproducible builds)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 13131

CMD ["bun", "src/server.ts"]
