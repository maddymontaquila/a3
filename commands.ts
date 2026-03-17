// Custom dashboard commands for the Aspire AppHost

import { createClient } from 'redis';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Create a flush command using the Redis resource's endpoint for host/port
 * and the container's env for the password.
 */
export function createFlushCommand(redisResource: any) {
  return async (_context: any): Promise<{ success: boolean; errorMessage?: string }> => {
    try {
      // Get host/port from the resource's endpoint (resolved at runtime)
      const endpoint = await redisResource.primaryEndpoint.get();
      const host = await endpoint.host.get();
      const port = await endpoint.port.get();

      // Get password from the container env
      const { stdout: nameOut } = await execAsync(
        `docker ps --filter "name=cache-" --format "{{.Names}}" | head -1`
      );
      const containerName = nameOut.trim();
      let password = '';
      if (containerName) {
        const { stdout: passOut } = await execAsync(
          `docker exec ${containerName} printenv REDIS_PASSWORD`
        );
        password = passOut.trim();
      }

      const url = `rediss://:${password}@${host}:${port}`;
      const client = createClient({
        url,
        socket: { rejectUnauthorized: false },
      });
      await client.connect();
      await client.flushAll();
      await client.quit();
      return { success: true };
    } catch (err: any) {
      return { success: false, errorMessage: err.message ?? String(err) };
    }
  };
}
