# Project Details

## Features

- **NIP-01 Relay**: True WebSocket-based Nostr relay implementation
- **Bun Runtime**: Uses Bun's native WebSocket server for high performance
- **OpenSearch Backend**: Scalable event storage and querying
- **Validation**: Zod and Nostrify for event validation
- **Environment Config**: Type-safe configuration management
- **Portable Code**: Uses Node.js builtins for maximum compatibility (except WebSocket server)

## Project Structure

```
.
├── src/
│   ├── server.ts           # WebSocket relay server (Bun-specific)
│   ├── relay.ts            # Relay implementation (event handling, subscriptions)
│   ├── relay.test.ts       # Relay tests
│   ├── opensearch.ts       # OpenSearch backend (storage, querying, NIP-50)
│   ├── opensearch.test.ts  # OpenSearch tests
│   ├── config.ts           # Configuration management
│   ├── config.test.ts      # Configuration tests
│   ├── analyze-pool.ts     # Worker pool for event analysis (verify, language, sentiment, media)
│   ├── analyze-pool.test.ts # Analysis pool tests
│   ├── analyze-worker.ts   # Worker thread for event analysis
│   ├── log.ts              # Structured JSON logging (one-line entries, Loki-queryable)
│   ├── log.test.ts         # Logging tests
│   ├── media.ts            # Media/video detection from imeta tags and URLs
│   ├── negentropy.ts       # NIP-77 Negentropy protocol codec (set reconciliation)
│   ├── negentropy.test.ts  # Negentropy tests
│   ├── search-text.ts      # Shared buildSearchText for full-text search indexing
│   ├── search-text.test.ts # Search text tests
│   ├── autocomplete-text.ts      # Shared buildAutocompleteText for edge-ngram autocomplete indexing
│   ├── autocomplete-text.test.ts # Autocomplete text tests
│   ├── trends.ts           # Trending tag computation and publishing
│   └── trends.test.ts      # Trends tests
├── scripts/
│   ├── analyze-client.ts          # Analyze a client's users (active/inactive, engagement, cohorts)
│   ├── backfill-autocomplete.ts   # Backfill autocomplete_text field for existing events
│   ├── backfill-client-address.ts # Backfill client field (NIP-89 client address) for existing events
│   ├── backfill-language.ts       # Backfill language field for existing events
│   ├── backfill-media.ts          # Backfill media/video fields for existing events
│   ├── backfill-protocol.ts       # Backfill protocol field for NIP-48 events
│   ├── backfill-search.ts         # Backfill search field for existing events
│   ├── backfill-sentiment.ts      # Backfill sentiment field for existing events
│   ├── backfill-zap-amounts.ts    # Backfill zap amount fields for kind 9735
│   ├── delete-ephemeral-events.ts # Delete ephemeral events from storage
│   ├── delete-expired-events.ts   # Delete expired events (NIP-40)
│   ├── delete-incomplete-events.ts # Delete events with missing fields
│   ├── export.ts                  # Export events from the index
│   ├── refresh-nip85.ts           # Refresh NIP-85 stats for events matching a filter
│   ├── reindex-tags-map.ts        # Reindex tags_map for existing documents
│   ├── reindex-to-clean-index.ts  # Reindex into a fresh index
│   └── update-trends.ts          # Compute and publish trending tags
├── package.json       # Dependencies and scripts
├── tsconfig.json      # TypeScript configuration
├── biome.json         # Biome linter/formatter configuration
├── .gitlab-ci.yml     # GitLab CI pipeline (lint, test, typecheck)
├── .env.example       # Example environment variables
├── .gitignore         # Git ignore rules
├── AGENTS.md          # Project documentation for AI agents
├── README.md          # Project documentation
└── LICENSE            # AGPL-3.0 license
```

## Configuration

Edit `.env` to configure the application:

- `PORT` - Server port (default: 13131)
- `RELAY_URL` - Full WebSocket URL of the relay, eg `wss://relay.example.com/`
- `RELAY_PUBKEY` - Relay operator's public key (hex, for NIP-11)
- `RELAY_CONTACT` - Relay operator's contact (email or URL, for NIP-11)
- `IP_HEADER` - HTTP header carrying the real client IP behind a reverse
  proxy (e.g. `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`; first
  comma-separated entry is used). Unset = use the socket address.
- `LOG_LEVEL` - Log level: `debug` | `info` | `warn` | `error` (default: `info`).
  Logs are one-line JSON, queryable in Loki with `| json`. `debug` includes
  per-REQ/per-EVENT/per-connection traffic entries; `info` is reserved for
  infrequent lifecycle events.
- `OPENSEARCH_NODE` - OpenSearch endpoint (default: http://localhost:9200)
- `OPENSEARCH_INDEX` - Index name (default: nostr-events)
- `OPENSEARCH_USERNAME` - OpenSearch username (optional)
- `OPENSEARCH_PASSWORD` - OpenSearch password (optional)
- `RELAY_MAX_LIMIT` - Maximum events returned per REQ filter; enforced by the
  storage clamp and advertised as NIP-11 `max_limit` (default: 1000).
- `RELAY_DEFAULT_LIMIT` - Events returned per REQ filter when `limit` is
  omitted; must not exceed `RELAY_MAX_LIMIT` (default: 100).

## Adding Features

### Performance Optimizations

- Event broadcasting to active subscriptions
- In-memory subscription cache
- Connection pooling for OpenSearch

## Code Style

### Prefer Node.js Builtins

Always use Node.js builtin modules for better portability and compatibility:

- **Use `node:` imports**: Import Node.js builtins using the `node:` protocol
- **Exception**: The WebSocket server in `src/server.ts` uses Bun's native `Bun.serve` 
  with WebSocket support for optimal performance
- **Examples**:
  - ✅ `import { readFile } from "node:fs/promises"` 
  - ✅ `import process from "node:process"`
  - ✅ `import { ServerWebSocket } from "bun"` (WebSocket server only)

This approach ensures most code remains portable while taking advantage of Bun's
excellent WebSocket performance.

## CPU Profiling

Bun supports built-in CPU profiling with markdown output (ideal for LLM analysis).

### Local profiling

```bash
bun --cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp/bun-profiles --cpu-prof-interval=1000 src/server.ts
# Generate load, then stop with Ctrl+C (SIGINT)
# Profile is written to /tmp/bun-profiles/*.md on clean exit
```

The `--cpu-prof-interval` flag sets the sampling interval in microseconds (default 1000 = 1ms).
Use `100` for higher resolution local profiles.

### Production profiling

Create a systemd override to add profiling flags:

```bash
# On the server:
sudo mkdir -p /etc/systemd/system/ditto-relay.service.d
sudo tee /etc/systemd/system/ditto-relay.service.d/cpu-profile.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/home/ditto-relay/.bun/bin/bun --cpu-prof --cpu-prof-md --cpu-prof-dir=/opt/ditto-relay --cpu-prof-interval=1000 src/server.ts
EOF
sudo systemctl daemon-reload
sudo systemctl restart ditto-relay
```

Let the relay run under real traffic for 30-60 seconds, then stop it:

```bash
sudo systemctl stop ditto-relay
# Profile written to /opt/ditto-relay/CPU.*.md
```

Clean up when done:

```bash
sudo rm /etc/systemd/system/ditto-relay.service.d/cpu-profile.conf
sudo systemctl daemon-reload
sudo systemctl start ditto-relay
```

**Important:** The profile is only written when `process.exit()` is called. The
server handles SIGINT/SIGTERM in `src/server.ts` to ensure a clean shutdown.
The `--cpu-prof-dir` must be writable by the service user (`ReadWritePaths` in
the systemd unit restricts this to `/opt/ditto-relay`).

## Verifying Your Changes

After you have made changes, test your code with Bun:

```bash
bun test
```

When writing tests, always use the built-in `node:test` framework.

Always solve problems at their root, eg removing dead code or using proper
types, not just doing a bandaid fix.

Always commit your changes when you're done. Don't ask — just do it.
