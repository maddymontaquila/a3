// A3 — All Aboard Aspire 🚂
// TypeScript AppHost for AspireConf Keynote Demo
// Orchestrates a polyglot train tracker: Python, C#, Go, TypeScript

import { createBuilder } from './.modules/aspire.js';

const builder = await createBuilder();

// ── Infrastructure ─────────────────────────────────────────────────
const cache = await builder.addRedis('cache')
  .withCommand('clear-cache', 'Clear Cache', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Delete', description: 'Flush all cached transit data', confirmationMessage: 'Are you sure you want to flush all cached data?' } });

const openai = await builder.addOpenAI('openai');
const chatModel = await openai.addModel('chat', 'gpt-4o-mini');

// ── Parameters (secrets) ───────────────────────────────────────────
const mbtaApiKey = await builder.addParameter('mbta-api-key', { secret: true });

// ── Transit APIs (3 languages!) ────────────────────────────────────

// 🐍 Boston / MBTA — Python (FastAPI + Uvicorn)
const boston = await builder.addUvicornApp('api-boston', './api-boston', 'main:app')
  .withUv()
  .withHttpEndpoint({ name: 'api', env: 'PORT' })
  .withReference(cache)
  .withEnvironmentParameter('MBTA_API_KEY', mbtaApiKey)
  .waitFor(cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify Boston API is responsive' } });

// 🔷 NYC / MTA — C# file-based minimal API
const nyc = await builder.addCSharpApp('api-nyc', './api-nyc/Program.cs')
  .withHttpEndpoint({ name: 'api', env: 'ASPNETCORE_URLS' })
  .withReference(cache)
  .waitFor(cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify NYC API is responsive' } });

// 🦫 BART / Bay Area — Go (stdlib net/http)
const bart = await builder.addExecutable('api-bart', 'go', './api-bart', ['run', '.'])
  .withHttpEndpoint({ name: 'api', env: 'PORT' })
  .withReference(cache)
  .waitFor(cache)
  .withCommand('health-check', 'Health Check', async (_context) => {
    return { success: true };
  }, { commandOptions: { iconName: 'Heart', description: 'Verify BART API is responsive' } });

// ── GenAI Route Advisor — Python + OpenAI ──────────────────────────
const bostonEndpoint = await boston.getEndpoint('api');
const nycEndpoint = await nyc.getEndpoint('api');
const bartEndpoint = await bart.getEndpoint('api');

const advisor = await builder.addUvicornApp('api-advisor', './api-advisor', 'main:app')
  .withUv()
  .withHttpEndpoint({ name: 'api', env: 'PORT' })
  .withReference(cache)
  .withReference(chatModel)
  .withEnvironmentEndpoint('services__api-boston__http__0', bostonEndpoint)
  .withEnvironmentEndpoint('services__api-nyc__http__0', nycEndpoint)
  .withEnvironmentEndpoint('services__api-bart__http__0', bartEndpoint)
  .waitFor(cache);

// ── Frontend — Vite + React + TypeScript ───────────────────────────
const advisorEndpoint = await advisor.getEndpoint('api');

await builder.addViteApp('frontend', './frontend')
  .withHttpEndpoint({ name: 'app', env: 'PORT' })
  .withEnvironmentEndpoint('services__api-boston__http__0', bostonEndpoint)
  .withEnvironmentEndpoint('services__api-nyc__http__0', nycEndpoint)
  .withEnvironmentEndpoint('services__api-bart__http__0', bartEndpoint)
  .withEnvironmentEndpoint('services__api-advisor__http__0', advisorEndpoint);

await builder.build().run();