# A3 — All Aboard Aspire 🚂

A real-time train tracker demo and TypeScript AppHost extension packaging workspace showcasing [Aspire 13.2](https://aspire.dev) at AspireConf.

## Workspace Layout

- `app` contains the TypeScript AppHost and every orchestrated service
- `packages/aspire-commands` is the publishable npm package
- `app/apphost.ts` installs `@a3/commands` as the local consumer of that package

## What's Inside

| Service | Language | Transit System | API Source |
| ------- | -------- | -------------- | ---------- |
| `app/api-boston` | Python (FastAPI) | MBTA | [MBTA v3 API](https://api-v3.mbta.com/) |
| `app/api-nyc` | C# (file-based) | NYC Subway | [MTA Data](https://api.mta.info/) |
| `app/api-bart` | Go (stdlib) | BART | [BART API](https://api.bart.gov/) |
| `app/api-advisor` | Python (FastAPI + OpenAI) | All cities | GenAI route advisor |
| `app/frontend` | TypeScript (Vite + React) | — | UI |

## Aspire Features Demonstrated

- **TypeScript AppHost** — `app/apphost.ts` orchestrates everything
- **Polyglot support** — Python, C#, Go, TypeScript in one app
- **Redis caching** — shared cache protects upstream API rate limits
- **OpenAI integration** — GenAI route advisor with Aspire hosting
- **Parameters** — API keys as managed secrets
- **OpenTelemetry** — full distributed tracing across all languages
- **MCP / Agent interaction** — AI agents can query the running system
- **Custom dashboard commands** — dev-time testing tools
- **TypeScript extension package** — `packages/aspire-commands` shows a reusable AppHost add-on package

## Getting Started

### Prerequisites

- [Aspire CLI](https://aspire.dev/get-started/install-cli/) (13.2+)
- [Node.js](https://nodejs.org/) 20+
- [Python](https://python.org/) 3.11+ with [uv](https://docs.astral.sh/uv/)
- [Go](https://go.dev/) 1.21+
- [.NET SDK](https://dotnet.microsoft.com/) 10.0+
- [Docker](https://docker.com/)

### Run

```bash
# Set your API keys
# Register for an MBTA developer account and request a key at
# https://www.mbta.com/developers/v3-api
export Parameters__mbta_api_key=your-mbta-key
export Parameters__openai_openai_apikey=your-openai-key

# Start everything from the workspace root
npm run start
```

The Aspire Dashboard opens automatically with all services visible.

### API Keys

- **MBTA**: Register for a developer account and request a key at [mbta.com/developers/v3-api](https://www.mbta.com/developers/v3-api)
- **BART**: Uses public demo key (built-in)
- **OpenAI**: Required for the route advisor feature

## Architecture

```text
TypeScript AppHost (app/apphost.ts)
├── Redis (cache)
├── OpenAI (gpt-4o-mini)
├── api-boston (Python/FastAPI) ── MBTA v3 JSON:API
├── api-nyc (C# file-based)   ── MTA subway data
├── api-bart (Go/stdlib)       ── BART legacy API
├── api-advisor (Python/FastAPI + OpenAI)
└── frontend (Vite/React/TS)
```

## Shipping TypeScript AppHost Extensions

The `packages/aspire-commands` folder demonstrates a realistic package shape for reusable Aspire TypeScript AppHost extensions:

- The AppHost imports the extension by package name: `@a3/commands`
- The extension package owns its runtime dependency on `redis`
- The package avoids direct imports from the app's generated `.modules/aspire.ts`
- It compiles to `dist/` and can be published like a normal npm package

The app under `app` proves the install story locally while keeping the published package generic.
