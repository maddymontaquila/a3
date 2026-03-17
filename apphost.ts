// A3 — All Aboard Aspire 🚂
// TypeScript AppHost for AspireConf Keynote
// Orchestrates a polyglot train tracker: Python, C#, Go, TypeScript

import { createBuilder } from './.modules/aspire.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from 'redis';

const execAsync = promisify(exec);

async function flushRedisCache(): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    // Find the Redis container's non-TLS port (6380) mapped to localhost
    const { stdout } = await execAsync(
      `docker ps --filter "name=cache-" --format "{{.Ports}}" | head -1`
    );
    const match = stdout.match(/127\.0\.0\.1:(\d+)->6380\/tcp/);
    if (!match) return { success: false, errorMessage: 'Could not find Redis non-TLS port' };
    const port = parseInt(match[1]);

    // Get password from container env
    const { stdout: nameOut } = await execAsync(
      `docker ps --filter "name=cache-" --format "{{.Names}}" | head -1`
    );
    const { stdout: passOut } = await execAsync(
      `docker exec ${nameOut.trim()} printenv REDIS_PASSWORD`
    );
    const password = passOut.trim();

    // Connect and FLUSHALL
    const client = createClient({ url: `redis://:${password}@127.0.0.1:${port}` });
    await client.connect();
    await client.flushAll();
    await client.quit();
    return { success: true };
  } catch (err: any) {
    return { success: false, errorMessage: err.message ?? String(err) };
  }
}

const builder = await createBuilder();

// ── Infrastructure ─────────────────────────────────────────────────
const cache = await builder.addRedis('cache')
  .withCommand('clear-cache', 'Clear Cache', async (_context) => {
    return await flushRedisCache();
  }, { commandOptions: { iconName: 'Delete', description: 'Flush all cached transit data', confirmationMessage: 'Are you sure you want to flush all cached data?' } });

const openai = await builder.addOpenAI('openai');
const chatModel = await openai.addModel('chat', 'gpt-4o-mini');

// ── Parameters (secrets) ───────────────────────────────────────────
const mbtaApiKey = await builder.addParameter('mbta-api-key', { secret: true });

// ── Transit APIs (3 languages!) ────────────────────────────────────

// 🐍 Boston / MBTA — Python (FastAPI + Uvicorn)
const boston = await builder.addUvicornApp('api-boston', './api-boston', 'main:app')
  .withUv()
  .withReference(cache)
  .withEnvironmentParameter('MBTA_API_KEY', mbtaApiKey)
  .waitFor(cache);

// 🔷 NYC / MTA — C# file-based minimal API
const nyc = await builder.addCSharpApp('api-nyc', './api-nyc/Program.cs')
  .withHttpEndpoint({ env: 'ASPNETCORE_HTTP_PORTS' })
  .withReference(cache)
  .waitFor(cache);

// 🦫 BART / Bay Area — Go (stdlib net/http)
const bart = await builder.addExecutable('api-bart', 'go', './api-bart', ['run', '.'])
  .withHttpEndpoint({ env: 'PORT' })
  .withOtlpExporter()
  .withReference(cache)
  .waitFor(cache);

// ── GenAI Route Advisor — Python + OpenAI ──────────────────────────
// Get auto-created endpoints for service discovery
const bostonEndpoint = await boston.getEndpoint('http');
const nycEndpoint = await nyc.getEndpoint('http');
const bartEndpoint = await bart.getEndpoint('http');

const advisor = await builder.addUvicornApp('api-advisor', './api-advisor', 'main:app')
  .withUv()
  .withReference(cache)
  .withReference(chatModel)
  .withEnvironmentEndpoint('services__api-boston__http__0', bostonEndpoint)
  .withEnvironmentEndpoint('services__api-nyc__http__0', nycEndpoint)
  .withEnvironmentEndpoint('services__api-bart__http__0', bartEndpoint)
  .waitFor(cache);

// ── Frontend — Vite + React + TypeScript ───────────────────────────
await builder.addViteApp('frontend', './frontend')
  .withEnvironment('NODE_TLS_REJECT_UNAUTHORIZED', '0')
  .withEnvironmentEndpoint('services__api-boston__http__0', bostonEndpoint)
  .withEnvironmentEndpoint('services__api-nyc__http__0', nycEndpoint)
  .withEnvironmentEndpoint('services__api-bart__http__0', bartEndpoint);

await builder.build().run();