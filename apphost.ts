// A3 — All Aboard Aspire 🚂
// TypeScript AppHost for AspireConf Keynote Demo
// Orchestrates a polyglot train tracker: Python, C#, Go, TypeScript

import { createBuilder } from './.modules/aspire.js';

const builder = await createBuilder();

// ── Infrastructure ─────────────────────────────────────────────────
const cache = builder.addRedis('cache')
  .withCommand('clear-cache', 'Clear Cache', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Delete', description: 'Flush all cached transit data', confirmationMessage: 'Are you sure you want to flush all cached data?' } });

const openai = builder.addOpenAI('openai');
const chatModel = openai.addModel('chat', 'gpt-4o-mini');

// ── Parameters (secrets) ───────────────────────────────────────────
const mbtaApiKey = builder.addParameter('mbta-api-key', { secret: true });

// ── Transit APIs (3 languages!) ────────────────────────────────────

// 🐍 Boston / MBTA — Python (FastAPI + Uvicorn)
const boston = builder.addUvicornApp('api-boston', './api-boston', 'main:app')
  .withUv()
  .withHttpEndpoint({ env: 'PORT' })
  .withReference(cache)
  .withEnvironmentParameter('MBTA_API_KEY', await mbtaApiKey)
  .waitFor(await cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify Boston API is responsive' } });

// 🔷 NYC / MTA — C# file-based minimal API
const nyc = builder.addCSharpApp('api-nyc', './api-nyc/Program.cs')
  .withHttpEndpoint({ env: 'ASPNETCORE_URLS' })
  .withReference(cache)
  .waitFor(await cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify NYC API is responsive' } });

// 🦫 BART / Bay Area — Go (stdlib net/http)
const bart = builder.addExecutable('api-bart', 'go', './api-bart', ['run', '.'])
  .withHttpEndpoint({ env: 'PORT' })
  .withReference(cache)
  .waitFor(await cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify BART API is responsive' } });

// ── GenAI Route Advisor — Python + OpenAI ──────────────────────────
const advisor = builder.addUvicornApp('api-advisor', './api-advisor', 'main:app')
  .withUv()
  .withHttpEndpoint({ env: 'PORT' })
  .withReference(cache)
  .withReference(chatModel)
  .withReference(boston)
  .withReference(nyc)
  .withReference(bart)
  .waitFor(await cache);

// ── Frontend — Vite + React + TypeScript ───────────────────────────
builder.addViteApp('frontend', './frontend')
  .withHttpEndpoint({ env: 'PORT' })
  .withReference(boston)
  .withReference(nyc)
  .withReference(bart)
  .withReference(advisor);

await builder.build().run();