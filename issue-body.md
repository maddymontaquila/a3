## Summary

Shipping a reusable npm package that provides helper functions for Aspire TypeScript AppHosts (e.g. a `withRedisFlushCommand()` extension) is currently blocked by two limitations of the TypeScript code generation.

## Problem

### 1. Generated classes are nominally incompatible across AppHosts

Every AppHost that runs `aspire restore` gets its own copy of the generated `.modules/` tree. Generated resource classes like `RedisResource`, `ExecuteCommandContext`, `CancellationToken`, and `ReferenceExpression` contain `private` fields (`_handle`, `_client`, `_signal`, etc.).

In TypeScript, classes with `private` members are **nominally typed** — two structurally identical classes from different files are not assignable to each other. This means a reusable package cannot export a function like:

```ts
// packages/aspire-commands/index.ts
import type { RedisResource } from './.modules/aspire.js';
export function withRedisFlushCommand(redis: RedisResource): Promise<RedisResource> { ... }
```

...and have it accept a `RedisResource` from a *consumer's* AppHost, because:

> `Type 'RedisResource' is not assignable to type 'RedisResource'.`
> `Types have separate declarations of a private property '_handle'.`

**Workaround**: Package authors must hand-author structural type projections that describe only the public surface they need, erasing all nominal class boundaries. This is tedious and fragile.

### 2. `aspire restore` requires a dummy `apphost.ts`

A helper package that only needs generated type definitions (not an actual AppHost) must still create an empty `apphost.ts` file and point `aspire.config.json` at it, because `aspire restore` refuses to run without one. The file can be completely empty, but it must exist.

## Scenario

A monorepo with:
- `app/` — the real AppHost with services
- `packages/aspire-commands/` — a publishable npm package providing reusable Aspire helper functions

The package has its own `aspire.config.json` declaring its Aspire package dependencies (e.g. `Aspire.Hosting.Redis`) and runs `aspire restore` to generate `.modules/` so it can import types. But the generated types can never be directly used in the package's public API because of the nominal typing issue above.

## Suggested improvements

1. **Emit interfaces alongside classes** — For each generated resource class, also emit a corresponding interface (e.g. `IRedisResource`) that describes the full public surface without private members. Package authors could target these interfaces in their public APIs, and any AppHost's concrete `RedisResource` would satisfy the interface structurally.

2. **Support `aspire restore` without an `apphost.ts`** — Allow `aspire restore` (or a new subcommand like `aspire sdk generate-types`) to generate type definitions from `aspire.config.json` alone, without requiring an AppHost entry point. This would make the package authoring experience cleaner.

3. **Consider making generated class fields non-private** — Using ES private fields (`#field`) or removing the TypeScript `private` modifier in favor of a different encapsulation pattern would make the generated classes structurally compatible across separate codegen outputs. (This is a larger change with trade-offs.)

## Environment

- Aspire SDK: 13.2.0
- Aspire CLI: latest
- TypeScript: 5.x
- Platform: npm workspaces monorepo
