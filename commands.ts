// Custom dashboard commands for the Aspire AppHost

import { createClient } from 'redis';

/**
 * Create a flush command using the Redis resource's connection string.
 */
export function createFlushCommand(redisResource: any) {
  return async (_context: any): Promise<{ success: boolean; errorMessage?: string }> => {
    try {
      const connStrExpr = await redisResource.connectionStringExpression.get();
      const controller = new AbortController();
      const connStr = await connStrExpr.getValue(controller.signal);

      if (!connStr) {
        return { success: false, errorMessage: 'Could not resolve Redis connection string' };
      }

      // Parse the Aspire connection string — may be StackExchange format or URI
      let url: string;
      if (connStr.startsWith('redis://') || connStr.startsWith('rediss://')) {
        url = connStr;
      } else {
        // StackExchange format: host:port,password=xxx,ssl=True
        let host = 'localhost', port = '6379', password = '', ssl = false;
        for (const part of connStr.split(',')) {
          const trimmed = part.trim();
          if (trimmed.includes('=')) {
            const [k, v] = trimmed.split('=', 2);
            if (k.toLowerCase() === 'password') password = v;
            if (k.toLowerCase() === 'ssl' && v.toLowerCase() === 'true') ssl = true;
          } else if (trimmed && !host.includes(':')) {
            const [h, p] = trimmed.split(':');
            host = h; if (p) port = p;
          }
        }
        const scheme = ssl ? 'rediss' : 'redis';
        url = password ? `${scheme}://:${password}@${host}:${port}` : `${scheme}://${host}:${port}`;
      }

      const client = createClient({
        url,
        socket: { tls: url.startsWith('rediss'), rejectUnauthorized: false },
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
