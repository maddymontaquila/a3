// A3 — All Aboard Aspire 🚂
// TypeScript AppHost for AspireConf Keynote
// Orchestrates a polyglot train tracker: Python, C#, Go, TypeScript

import { ContainerLifetime, createBuilder } from './.modules/aspire.js';
import { createFlushCommand } from './commands.js';

const builder = await createBuilder();

// ── Infrastructure ─────────────────────────────────────────────────
const cache = await builder.addRedis('cache')
  .withLifetime(ContainerLifetime.Persistent);

await cache.withCommand('clear-cache', 'Clear Cache', createFlushCommand(cache), {
  commandOptions: { 
    iconName: 'Delete', 
    description: 'Flush all cached transit data', 
    confirmationMessage: 'Are you sure you want to flush all cached data?' 
  }
});

const openai = await builder.addOpenAI('openai');
const chatModel = await openai.addModel('chat', 'gpt-4o-mini');

// ── Parameters (secrets) ───────────────────────────────────────────
const mbtaApiKey = await builder
  .addParameter('mbta-api-key', { secret: true })
  .withDescription(
    'Register for an MBTA developer account and request an API key at [mbta.com/developers/v3-api](https://www.mbta.com/developers/v3-api).',
    { enableMarkdown: true }
  );

// ── Transit APIs (3 languages!) ────────────────────────────────────

// 🐍 Boston / MBTA — Python (FastAPI + Uvicorn)
const boston = await builder.addUvicornApp('api-boston', './api-boston', 'main:app')
  .withUv()
  .withReference(cache)
  .withEnvironmentParameter('MBTA_API_KEY', mbtaApiKey)
  .waitFor(cache);

// 🔷 NYC / MTA — C# file-based minimal API
const nyc = await builder.addCSharpApp('api-nyc', './api-nyc/api-nyc.cs')
  .withReference(cache)
  .waitFor(cache);

// 🦫 BART / Bay Area — Go (stdlib net/http)
const bart = await builder.addExecutable('api-bart', 'go', './api-bart', ['run', '.'])
  .withHttpEndpoint({ env: 'PORT' })
  .withDeveloperCertificateTrust(true)
  .withOtlpExporter()
  .withReference(cache)
  .waitFor(cache);

const bostonEndpoint = await boston.getEndpoint('http');
const nycEndpoint = await nyc.getEndpoint('https');
const bartEndpoint = await bart.getEndpoint('http');

// ── GenAI Route Advisor — Python + OpenAI ──────────────────────────
const advisor = await builder.addUvicornApp('api-advisor', './api-advisor', 'main:app')
  .withUv()
  .withReference(cache)
  .withReference(chatModel)
  .withEnvironment('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true')
  .withReference(boston)
  .withReference(nyc)
  .withEnvironment('services__api-bart__http__0', bartEndpoint)
  .waitFor(cache);

// ── Frontend — Vite + React + TypeScript ───────────────────────────
const advisorEndpoint = await advisor.getEndpoint('http');

await builder.addViteApp('frontend', './frontend')
  .withHttpsEndpoint({ env: 'PORT', port: 5173 })
  .withHttpsDeveloperCertificate()
  .withReference(boston)
  .withReference(nyc)
  .withReference(advisor)
  .withEnvironment('services__api-bart__http__0', bartEndpoint);

await builder.build().run();