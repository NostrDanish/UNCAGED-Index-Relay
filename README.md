# Ditto Relay

A high-performance NIP-01 compliant Nostr relay backed by OpenSearch, designed for horizontal
scalability and full-text search capabilities.

## Features

- **True NIP-01 WebSocket Relay**: Implements the full Nostr protocol via WebSocket
- **OpenSearch Backend**: Scalable, distributed storage with powerful search
  capabilities
- **Replaceable Events**: Proper handling of replaceable and parameterized
  replaceable events, with optional version history preservation
- **NIP-09 Support**: Event deletion with proper authorization
- **NIP-11 Support**: Relay information document
- **NIP-42 Support**: Client authentication
- **NIP-45 Support**: Event counting (COUNT)
- **NIP-50 Full-Text Search**: Search event content with extensions for
  language, sentiment, media, protocol, sort, and distinct filtering
- **NIP-70 Support**: Protected events
- **Off-Thread Analysis**: Worker pool for signature verification, language
  detection, sentiment analysis, and media detection
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
- **deleted**: Boolean flag for soft-deletion (NIP-09)
- **protocol**: Extracted from proxy tags (NIP-48)
- **language**: Detected language (ISO 639-1)
- **sentiment**: Detected sentiment (positive/negative/neutral)
- **media**: Whether the event has media attachments (images, video, audio)
- **video**: Whether all media attachments are video
- **amount_msats**: Zap amount in millisatoshis (kind 9735)
- **replaced**: Whether the event is a historical version superseded by a newer
  replaceable event

### Replaceable Events (NIP-01)

- **Kind 0, 3**: User metadata and contact lists (single per pubkey)
- **Kinds 10000-19999**: Replaceable events
- **Kinds 30000-39999**: Parameterized replaceable events (identified by pubkey,
  kind, and d-tag)

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
- Parameterized events by coordinate (using `a` tags in format
  `kind:pubkey:d-tag`)

Only the author can delete their own events.

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
- `protocol:<value>` — Filter by protocol (NIP-48), e.g. `protocol:activitypub`
- `client:<address>` — Filter by NIP-89 client address (the third value of a
  `client` tag), e.g. `client:31990:<pubkey>:ditto`
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

# OpenSearch
OPENSEARCH_NODE=http://localhost:9200
OPENSEARCH_INDEX=nostr-events
OPENSEARCH_USERNAME=admin
OPENSEARCH_PASSWORD=admin

# History (replaceable event versioning)
HISTORY_ENABLED=true
# HISTORY_KINDS_WHITELIST=0,3,10002
# HISTORY_KINDS_EXCLUDED=30382,30383,30384,30385
```

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

### NIP-11 Relay Information

Send an HTTP GET request to `/` with `Accept: application/nostr+json` header to retrieve
the relay information document.

## Supported Filters

- `ids`: Event IDs (prefix matching)
- `authors`: Author pubkeys (prefix matching)
- `kinds`: Event kinds
- `since`: Unix timestamp (inclusive)
- `until`: Unix timestamp (inclusive)
- `limit`: Maximum number of events to return (max 5000)
- `#<tag>`: Tag queries (e.g., `#p`, `#e`, `#t`)
- `search`: Full-text search on content with extensions (NIP-50)

## Development

### Testing

```bash
bun test
```

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
- Use connection pooling for the OpenSearch client
- Enable caching at the load balancer level

## Supported NIPs

- [x] NIP-01: Basic protocol flow
- [x] NIP-09: Event deletion
- [x] NIP-11: Relay information document
- [x] NIP-42: Authentication of clients to relays
- [x] NIP-45: Event counting
- [x] NIP-50: Full-text search (with extensions)
- [x] NIP-70: Protected events
- [x] NIP-77: Negentropy syncing

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