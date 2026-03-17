// Custom dashboard commands for the Aspire AppHost

import { createClient } from 'redis';

/**
 * Create a flush command using the Redis resource's URI expression.
 * Resolves the full redis:// URI (with password) from the Aspire resource model.
 */
export function createFlushCommand(redisResource: any) {
  return async (_context: any): Promise<{ success: boolean; errorMessage?: string }> => {
    try {
      const uriExpr = await redisResource.uriExpression.get();
      const uri = await uriExpr.getValue(new AbortController().signal);

      if (!uri) return { success: false, errorMessage: 'Could not resolve Redis URI' };

      const client = createClient({
        url: uri,
        socket: { tls: uri.startsWith('rediss'), rejectUnauthorized: false },
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
