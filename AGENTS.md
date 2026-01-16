# Project Details

## Features

- **Deno**: Modern JavaScript/TypeScript runtime
- **Hono**: Fast, lightweight web framework
- **Request Logging**: Built-in request/response logging with @soapbox/logi
- **CORS**: Enabled by default
- **Validation**: Zod for schema validation
- **Environment Config**: Type-safe configuration management

## Quick Start

### Prerequisites

- [Deno](https://deno.com/) installed

### Installation

1. Clone or copy this template
2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

### Development

Start the development server with auto-reload:

```bash
deno task dev
```

The server will start on `http://localhost:8000` by default.

### Production

Start the production server:

```bash
deno task start
```

### Testing

Run tests:

```bash
deno task test
```

## Project Structure

```
.
├── src/
│   ├── server.ts    # Main application server
│   └── config.ts    # Configuration management
├── deno.json        # Deno configuration and tasks
├── .env.example     # Example environment variables
├── .gitignore       # Git ignore rules
└── README.md        # This file
```

## Available Endpoints

- `GET /` - Welcome message
- `GET /health` - Health check endpoint
- `POST /api/echo` - Example POST endpoint with validation

## Configuration

Edit `.env` to configure the application:

- `PORT` - Server port (default: 13131)
- `PUBLIC_URL` (required) - URL of the public server, eg `https://example.com`

## Adding Features

### Database

To add database support, consider:

- [Kysely](https://kysely.dev/) for SQL query building
- [postgres](https://deno.land/x/postgres) for PostgreSQL

### Authentication

Consider adding:

- JWT authentication
- Nostr NIP-98 authentication

### Additional Middleware

Hono supports many middleware options:

- Rate limiting
- Compression
- Serving static files
- And more

## Package Management

Modern Deno supports all npm packages. Legacy URL imports are no longer
considered best practice. When adding dependencies:

- **Prefer npm packages**: Use `deno add npm:<pkgname>` to add packages from npm
- This creates proper dependency management in `deno.json`
- Avoid legacy URL imports (e.g., `https://deno.land/x/...`) for new code

## Verifying Your Changes

After you have made changes, always run `deno lint`, `deno task check`, and
`deno task test`. Always solve problems at their root, eg removing dead code or
using proper types, not just doing a bandaid fix.

## License

MIT
