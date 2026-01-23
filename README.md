# Ditto Relay

A high-performance Nostr relay backed by OpenSearch, designed for horizontal
scalability and full-text search capabilities.

## Features

- **OpenSearch Backend**: Scalable, distributed storage with powerful search
  capabilities
- **NIP-01 Compliant**: Proper handling of replaceable and parameterized
  replaceable events
- **NIP-09 Support**: Event deletion with proper authorization
- **NIP-50 Full-Text Search**: Search event content using OpenSearch's powerful
  text analysis
- **Cluster-Ready**: Stateless design works with node:cluster, Cloudflare
  Workers, or Deno --parallel
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
PUBLIC_URL=https://relay.example.com

# OpenSearch
OPENSEARCH_NODE=http://localhost:9200
OPENSEARCH_INDEX=nostr-events
OPENSEARCH_USERNAME=admin
OPENSEARCH_PASSWORD=admin
```

## Running

### Prerequisites

- OpenSearch 2.x or compatible service
- Deno, Node.js, or Bun runtime

### Start the relay

```bash
# Using Deno
deno task start

# Development mode with auto-reload
deno task dev

# Using Node.js
npm start

# Using Bun
bun run src/server.ts
```

### Running in Cluster Mode

The relay is stateless and can be run in cluster mode:

```bash
# Node.js cluster (create a cluster.js file)
# Deno parallel
deno serve --parallel -A --env-file src/server.ts

# Multiple instances behind a load balancer
# Deploy to Cloudflare Workers, etc.
```

## API Endpoints

### POST /event

Submit a Nostr event for storage.

**Request:**

```json
{
  "id": "event-id",
  "pubkey": "author-pubkey",
  "created_at": 1234567890,
  "kind": 1,
  "tags": [["p", "some-pubkey"]],
  "content": "Hello, Nostr!",
  "sig": "signature"
}
```

**Response:**

```json
{
  "ok": true,
  "message": ""
}
```

### POST /req

Query events using Nostr filters.

**Request:**

```json
{
  "subscription_id": "sub-1",
  "filters": [
    {
      "kinds": [1],
      "authors": ["pubkey"],
      "limit": 20
    }
  ]
}
```

**Response:**

```json
{
  "subscription_id": "sub-1",
  "events": [...]
}
```

### GET / (with Accept: application/nostr+json)

Returns NIP-11 relay information document.

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

### Type Checking

```bash
deno check src/server.ts
```

### Linting

```bash
deno lint
```

### Testing

```bash
deno task test
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

MIT
