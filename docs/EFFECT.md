# Effect.ts in t3code — Patterns, Pitfalls & Debugging Guide

> Practical learnings from building t3code with Effect v4 (beta.43+). Written for contributors and agents.

---

## Effect Version: v4 (breaking changes from v3)

t3code uses **Effect v4** (currently beta.43–beta.45). Many guides and AI training data reference v3 APIs that no longer exist.

### Critical API Changes (v3 → v4)

| v3 (WRONG)            | v4 (CORRECT)           | Notes                                    |
| --------------------- | ---------------------- | ---------------------------------------- |
| `Effect.catchAll`     | `Effect.catch`         | Catches all expected errors              |
| `Effect.catchAllCause`| `Effect.catchCause`    | Catches all causes (expected + defects)  |
| `Effect.catchAllDefect`| `Effect.catchDefect`  | Catches only defects                     |
| `Effect.mapError`     | `Effect.mapError`      | Unchanged                                |
| `Effect.catchTag`     | `Effect.catchTag`      | Unchanged                                |

**If you see `Property 'catchAll' does not exist on type 'typeof Effect'`** → replace with `Effect.catch`.

---

## Effect.sync and Die Defects — Silent Fiber Death

**This is the most dangerous pattern in Effect.** It caused the kiro ndJsonRpc hang.

### The Problem

```ts
// DANGEROUS: If the callback throws, the fiber dies silently
Effect.sync(() => {
  const line = JSON.stringify(event.data).substring(0, 1000); // event.data is undefined!
  fs.appendFileSync("/tmp/log.log", line);
});
```

When `Effect.sync(() => { throw })` executes:
1. The thrown exception becomes a **Die defect** (not an expected error)
2. Die defects propagate up and **kill the fiber**
3. If this fiber is processing stdin messages, **all future messages are lost**
4. Any pending RPC calls waiting for responses **hang forever**

### How to Detect

- RPC calls that never resolve (hang)
- No error logged anywhere (defects bypass `Effect.catch`)
- Wire log shows messages arriving but nothing happening

### How to Fix

1. **Never do risky operations inside `Effect.sync`** — validate data before stringifying
2. **Use `Effect.try` for operations that might throw:**
   ```ts
   Effect.try({
     try: () => JSON.stringify(event.payload).substring(0, 1000),
     catch: (e) => new SomeError({ cause: e }),
   });
   ```
3. **Add `Effect.catchDefect` around critical processing loops** to log defects instead of dying:
   ```ts
   routeDecodedMessage(msg).pipe(
     Effect.catch(() => Effect.void), // catch expected errors
     // Consider Effect.catchDefect for extra safety in stdin loops
   );
   ```

### The Kiro Root Cause (case study)

```ts
// KiroAdapter.ts — protocol logger callback
logger: (event) =>
  Effect.sync(() => {
    // BUG: event.data doesn't exist — AcpProtocolLogEvent has .payload
    const line = `${JSON.stringify(event.data).substring(0, 1000)}\n`;
    //                              ^^^^^^^^^^
    // JSON.stringify(undefined) → JS undefined (not a string)
    // undefined.substring(0, 1000) → TypeError!
    // → Die defect → kills stdin fiber → all RPC calls hang
  }),
```

Fix: `event.data` → `event.payload`. That's it. One property name.

---

## RpcClient — How Effect Matches RPC Responses

### Request ID Flow

1. `generateRequestId` returns a branded `bigint` (starts from `1n`)
2. Each outgoing request gets the next ID: `1n`, `2n`, `3n`, ...
3. Wire format: `{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{...}}`
4. Response arrives: `{"jsonrpc":"2.0","id":1,"result":{...}}`
5. `ndJsonRpc` decoder converts `id` → `String(decoded.id)` → `"1"`
6. `RpcClient` matches by `requestId` to the pending request's `Deferred`

### What Happens When Messages Are Lost

- If the stdin processing fiber dies, responses arrive on the stream but nobody reads them
- The `Deferred` for each pending request never completes → **infinite hang**
- No error, no timeout (unless you add one), no indication of what went wrong

### ndJsonRpc Decode Rules

The compiled `RpcSerialization.js` (`decodeJsonRpcMessage`) maps JSON-RPC 2.0:

| JSON-RPC shape                    | Effect RpcMessage type | id value           |
| --------------------------------- | ---------------------- | ------------------ |
| Has `method` + has `id`           | `Request`              | `String(id)`       |
| Has `method` + no `id`            | `Request` (notification) | `""`             |
| Has `result` + has `id`           | `Exit(Success)`        | `String(id)`       |
| Has `error` + has `id`            | `Exit(Failure)`        | `String(id)`       |
| Has `error.data._tag === "Cause"` | `Exit(Failure)`        | Decoded as Cause   |
| Has `error` without `_tag: Cause` | `Exit(Die)`            | Wrapped as defect  |

**Key insight:** Standard JSON-RPC errors (like `-32601 Method not found`) become `Die` defects in Effect, not expected errors. This means `Effect.catch` won't catch them — you need `Effect.catchDefect` or handle them at the decode level.

---

## Context.Service Pattern

t3code services follow this pattern:

```ts
// Service tag (in Services/ directory)
export class MyService extends Context.Tag("MyService")<MyService, MyServiceShape>() {}

// Implementation (in Layers/ directory)
export const MyServiceLive = Layer.effect(MyService, makeMyService);

// Usage
const svc = yield* MyService; // or yield* Effect.service(MyService)
```

### Effect.fn Pattern (v4)

New in v4, preferred over `function + return Effect.gen`:

```ts
const myFunction = Effect.fn("myFunction")(function* (input: Input) {
  const svc = yield* MyService;
  return yield* svc.doSomething(input);
});
```

With error recovery pipe:

```ts
const myFunction = Effect.fn("myFunction")(
  function* (input: Input) { /* ... */ },
  (effect, input) => Effect.catch(effect, () => Effect.logWarning("Failed", { input })),
);
```

---

## Queue / Stream / Deferred Patterns

### Event Streaming (Provider Adapters)

```ts
// Create unbounded queue for runtime events
const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

// Offer events from callbacks
yield* Queue.offer(eventQueue, event);

// Convert to stream for consumers
streamEvents: Stream.fromQueue(eventQueue),
```

### Deferred for One-Shot Results

```ts
// Wait for a single result
const deferred = yield* Deferred.make<Result, Error>();

// Complete from callback
yield* Deferred.succeed(deferred, result);

// Wait for completion
const result = yield* Deferred.await(deferred);
```

### Fiber Lifecycle

```ts
// Fork a background fiber
const fiber = yield* Effect.fork(backgroundLoop);

// On cleanup, interrupt it
yield* Fiber.interrupt(fiber);
```

**Important:** If a forked fiber dies from a defect, the parent is NOT notified by default. Use `Effect.forkScoped` or explicit defect handling if the fiber is critical.

---

## Debugging Tips

### Wire Logging (Temporary)

For debugging ACP/RPC issues, add temporary wire logging:

```ts
logger: (event) =>
  Effect.sync(() => {
    const line = `${new Date().toISOString()} [${event.direction}] [${event.stage}] ${JSON.stringify(event.payload).substring(0, 1000)}\n`;
    fs.appendFileSync("/tmp/wire.log", line);
  }),
```

**Always remove before committing.** Use `grep -r appendFileSync /tmp` to find stray debug logs.

### Common Hang Patterns

| Symptom | Likely Cause |
| ------- | ------------ |
| RPC call never resolves | Stdin fiber died (check for Die defects in processing loop) |
| "Method not found" from Schema | Schema.Exit decode can't match the response shape |
| Effect.catch doesn't catch | Error is a defect (Die), not an expected error — use Effect.catchDefect |
| Service "not found" in test | Missing `Layer.succeed(Tag, fake)` in test layer |

### Type Errors When Adding Providers

When adding a new provider to t3code, you'll get `Record<BuiltInProviderKind, ...>` type errors. Update ALL of:

1. `packages/contracts/src/orchestration.ts` — `ProviderKind` union
2. `packages/contracts/src/model.ts` — `DEFAULT_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES`
3. `packages/contracts/src/settings.ts` — Settings schema
4. `apps/server/src/provider/Layers/ProviderSessionDirectory.ts` — `decodeProviderKind()` (hardcoded)
5. `apps/server/src/provider/providerStatusCache.ts` — `PROVIDER_CACHE_IDS`
6. `apps/web/src/components/KeybindingsToast.browser.tsx` — test settings
7. `apps/web/src/components/settings/SettingsPanels.tsx` — Record types
8. `apps/web/src/components/chat/ProviderModelPicker.tsx` — provider display
9. `apps/web/src/composerDraftStore.ts` — model selection state
10. `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts` — test layer

---

## ProviderRuntimeEvent Types

Events must use exact type strings from `packages/contracts/src/orchestration.ts`:

```ts
// WRONG
{ type: "token-usage", payload: { usedTokens, maxTokens } }

// CORRECT
{
  type: "thread.token-usage.updated",
  payload: {
    usage: { usedTokens, maxTokens, compactsAutomatically }
  }
}
```

Always check the `ProviderRuntimeEvent` discriminated union in contracts for the exact shape.
