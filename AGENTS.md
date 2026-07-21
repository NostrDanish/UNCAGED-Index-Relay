# Project Details

## Features

- **NIP-01 Relay**: True WebSocket-based Nostr relay implementation
- **Bun Runtime**: Uses Bun's native WebSocket server for high performance
- **Multi-threaded**: Protocol workers own connections and per-message work;
  the main thread only routes strings between sockets and workers
- **OpenSearch Backend**: Scalable event storage and querying
- **Validation**: Zod and Nostrify for event validation
- **Environment Config**: Type-safe configuration management
- **Portable Code**: Uses Node.js builtins for maximum compatibility (except WebSocket server)

## Architecture

The relay is multi-threaded around one rule: **the main thread only moves
strings**. It never parses, validates, serializes, or queries.

```
                     ┌─ protocol worker 0..N-1 (protocol-worker.ts)
 Bun.serve (main)    │    per-conn state: subs, auth, negentropy
  upgrade/close ─────┤    parse + zod + verify/analyze (inline)
  raw msg strings ──►│    OpenSearch reads (own read client)
  frame strings ◄────┤    broadcast matching + frame building
  ws.send only       │         │ MessageChannel (writes)
                     └─────────▼
                      indexer worker (indexer-worker.ts)
                        bulk queue/flush, phase-2 slot resolution,
                        dirty tracking → background stats worker
```

- **Main thread** (`server.ts` + `protocol-pool.ts`): HTTP endpoints
  (NIP-11 cached as a string, /metrics aggregation), WebSocket upgrade,
  sticky least-connections assignment of connections to protocol workers,
  batched string forwarding in both directions, accepted-event fan-out to
  sibling workers, worker supervision (a dead worker's connections are
  closed with 1011 and the slot respawns; clients reconnect).
- **Protocol workers** (`protocol-worker.ts`): a full `Relay` instance each.
  All per-message CPU lives here, including inline signature verification
  and language/sentiment/media analysis (`analyze.ts`) — no extra thread
  hop per EVENT.
- **Indexer worker** (`indexer-worker.ts`): the single owner of OpenSearch
  writes. Protocol workers RPC to it over dedicated MessageChannel ports
  (`indexer-client.ts`), bypassing the main thread; bulk batches stay
  coalesced and replaceable-slot resolution has one writer. `event()`
  resolves on bulk-flush confirmation, so OK responses reflect durability.
- **Background stats worker** (`background-worker.ts`): score
  recomputation, NIP-85, trends. Fed dirty references by the indexer via
  main; its published events are injected into all protocol workers for
  broadcast.
- **In-process fallback** (`PROTOCOL_WORKERS=0`): the full relay on the
  main thread with the analyze worker pool (`analyze-pool.ts` +
  `analyze-worker.ts`) — the pre-worker architecture, kept as a rollback
  path and for lightweight deployments.

The seam that makes this work is `RelayConn` (relay.ts): the Relay only
sees `{id, data, send(frame)}` and emits finished NIP-01 frames as strings.
Strings cross thread boundaries as flat copies — no object-graph clones on
the hot path.

## Project Structure

```
.
├── src/
│   ├── server.ts           # Entry point: Bun.serve, HTTP, mode wiring (Bun-specific)
│   ├── protocol-pool.ts    # Main-thread bridge: worker spawn/routing/fan-out/supervision
│   ├── protocol-pool.test.ts # Pool integration tests (real workers, mock OpenSearch)
│   ├── protocol-worker.ts  # Protocol worker: connections + all per-message work
│   ├── indexer-worker.ts   # Indexer worker: single owner of OpenSearch writes
│   ├── indexer-client.ts   # Write-RPC client + port protocol (used in protocol workers)
│   ├── relay.ts            # Relay implementation (event handling, subscriptions)
│   ├── relay.test.ts       # Relay tests
│   ├── opensearch.ts       # OpenSearch backend (storage, querying, NIP-50)
│   ├── opensearch.test.ts  # OpenSearch tests
│   ├── config.ts           # Configuration management
│   ├── config.test.ts      # Configuration tests
│   ├── analyze.ts          # Shared analyzer: verify, language, sentiment, media
│   ├── analyze-pool.ts     # Worker pool for analysis (in-process fallback mode only)
│   ├── analyze-pool.test.ts # Analysis pool tests
│   ├── analyze-worker.ts   # Batching worker shell around analyze.ts
│   ├── background-worker.ts # Stats/NIP-85/trends worker
│   ├── log.ts              # Structured JSON logging (one-line entries, Loki-queryable)
│   ├── log.test.ts         # Logging tests
│   ├── metrics.ts          # Prometheus metrics + multi-thread exposition merging
│   ├── metrics.test.ts     # Metrics merging tests
│   ├── media.ts            # Media/video detection from imeta tags and URLs
│   ├── negentropy.ts       # NIP-77 Negentropy protocol codec (set reconciliation)
│   ├── negentropy.test.ts  # Negentropy tests
│   ├── pow.ts              # NIP-13 proof-of-work difficulty calculation
│   ├── pow.test.ts         # Proof-of-work tests
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
│   ├── backfill-pow.ts            # Backfill pow field (NIP-13 difficulty) for existing events
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
- `PROTOCOL_WORKERS` - Number of protocol worker threads. Unset = auto
  (`max(1, min(16, floor(cores / 4)))`); `0` = in-process fallback (full
  relay on the main thread with the analyze worker pool).

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
