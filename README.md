# Ditto Relay

A high-performance Nostr relay backed by OpenSearch, designed for horizontal
scalability and full-text search capabilities.

## Features

- **True NIP-01 WebSocket Relay**: Implements the full Nostr protocol via WebSocket
- **OpenSearch Backend**: Scalable, distributed storage with powerful search
  capabilities, using a custom fetch-based client for minimal overhead
- **Replaceable Events**: Proper handling of replaceable and addressable
  events, with optional version history preservation
- **NIP-09 Support**: Event deletion with proper authorization
- **NIP-11 Support**: Relay information document
- **NIP-40 Support**: Event expiration
- **NIP-42 Support**: Client authentication, with configurable auth-protected
  kinds (DMs and gift wraps by default)
- **NIP-45 Support**: Event counting (COUNT)
- **NIP-50 Full-Text Search**: Search event content with extensions for
  language, sentiment, media, protocol, client, autocomplete, sort, and
  distinct filtering
- **NIP-62 Support**: Request to Vanish
- **NIP-70 Support**: Protected events
- **NIP-77 Support**: Negentropy set reconciliation for efficient syncing
- **NIP-85 Trusted Assertions**: Publishes signed user, event, and external
  identifier statistics (kinds 30382-30385)
- **Trending Content**: Periodically computes and publishes trending hashtags,
  links, pubkeys, and events as NIP-32 label events
- **Off-Thread Analysis**: Worker pool for signature verification, language
  detection, sentiment analysis, and media detection
- **Background Worker**: Score recomputation, NIP-85 publishing, and trends run
  off-thread so they never block the WebSocket event loop
- **Prometheus Metrics**: Exposed at `/metrics`
- **Bun Runtime**: Fast WebSocket handling with Bun's native WebSocket support
- **Portable Code**: Core logic uses Node.js builtins for maximum compatibility
- **Efficient Tag Indexing**: All tags are indexed for fast queries while
  preserving original event structure
- **Event Validation**: Uses Nostrify's NSchema for robust event validation

## Architecture

### Event Storage

Events are stored in OpenSearch with the following enhancements:

- **tags_map**: A map of tag names to arrays of values for efficient querying
- **Original tags**: Preserved as-is for proper event reconstruction
- **search_text** / **autocomplete_text**: Derived full-text and edge-ngram
  fields powering NIP-50 search and profile autocomplete
- **deleted**: Boolean flag for soft-deletion (NIP-09)
- **replaced**: Whether the event is a historical version superseded by a newer
  replaceable event
- **protocol**: Extracted from proxy tags (NIP-48)
- **client**: NIP-89 client address from `client` tags
- **language**: Detected language (ISO 639-1)
- **sentiment**: Detected sentiment (positive/negative/neutral)
- **media**: Whether the event has media attachments (images, video, audio)
- **video**: Whether all media attachments are video
- **amount_msats**: Zap amount in millisatoshis (kinds 9735 and 8333)
- **metadata**: Parsed profile fields for kind 0 (name, nip05, about)
- **Engagement scores**: `followers`, `engagers`, `comment_cnt`,
  `reaction_cnt`, `repost_cnt`, `quote_cnt`, `zap_cnt`, and
  `zap_amount_msats` (zaps received), maintained by the background worker and
  used for search ranking and NIP-85 assertions

### Replaceable Events (NIP-01)

- **Kind 0, 3**: User metadata and contact lists (single per pubkey)
- **Kinds 10000-19999**: Replaceable events
- **Kinds 30000-39999**: Addressable events (identified by pubkey, kind, and
  d-tag)

When a newer replaceable event is received, the older version is preserved as
history by default rather than deleted. Historical versions are marked with a
`replaced` flag and hidden from normal queries, so standard relay behavior is
unchanged. Clients can retrieve the full version history of a replaceable slot
by querying with filters that target a specific slot (e.g. a single kind +
author, or a single kind + author + `#d` tag for addressable events). Queries
by event ID also return historical versions.

History preservation is controlled by three environment variables:

| Variable | Description | Default |
|---|---|---|
| `HISTORY_ENABLED` | Global on/off switch for history | `true` |
| `HISTORY_KINDS_WHITELIST` | Comma-separated list of kinds to preserve (if set, only these kinds get history) | unset (all kinds) |
| `HISTORY_KINDS_EXCLUDED` | Comma-separated list of kinds to exclude from history (ignored if whitelist is set) | `30382,30383,30384,30385` |

When history is disabled for a kind (or globally), older versions are deleted as
usual.

### Event Deletion (NIP-09)

Kind 5 events can delete:

- Events by ID (using `e` tags)
- Addressable events by coordinate (using `a` tags in format
  `kind:pubkey:d-tag`)

Only the author can delete their own events, with one exception: a gift wrap
(kind 1059) may only be deleted by its p-tagged recipient, never its (ephemeral)
author.

### Request to Vanish (NIP-62)

A kind 62 event targeting this relay (or `ALL_RELAYS`) deletes all events by
the requesting pubkey up to the request's timestamp, including gift wraps
(kind 1059) that p-tag the pubkey.

### Authentication (NIP-42)

The relay sends AUTH challenges lazily, only when a client requests something
that requires authentication. A single connection can authenticate as multiple
pubkeys; each successful AUTH adds to the set.

Kinds listed in `AUTH_KINDS` (default `4,1059` — NIP-04 DMs and NIP-59 gift
wraps) are auth-protected:

- REQ/COUNT filters requesting an auth-protected kind must include `authors`
  or `#p`, and all entries of at least one of those lists must be
  authenticated on the connection. Since filters are conjunctions, this
  supports conversation-scoped queries like
  `{"kinds":[4],"authors":["<me>"],"#p":["<them>"]}` while authenticated as
  either party.
- Filters without explicit kinds silently exclude auth-protected kinds.
- Queries by event ID return auth-protected events only to a party of the
  event (author or p-tagged recipient).
- Live broadcasts of auth-protected events are delivered only to authenticated
  parties.

Publishing NIP-70 protected events (`["-"]` tag) also requires the author to
be authenticated.

### Full-Text Search (NIP-50)

Use the `search` filter parameter to perform full-text search on event content:

```json
{
  "search": "bitcoin lightning"
}
```

#### Search Extensions

The following NIP-50 search extensions are supported:

- `language:<code>` — Filter by detected language (ISO 639-1), e.g. `language:en`
- `sentiment:<value>` — Filter by sentiment: `positive`, `negative`, `neutral`
- `media:true` / `media:false` — Filter by presence of media attachments
- `video:true` / `video:false` — Filter by whether all attachments are video
- `protocol:<value>` — Filter by protocol (NIP-48), e.g. `protocol:activitypub`.
  `protocol:nostr` matches events with no proxy tag.
- `client:<address>` — Filter by NIP-89 client address (the third value of a
  `client` tag), e.g. `client:31990:<pubkey>:ditto`
- `tag:<name>` / `-tag:<name>` — Filter by tag existence: `tag:e` returns only
  events that have at least one `e` tag, `-tag:e` returns only events with no
  `e` tag. Only indexable tag names are considered (single-character names and
  the whitelisted multi-letter names); other names are ignored.
- `autocomplete:true` / `autocomplete:false` — Toggle edge-ngram prefix
  matching (on by default for kind-0-only filters, off otherwise)
- `sort:<mode>` — Sort results: `top`, `hot`, `controversial`, `rising`, `zaps`
- `distinct:author` — Return at most one event per author

Extensions can be combined with each other and with free-text search:

```json
{
  "kinds": [1],
  "search": "bitcoin media:true language:en"
}
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
# Application
PORT=8000
RELAY_URL=wss://relay.example.com/
RELAY_PUBKEY=<hex pubkey>
RELAY_CONTACT=admin@example.com
NOSTR_NSEC=<nsec, signs trends and NIP-85 events>

# OpenSearch
OPENSEARCH_NODE=http://localhost:9200
OPENSEARCH_INDEX=nostr-events
OPENSEARCH_USERNAME=admin
OPENSEARCH_PASSWORD=admin
```

All options:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `13131` |
| `RELAY_URL` | Full WebSocket URL of the relay (required) | — |
| `PUBLIC_URL` | Public HTTP URL, used for icon/banner links | derived from `RELAY_URL` |
| `RELAY_PUBKEY` | Operator pubkey (hex) for NIP-11 | unset |
| `RELAY_CONTACT` | Operator contact for NIP-11 | unset |
| `NOSTR_NSEC` | Relay signing key for trends and NIP-85 events (required) | — |
| `OPENSEARCH_NODE` | OpenSearch endpoint | `http://localhost:9200` |
| `OPENSEARCH_INDEX` | Index name | `nostr-events` |
| `OPENSEARCH_USERNAME` | OpenSearch basic-auth username | unset |
| `OPENSEARCH_PASSWORD` | OpenSearch basic-auth password | unset |
| `AUTH_KINDS` | Kinds requiring NIP-42 AUTH to query | `4,1059` |
| `HISTORY_ENABLED` | Preserve history of replaceable events | `true` |
| `HISTORY_KINDS_WHITELIST` | Only these kinds get history | unset |
| `HISTORY_KINDS_EXCLUDED` | Kinds excluded from history | `30382,30383,30384,30385` |
| `STATS_ENABLED` | Enable background worker (scores, NIP-85, trends) | `true` |
| `TRENDS_INTERVAL_MS` | Interval between trend computations (`0` disables) | `900000` |
| `DITTO_LANGUAGES` | ISO 639-1 codes for per-language trends | unset |
| `REJECTED_KINDS` | Kinds rejected at ingestion | `13,9734,20013,20014,22242,24242,27235` |
| `BANNED_HASHTAGS` | `t` tag values rejected at ingestion | unset |
| `RELAY_MAX_MESSAGE_LENGTH` | Max inbound message size (bytes) | `4000000` |
| `RELAY_MAX_FILTER_VALUES` | Max entries per filter array field | `20000` |
| `RELAY_TAG_VALUE_MAX_COUNT_PER_NAME` | Max indexed values per tag name | `5000` |
| `RELAY_MAX_INFLIGHT_PER_CONN` | Max concurrent EVENTs per connection | `32` |
| `RELAY_NEGENTROPY_MAX_RECORDS` | Max records per NIP-77 sync session | `1000000` |
| `ANALYZE_POOL_SIZE` | Analysis worker threads (`0` = auto) | `0` |
| `ANALYZE_MAX_PENDING` | Max pending analysis requests | `20000` |
| `BULK_MAX_QUEUE` | Max OpenSearch bulk queue size | `5000` |

## Running

### Prerequisites

- OpenSearch 2.x or compatible service
- Bun runtime

### Start the relay

```bash
# Production mode
bun start

# Development mode with auto-reload
bun dev
```

### Running in Cluster Mode

The relay is stateless and can be run in cluster mode by deploying multiple instances
behind a load balancer. All instances share the same OpenSearch cluster.

## Protocol

This relay implements NIP-01 (Basic protocol flow) via WebSocket at `/`.

### Client-to-Relay Messages

- `["EVENT", <event>]` - Submit an event for storage
- `["REQ", <subscription_id>, <filter>, ...]` - Request events and subscribe
- `["CLOSE", <subscription_id>]` - Close a subscription
- `["COUNT", <subscription_id>, <filter>, ...]` - Count matching events (NIP-45)
- `["AUTH", <event>]` - Authenticate with the relay (NIP-42)
- `["NEG-OPEN", <subscription_id>, <filter>, <hex_message>]` - Start a Negentropy sync (NIP-77)
- `["NEG-MSG", <subscription_id>, <hex_message>]` - Continue a Negentropy sync (NIP-77)
- `["NEG-CLOSE", <subscription_id>]` - End a Negentropy sync (NIP-77)

### Relay-to-Client Messages

- `["EVENT", <subscription_id>, <event>]` - Send an event
- `["OK", <event_id>, <true|false>, <message>]` - Event acceptance response
- `["EOSE", <subscription_id>]` - End of stored events
- `["CLOSED", <subscription_id>, <message>]` - Subscription closed
- `["NOTICE", <message>]` - Human-readable notice
- `["COUNT", <subscription_id>, <count>]` - Event count response (NIP-45)
- `["AUTH", <challenge>]` - Authentication challenge (NIP-42)
- `["NEG-MSG", <subscription_id>, <hex_message>]` - Negentropy sync response (NIP-77)
- `["NEG-ERR", <subscription_id>, <reason>]` - Negentropy sync error (NIP-77)

### HTTP Endpoints

- `GET /` — Landing page (or the WebSocket upgrade / NIP-11 document, based on
  headers)
- `GET /` with `Accept: application/nostr+json` — NIP-11 relay information
  document
- `GET /metrics` — Prometheus metrics

## Supported Filters

- `ids`: Event IDs
- `authors`: Author pubkeys
- `kinds`: Event kinds
- `since`: Unix timestamp (inclusive)
- `until`: Unix timestamp (inclusive)
- `limit`: Maximum number of events to return (default 500, max 5000)
- `#<tag>`: Tag queries (e.g., `#p`, `#e`, `#t`)
- `search`: Full-text search on content with extensions (NIP-50)

## Development

```bash
# Run tests
bun test

# Lint (warnings fail CI)
bun run lint

# Type check
bun run typecheck
```

GitLab CI runs lint, test, and typecheck on every push.

Maintenance and backfill scripts live in `scripts/` (see `AGENTS.md` for the
full list).

## Production Deployment

### OpenSearch Setup

For production, use a managed OpenSearch service or set up a cluster:

1. Enable authentication
2. Set up TLS/SSL
3. Configure appropriate shard counts based on expected load
4. Set up monitoring and alerting

### Horizontal Scaling

The relay is designed to scale horizontally:

1. Deploy multiple instances behind a load balancer
2. All instances share the same OpenSearch cluster
3. No shared state between relay instances
4. Can handle high write and read loads

### Performance Tuning

- Adjust `number_of_shards` and `number_of_replicas` in `src/opensearch.ts`
- Tune OpenSearch JVM heap size
- Monitor the `/metrics` endpoint (queue sizes, query durations, overload
  counters) to size the analyze pool and bulk queue

## Supported NIPs

- [x] NIP-01: Basic protocol flow
- [x] NIP-09: Event deletion
- [x] NIP-11: Relay information document
- [x] NIP-40: Expiration timestamp
- [x] NIP-42: Authentication of clients to relays
- [x] NIP-45: Event counting
- [x] NIP-50: Full-text search (with extensions)
- [x] NIP-62: Request to Vanish
- [x] NIP-70: Protected events
- [x] NIP-77: Negentropy syncing
- [x] NIP-85: Trusted assertions (published by the relay)

## License

© Alex Gleason & other Ditto contributors

Ditto is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Ditto is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with Ditto. If not, see <https://www.gnu.org/licenses/>.
