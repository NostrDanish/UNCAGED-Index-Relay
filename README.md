# Ditto Relay

A high-performance NIP-01 compliant Nostr relay backed by OpenSearch, designed for horizontal
scalability and full-text search capabilities.

## Features

- **True NIP-01 WebSocket Relay**: Implements the full Nostr protocol via WebSocket
- **OpenSearch Backend**: Scalable, distributed storage with powerful search
  capabilities
- **Replaceable Events**: Proper handling of replaceable and parameterized
  replaceable events
- **NIP-09 Support**: Event deletion with proper authorization
- **NIP-11 Support**: Relay information document
- **NIP-50 Full-Text Search**: Search event content using OpenSearch's powerful
  text analysis
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
- **d_tag**: Extracted and indexed separately for parameterized replaceable
  events
- **deleted**: Boolean flag for soft-deletion (NIP-09)

### Replaceable Events (NIP-01)

- **Kind 0, 3**: User metadata and contact lists (single per pubkey)
- **Kinds 10000-19999**: Replaceable events
- **Kinds 30000-39999**: Parameterized replaceable events (identified by pubkey,
  kind, and d-tag)

When a newer replaceable event is received, the older one is automatically
deleted.

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

### Relay-to-Client Messages

- `["EVENT", <subscription_id>, <event>]` - Send an event
- `["OK", <event_id>, <true|false>, <message>]` - Event acceptance response
- `["EOSE", <subscription_id>]` - End of stored events
- `["CLOSED", <subscription_id>, <message>]` - Subscription closed
- `["NOTICE", <message>]` - Human-readable notice

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
- `search`: Full-text search on content (NIP-50)

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
- [x] NIP-50: Full-text search

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