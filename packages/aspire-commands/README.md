# @a3/commands

Reusable TypeScript extensions for Aspire TypeScript apphosts.

This package is authored in TypeScript and published as standard JavaScript plus declarations. It owns its own `aspire.config.json` and runs `aspire restore` before build so it can generate a local `.modules/aspire.ts` surface and derive its command contracts from that generated code.

## Usage

```ts
import { withRedisFlushCommand } from '@a3/commands';

const cache = await builder.addRedis('cache');
await withRedisFlushCommand(cache);
```

## Why This Works

- The package generates its own Aspire TypeScript bindings with `aspire restore`
- The implementation derives its command-facing contracts from those generated bindings instead of hand-authoring them
- The public package still ships normal compiled JavaScript and declarations from `dist`
