// A3 — All Aboard Aspire 🚂
// TypeScript AppHost for AspireConf Keynote
// Orchestrates a polyglot train tracker: Python, C#, Go, TypeScript

import { ContainerLifetime, createBuilder } from './.modules/aspire.js';
import { withRedisFlushCommand } from './commands.js';

const builder = await createBuilder();

// ── Docker Compose deployment target ───────────────────────────────
// Single compute environment — all resources auto-included
await builder.addDockerComposeEnvironment('compose');

// ── Infrastructure ─────────────────────────────────────────────────
const cache = await builder.addRedis('cache')
  .withLifetime(ContainerLifetime.Persistent);
await withRedisFlushCommand(cache);

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
  .withReference(cache).waitFor(cache)
  .withEnvironment('MBTA_API_KEY', mbtaApiKey);

// 🔷 NYC / MTA — C# file-based minimal API
const nyc = await builder.addCSharpApp('api-nyc', './api-nyc/api-nyc.cs')
  .withReference(cache).waitFor(cache)
  .publishAsDockerFile();

// 🦫 BART / Bay Area — Go (stdlib net/http)
const bart = await builder.addExecutable('api-bart', 'go', './api-bart', ['run', '.'])
  .withHttpEndpoint({ env: 'PORT' })
  .withDeveloperCertificateTrust(true)
  .withOtlpExporter()
  .withReference(cache).waitFor(cache)
  .publishAsDockerFile();

// ── GenAI Route Advisor — Python + OpenAI ──────────────────────────
const advisor = await builder.addUvicornApp('api-advisor', './api-advisor', 'main:app')
  .withUv()
  .withReference(cache).waitFor(cache)
  .withReference(chatModel)
  .withReference(boston)
  .withReference(nyc)
  .withEnvironment('API_BART_HTTP', await bart.getEndpoint('http'))
  .withEnvironment('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');

// ── Frontend — Vite for dev, YARP gateway for prod ─────────────────
const frontend = await builder.addViteApp('frontend', './frontend')
  .withHttpsEndpoint({ env: 'PORT', port: 5174 })
  .withHttpsDeveloperCertificate()
  .withReference(boston)
  .withReference(nyc)
  .withReference(advisor)
  .withEnvironment('API_BART_HTTP', await bart.getEndpoint('http'));
  
const ec = await builder.executionContext.get();
if (!(await ec.isRunMode.get())) {
  const advisorEndpoint = await advisor.getEndpoint('http');
  const bostonEndpoint = await boston.getEndpoint('http');
  const nycEndpoint = await nyc.getEndpoint('http');
  const bartEndpoint = await bart.getEndpoint('http');

  // In production, YARP serves static assets and proxies API routes
  await builder.addYarp('gateway')
    .withStaticFiles()
    .publishWithStaticFiles(frontend)
    .withExternalHttpEndpoints()
    .withHostPort({ port: 8080 })
    .withConfiguration(async (yarp) => {
      (await yarp.addRouteFromEndpoint('/api/boston/{**catch-all}', bostonEndpoint)).withTransformPathRemovePrefix('/api/boston');
      (await yarp.addRouteFromEndpoint('/api/nyc/{**catch-all}', nycEndpoint)).withTransformPathRemovePrefix('/api/nyc');
      (await yarp.addRouteFromEndpoint('/api/bart/{**catch-all}', bartEndpoint)).withTransformPathRemovePrefix('/api/bart');
      (await yarp.addRouteFromEndpoint('/api/advisor/{**catch-all}', advisorEndpoint)).withTransformPathRemovePrefix('/api/advisor');
    });
}
await builder.build().run();
