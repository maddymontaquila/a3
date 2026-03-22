// Custom dashboard commands for the Aspire AppHost

import { createClient } from 'redis';
import { ExecuteCommandContext, ExecuteCommandResult, RedisResource } from './.modules/aspire.js';

export async function withRedisFlushCommand(redisResource: RedisResource): Promise<RedisResource> {
  await redisResource.withCommand('clear-cache', 'Clear Cache', createRedisFlushCommand(redisResource), {
    commandOptions: {
      iconName: 'Delete',
      description: 'Flush all cached transit data',
      confirmationMessage: 'Are you sure you want to flush all cached data?'
    }
  });

  return redisResource;
}

/**
 * Create a flush command using the Redis resource's URI expression.
 * Resolves the full redis:// URI (with password) from the Aspire resource model.
 */
function createRedisFlushCommand(redisResource: RedisResource) {
  return async (ctx: ExecuteCommandContext): Promise<ExecuteCommandResult> => {
    try {
      const cancellationToken = await ctx.cancellationToken.get();
      const uriExpr = await redisResource.uriExpression.get();
      const uri = await uriExpr.getValue(cancellationToken);

      if (!uri) return { success: false, errorMessage: 'Could not resolve Redis URI' };

      const client = createClient({
        url: uri,
        ...(uri.startsWith('rediss')
          ? {
            socket: {
              tls: true as const,
              // BUG: https://github.com/microsoft/aspire/issues/15489
              rejectUnauthorized: false
            }
          }
          : {}),
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
