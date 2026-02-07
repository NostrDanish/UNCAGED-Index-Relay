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
│   ├── server.ts      # WebSocket relay server (Bun-specific)
│   ├── config.ts      # Configuration management
│   ├── opensearch.ts  # OpenSearch client and index setup
│   ├── storage.ts     # Event storage logic
│   └── query.ts       # Event querying logic
├── package.json       # Dependencies and scripts
├── .env.example       # Example environment variables
├── .gitignore         # Git ignore rules
└── README.md          # Project documentation
```

## Configuration

Edit `.env` to configure the application:

- `PORT` - Server port (default: 13131)
- `PUBLIC_URL` - URL of the public server, eg `https://relay.example.com`
- `OPENSEARCH_NODE` - OpenSearch endpoint (default: http://localhost:9200)
- `OPENSEARCH_INDEX` - Index name (default: nostr-events)
- `OPENSEARCH_USERNAME` - OpenSearch username (optional)
- `OPENSEARCH_PASSWORD` - OpenSearch password (optional)

## Adding Features

### Additional NIPs

Consider implementing:

- NIP-42: Authentication of clients to relays
- NIP-40: Expiration timestamp
- NIP-33: Parameterized replaceable events (already supported)

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

## Verifying Your Changes

After you have made changes, test your code with Bun:

```bash
bun test
```

When writing tests, always use the built-in `node:test` framework.

Always solve problems at their root, eg removing dead code or using proper
types, not just doing a bandaid fix.
