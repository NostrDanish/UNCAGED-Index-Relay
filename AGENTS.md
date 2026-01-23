# Project Details

## Features

- **Polymorphic Runtime**: Works with Node.js, Deno, and Bun
- **Hono**: Fast, lightweight web framework
- **CORS**: Enabled by default
- **Validation**: Zod for schema validation
- **Environment Config**: Type-safe configuration management
- **Portable Code**: Uses Node.js builtins for maximum compatibility

## Project Structure

```
.
├── src/
│   ├── server.ts    # Main application server
│   └── config.ts    # Configuration management
├── package.json     # Dependencies and scripts
├── .env.example     # Example environment variables
├── .gitignore       # Git ignore rules
└── README.md        # Project documentation
```

## Configuration

Edit `.env` to configure the application:

- `PORT` - Server port (default: 8000)
- `PUBLIC_URL` - URL of the public server, eg `https://example.com`

## Adding Features

### Database

To add database support, consider:

- [Kysely](https://kysely.dev/) for SQL query building
- [postgres](https://www.npmjs.com/package/postgres) for PostgreSQL

### Authentication

Consider adding Nostr NIP-98 authentication

## Code Style

### Prefer Node.js Builtins

Always use Node.js builtin modules instead of Bun or Deno globals for better
portability and compatibility:

- **Use `node:` imports**: Import Node.js builtins using the `node:` protocol
- **Avoid Deno globals**: Never use Deno or Bun-specific APIs like
  `Deno.readFile`, `Bun.file`, etc.
- **Examples**:
  - ✅ `import { readFile } from "node:fs/promises"` instead of
    `Deno.readFile()`
  - ✅ `import process from "node:process"` instead of `Deno.env`

This approach ensures code remains portable and works across different
JavaScript runtimes.

## Verifying Your Changes

After you have made changes, verify your code works across runtimes. Prefer
using Deno tooling when available:

```bash
deno lint
deno check .  # Type checking
deno task test
```

When writing tests, always use the built-in `node:test` framework.

Always solve problems at their root, eg removing dead code or using proper
types, not just doing a bandaid fix.
