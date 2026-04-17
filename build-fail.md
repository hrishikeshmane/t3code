# Build Failure Analysis: Kiro ACP Branch Merge

Post-merge `bun run dev` failures after merging `kiro-acp-rebase` into main.

## Root Causes

### 1. Missing `ServerSettingsLive` layer in CLI launch chain

**File:** `apps/server/src/cli.ts`
**Symptom:** `Error: Service not found: t3/serverSettings/ServerSettingsService`
**Cause:** `Effect.provide(ServerSettingsLive)` was stripped during merge but the import remained unused.
**Fix:** Re-added `Effect.provide(ServerSettingsLive)` to the `runServerCommand` pipe chain before `Effect.provideService(ServerConfig, config)`.

### 2. Missing `initialSnapshot` in KiroProvider and CursorProvider

**Files:** `apps/server/src/provider/Layers/KiroProvider.ts`, `CursorProvider.ts`
**Symptom:** `TypeError: input.initialSnapshot is not a function`
**Cause:** `makeManagedServerProvider` (added on main) requires an `initialSnapshot` callback. The Kiro and Cursor providers from the merged branch didn't provide it.
**Fix:** Created `makePendingKiroProvider` / `makePendingCursorProvider` functions following the CodexProvider pattern.

### 3. Missing `Context.Service` key strings in RoutingTextGeneration

**File:** `apps/server/src/git/Layers/RoutingTextGeneration.ts`
**Symptom:** `undefined is not a function (near '...yield* CodexTextGen...')`
**Cause:** `ServiceMap.Service` -> `Context.Service` migration dropped the key string argument. In Effect beta.45, `Context.Service<Self, Shape>()` without a key creates a broken service tag.
**Fix:** Added proper key strings to all three internal service classes.

### 4. Missing `Context.Service` key on `AcpSessionRuntime`

**File:** `apps/server/src/provider/acp/AcpSessionRuntime.ts`
**Symptom:** 100+ typecheck errors (`typeof AcpSessionRuntime must have [Symbol.iterator]`, `acp is of type unknown`)
**Cause:** Same Context.Service key-string issue as #3. This single missing key cascaded into errors across KiroAdapter (31), CursorAdapter (23), AcpAdapter (15), and all their tests.
**Fix:** Added key `"t3/provider/acp/AcpSessionRuntime"`.

### 5. `Schema.Brand.makeUnsafe` removed in Effect beta.45

**Files:** 9 source and test files across adapters and runtime events
**Symptom:** `Property 'makeUnsafe' does not exist on type 'brand<Trim, "...">'`
**Cause:** Effect beta.45 removed `.makeUnsafe()` from branded schemas.
**Fix:** Replaced all `.makeUnsafe(` with `.make(` (which validates but is the correct beta.45 API).

### 6. `providerModelsFromSettings` signature changed (4th arg added)

**Files:** `KiroProvider.ts`, `CursorProvider.ts`
**Symptom:** `Expected 4 arguments, but got 3`
**Cause:** Main branch added a `customModelCapabilities` parameter to `providerModelsFromSettings`.
**Fix:** Added `EMPTY_CAPABILITIES` as the 4th argument.

### 7. `Layer.empty.pipe()` chain exceeded 20 `Layer.provideMerge` args

**File:** `apps/server/src/server.ts`
**Symptom:** `Expected 0-20 arguments, but got 21`
**Cause:** Adding AcpAgentRegistry and AcpRegistryClient layers pushed the chain to 21 `Layer.provideMerge` calls.
**Fix:** Split into `CoreServicesLive` (18 layers) then `RuntimeServicesLive = CoreServicesLive.pipe(3 more)`.

### 8. `PROVIDER_CACHE_IDS` missing new providers

**File:** `apps/server/src/provider/providerStatusCache.ts`
**Symptom:** `TypeError: The "path" property must be of type string, got undefined` at runtime during provider refresh
**Cause:** `PROVIDER_CACHE_IDS` only listed `["codex", "claudeAgent"]`. When `persistProvider` called `cachePathByProvider.get(provider.provider)!` for kiro/cursor/acp, the Map returned `undefined`.
**Fix:** Added `"cursor"`, `"kiro"`, `"acp"` to `PROVIDER_CACHE_IDS`.

### 9. `server.test.ts` missing ACP service mocks

**File:** `apps/server/src/server.test.ts`
**Symptom:** 110 errors: `Missing 'AcpAgentRegistry | AcpRegistryClient' in the expected Effect context`
**Cause:** Routes now depend on AcpAgentRegistry and AcpRegistryClient, but the test's `buildAppUnderTest` didn't provide mock layers.
**Fix:** Added `Layer.mock(AcpAgentRegistry)` and `Layer.mock(AcpRegistryClient)` to the test layer chain.

### 10. `ClaudeAdapter.ts` NonNullableUsage type mismatch

**File:** `apps/server/src/provider/Layers/ClaudeAdapter.ts`
**Symptom:** `Argument of type '{ total_tokens; tool_uses; duration_ms }' is not assignable to parameter of type 'NonNullableUsage'`
**Cause:** SDK type narrower than actual runtime data; function immediately casts to `Record<string, unknown>` anyway.
**Fix:** Widened parameter type from `NonNullableUsage | undefined` to `Record<string, unknown> | undefined`.

### 11. `KiroAdapter.integration.test.ts` missing required fields

**File:** `apps/server/src/provider/Layers/KiroAdapter.integration.test.ts`
**Symptom:** `Type is missing properties: slashCommands, skills`
**Cause:** `ServerProvider` schema gained `slashCommands` and `skills` fields on main.
**Fix:** Added `slashCommands: []` and `skills: []` to the test fixture.

### 12. effect-acp beta.45 API changes

**Files:** `packages/effect-acp/src/errors.ts`, `protocol.ts`, `protocol.test.ts`
**Symptom:** `Schema.makeUnsafe` removal, `RpcClient.Protocol.of` signature changes
**Fix:** Updated to beta.45 API equivalents.

## Effect beta.43 -> beta.45 Migration Patterns

| Pattern | beta.43 | beta.45 |
|---------|---------|---------|
| Service tags | `ServiceMap.Service<S,T>()("key")` | `Context.Service<S,T>()("key")` (key REQUIRED) |
| Branded make | `.makeUnsafe(value)` | `.make(value)` |
| Error handling | `Effect.catchAll` | `Effect.catch` |
| Schema make | `Schema.makeUnsafe(schema)` | Removed (use Schema.decode) |

## Key Lesson: Effect.sync Die Defects

`Effect.sync(() => { throw })` creates a Die defect that kills the fiber silently. In stdin processing loops, this means ALL pending RPC calls hang forever. Always validate data before operations inside Effect.sync. Missing Context.Service keys cause exactly this pattern.
