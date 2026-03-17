# A3 — All Aboard Aspire 🚂

A real-time train tracker demo showcasing [Aspire 13.2](https://aspire.dev) at AspireConf.

## What's Inside

| Service | Language | Transit System | API Source |
|---------|----------|---------------|------------|
| `api-boston` | Python (FastAPI) | MBTA | [MBTA v3 API](https://api-v3.mbta.com/) |
| `api-nyc` | C# (file-based) | NYC Subway | [MTA Data](https://api.mta.info/) |
| `api-bart` | Go (stdlib) | BART | [BART API](https://api.bart.gov/) |
| `api-advisor` | Python (FastAPI + OpenAI) | All cities | GenAI route advisor |
| `frontend` | TypeScript (Vite + React) | — | UI |

## Aspire Features Demonstrated

- **TypeScript AppHost** — `apphost.ts` orchestrates everything
- **Polyglot support** — Python, C#, Go, TypeScript in one app
- **Redis caching** — shared cache protects upstream API rate limits
- **OpenAI integration** — GenAI route advisor with Aspire hosting
- **Parameters** — API keys as managed secrets
- **OpenTelemetry** — full distributed tracing across all languages
- **MCP / Agent interaction** — AI agents can query the running system
- **Custom dashboard commands** — dev-time testing tools

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
export Parameters__mbta_api_key=your-mbta-key
export Parameters__openai_openai_apikey=your-openai-key

# Start everything
aspire run
```

The Aspire Dashboard opens automatically with all services visible.

### API Keys

- **MBTA**: Free at [api-v3.mbta.com](https://api-v3.mbta.com/)
- **BART**: Uses public demo key (built-in)
- **OpenAI**: Required for the route advisor feature

## Architecture

```
TypeScript AppHost (apphost.ts)
├── Redis (cache)
├── OpenAI (gpt-4o-mini)
├── api-boston (Python/FastAPI) ── MBTA v3 JSON:API
├── api-nyc (C# file-based)   ── MTA subway data
├── api-bart (Go/stdlib)       ── BART legacy API
├── api-advisor (Python/FastAPI + OpenAI)
└── frontend (Vite/React/TS)
```
