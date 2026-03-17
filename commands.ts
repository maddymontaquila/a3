// Custom dashboard commands for the Aspire AppHost

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from 'redis';

const execAsync = promisify(exec);

/**
 * Flush all data from the Redis cache container.
 * Discovers the container's non-TLS port and password dynamically.
 */
export async function flushRedisCache(): Promise<{ success: boolean; errorMessage?: string }> {
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
