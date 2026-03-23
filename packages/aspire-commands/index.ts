// Custom dashboard commands for the Aspire AppHost

import type {
  CommandOptions,
  ExecuteCommandResult,
  RedisResource,
  WithCommandOptions,
} from './.modules/aspire.js';
import { createClient } from 'redis';

type GeneratedUriValue = Awaited<ReturnType<Awaited<ReturnType<RedisResource['uriExpression']['get']>>['getValue']>>;

type RedisCommandResource = {
  withCommand(
    name: string,
    displayName: string,
    executeCommand: (_arg: unknown) => Promise<ExecuteCommandResult>,
    options?: WithCommandOptions,
  ): unknown;
  uriExpression: {
    get(): Promise<{
      getValue(cancellationToken?: AbortSignal): Promise<GeneratedUriValue>;
    }>;
  };
};

const clearCacheCommandOptions: WithCommandOptions = {
  commandOptions: {
    iconName: 'Delete',
    description: 'Flush all cached transit data',
    confirmationMessage: 'Are you sure you want to flush all cached data?'
  } satisfies CommandOptions,
};

export async function withRedisFlushCommand<T extends RedisCommandResource>(redisResource: T): Promise<T> {
  await redisResource.withCommand('clear-cache', 'Clear Cache', createRedisFlushCommand(redisResource), clearCacheCommandOptions);

  return redisResource;
}

/**
 * Create a flush command using the Redis resource's URI expression.
 * Resolves the full redis:// URI (with password) from the Aspire resource model.
 */
function createRedisFlushCommand(redisResource: RedisCommandResource) {
  return async (): Promise<ExecuteCommandResult> => {
    try {
      const uriExpr = await redisResource.uriExpression.get();
      const uri = await uriExpr.getValue();

      if (!uri) return { success: false, errorMessage: 'Could not resolve Redis URI' };

      const client = createClient({
        url: uri,
        ...(uri.startsWith('rediss')
          ? {
            socket: {
              tls: true as const,
              rejectUnauthorized: false
            }
          }
          : {}),
      });
      await client.connect();
      await client.flushAll();
      await client.quit();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, errorMessage: err instanceof Error ? err.message : String(err) };
    }
  };
}