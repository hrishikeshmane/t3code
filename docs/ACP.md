# ACP (Agent Communication Protocol) in t3code — Integration Guide

> Practical learnings from integrating ACP providers (Kiro, Cursor) via `effect-acp`. Written for contributors and agents.

---

## What is ACP?

ACP is **JSON-RPC 2.0 over stdin/stdout**, used to communicate with coding agent CLIs. Each provider (Kiro, Cursor) speaks the same base protocol with provider-specific extensions.

- **Wire format:** Newline-delimited JSON-RPC 2.0 (no framing, no length prefix)
- **Transport:** stdio (spawn process, write to stdin, read from stdout)
- **Serialization in Effect:** `RpcSerialization.ndJsonRpc()` — handles parsing and encoding

---

## Architecture in t3code

```
ProviderService → ProviderAdapterRegistry → [Provider]Adapter
                                                ↓
                                          AcpSessionRuntime
                                                ↓
                                          effect-acp client (RpcClient)
                                                ↓
                                          [provider]-cli (stdin/stdout)
```

### Key Files

| File | Role |
| ---- | ---- |
| `packages/effect-acp/src/protocol.ts` | Patched protocol layer: bridges Effect RPC with JSON-RPC 2.0 wire format |
| `packages/effect-acp/src/client.ts` | RPC client construction, request ID generation |
| `packages/effect-acp/src/rpc.ts` | RPC method definitions (Rpc.make for each ACP method) |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts` | Session lifecycle: initialize, create session, prompt, cancel |
| `apps/server/src/provider/Layers/KiroAdapter.ts` | Kiro-specific adapter (extension notifications, model mapping) |
| `apps/server/src/provider/Layers/CursorAdapter.ts` | Cursor-specific adapter |

### Protocol Layer (effect-acp/protocol.ts)

The protocol layer does critical work:

1. **Intercepts `session/update` notifications** — routes them to the session's event handler
2. **Handles extension notifications** — `_kiro.dev/*`, etc.
3. **Decodes raw bytes** from stdout into JSON-RPC messages
4. **Routes decoded messages** to Effect's RPC infrastructure

**Key gotcha:** The protocol runs in a fiber processing the stdin stream. If this fiber dies, ALL RPC communication stops (see EFFECT.md for Die defect details).

---

## ACP Lifecycle

### 1. Initialize

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion": 1,
    "clientInfo": {"name":"t3code","version":"1.0.0"},
    "clientCapabilities": {"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}
  }}
← {"jsonrpc":"2.0","id":1,"result":{
    "protocolVersion": 1,
    "agentCapabilities": {...},
    "authMethods": [],
    "agentInfo": {"name":"kiro","version":"..."}
  }}
```

**Note:** `protocolVersion` is an integer (`1`), not a string.

### 2. Authenticate (optional)

- Not all providers support this (Kiro returns `-32601 Method not found`)
- Skip if `authMethods: []` is empty in initialize response
- Made optional in `AcpSessionRuntime` via `options.authMethodId`

### 3. Create Session

```json
→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{
    "cwd": "/path/to/project",
    "mcpServers": []
  }}
← {"jsonrpc":"2.0","id":2,"result":{
    "sessionId": "uuid",
    "modes": {"availableModes": [...]},
    "models": {"availableModels": [...]}
  }}
```

**Critical:** `mcpServers` field is REQUIRED (even if empty array). Omitting it causes Kiro to silently exit with code 0.

### 4. Prompt

```json
→ {"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
    "sessionId": "uuid",
    "prompt": [{"type":"text","text":"hello"}]
  }}
← (streaming session/update notifications arrive here)
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

**Turn end is signaled by the RPC response**, NOT by a notification. The response `{stopReason: "end_turn"}` means the turn is complete.

### 5. Streaming (session/update notifications)

```json
← {"jsonrpc":"2.0","method":"session/update","params":{
    "sessionId": "uuid",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {"type":"text","text":"Hello!"}
    }
  }}
```

These are notifications (no `id` field). They arrive between the prompt request and the prompt response.

**sessionUpdate types:** `agent_message_start`, `agent_message_chunk`, `agent_message_end`, `tool_use_start`, `tool_use_chunk`, `tool_use_end`, `tool_result`, plus provider-specific types.

---

## Provider-Specific Notes

### Kiro (`kiro-cli acp --trust-all-tools`)

**Binary location:** `~/.toolbox/bin/kiro-cli` (may not be on PATH)

**Extension notifications (all `_kiro.dev/*`):**

| Method | Purpose | Key Fields |
| ------ | ------- | ---------- |
| `_kiro.dev/metadata` | Context window usage | `contextUsagePercentage` (number) |
| `_kiro.dev/commands/available` | Available slash commands | `commands[]` with `name`, `description`, `meta.inputType` |
| `_kiro.dev/subagent/list_update` | Subagent status | `subagents[]` with `sessionId`, `status` |
| `_kiro.dev/mcp/server_initialized` | MCP server ready | `serverName` |
| `_kiro.dev/mcp/server_init_failure` | MCP server failed | `serverName`, `error` |

**Models (from session/new):** auto, claude-opus-4.6, claude-opus-4.6-1m, claude-sonnet-4.6, claude-sonnet-4.6-1m, claude-haiku-4.5, deepseek-3.2, kimi-k2.5, minimax-m2.5, minimax-m2.1, glm-5, qwen3-coder-next, qwen3-coder-480b, agi-nova-beta-1m

**Gotchas:**
1. `authenticate` → `-32601` (not supported, uses OIDC)
2. `notifications/initialized` → `-32601` (not supported)
3. `_kiro.dev/commands/*/options` → `-32601` (TUI-only, not callable over ACP)
4. Missing `mcpServers` in session/new → silent exit code 0
5. `content` instead of `prompt` in session/prompt → deserialization error + 3s timeout exit
6. MCP servers take 2-5s to initialize (amzn-mcp deprecated)
7. Subagent `session/update` may have a different sessionId — filter by main session

### Cursor

Uses the same ACP base protocol. See `CursorAdapter.ts` for Cursor-specific handling.

---

## effect-acp Integration Patterns

### AcpProtocolLogEvent Interface

Used for wire logging callbacks. **Properties are:**

```ts
interface AcpProtocolLogEvent {
  direction: "incoming" | "outgoing";
  stage: "raw" | "decoded" | "routed";
  payload: unknown; // NOT "data" — this caused the ndJsonRpc hang
}
```

### Error Handling in Protocol Layer

The protocol layer needs resilience at two levels:

```ts
// Level 1: Parse errors — drop malformed messages, don't crash the loop
Effect.catchTag("AcpProtocolParseError", () => Effect.succeed([] as ReadonlyArray<never>))

// Level 2: Route errors — drop unroutable messages, don't crash the loop
routeDecodedMessage(msg).pipe(Effect.catch(() => Effect.void))
```

**Both are essential.** Without them, a single unexpected message from the provider kills the stdin processing fiber and causes all pending RPC calls to hang.

### Extension Notification Handlers

Register before starting the session:

```ts
yield* acp.handleExtNotification(
  "_kiro.dev/metadata",        // method name
  KiroMetadataNotification,     // Schema for params
  (params) => Effect.gen(function* () {
    // Handle the notification
  }),
);
```

These are registered on `AcpSessionRuntime` and dispatched by the protocol layer when matching notifications arrive.

### JSON-RPC Errors Become Die Defects

Standard JSON-RPC 2.0 error responses (e.g., `-32601 Method not found`) are decoded by Effect's ndJsonRpc as **Die defects**, NOT expected errors:

```ts
// In RpcSerialization.js:
if (decoded.error && decoded.error.data?._tag !== "Cause") {
  return { _tag: "Exit", requestId: String(decoded.id), exit: { _tag: "Die", defect: decoded.error } };
}
```

This means `Effect.catch` won't catch them. For ACP methods that might return JSON-RPC errors (like `session/set_config_option` on providers that don't support it):

```ts
yield* acp.setModel(model).pipe(
  Effect.catch(() => Effect.void), // catches expected errors
  // But JSON-RPC -32601 arrives as a Die defect, bypasses this!
);
```

**Workaround:** The protocol layer intercepts known error patterns, or use `Effect.catchDefect` for methods that might fail with JSON-RPC errors.

---

## Debugging ACP Issues

### Wire Log

Temporarily add to the protocol config:

```ts
protocolOptions: {
  logIncoming: true,
  logOutgoing: true,
  logger: (event) =>
    Effect.sync(() => {
      const line = `${new Date().toISOString()} [${event.direction}] [${event.stage}] ${JSON.stringify(event.payload).substring(0, 1000)}\n`;
      fs.appendFileSync("/tmp/acp-wire.log", line);
    }),
},
```

**Remove before committing.** Check with `grep -r appendFileSync.*tmp`.

### Common Issues

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| RPC hangs forever | Stdin fiber died from defect | Check for Die in Effect.sync callbacks |
| Silent process exit | Missing required field (e.g. `mcpServers`) | Check provider docs for required params |
| "Method not found" from Schema | Response doesn't match `Schema.Exit` | Check if response shape matches RPC definition |
| `-32601` from provider | Provider doesn't support that method | Skip the call, or catch the defect |
| Notifications not arriving | SessionNotification schema too strict | Add `Effect.catch` around notification decode |
| Wrong session events | Subagent uses different sessionId | Filter by main sessionId |

### Verifying the Pipeline

1. **Raw bytes arrive?** Check wire log at `stage: "raw"`
2. **Messages decode?** Check wire log at `stage: "decoded"`
3. **Messages route?** Check if `routeDecodedMessage` succeeds
4. **RPC matches?** Check if `requestId` in response matches pending request
5. **Schema decodes?** Check if `Schema.Exit` can decode the response result

---

## Adding a New ACP Provider

1. Create `apps/server/src/provider/Layers/[Provider]Adapter.ts` (copy from KiroAdapter/CursorAdapter)
2. Create `apps/server/src/provider/Services/[Provider]Adapter.ts` (Context.Tag)
3. Register in `ProviderAdapterRegistry` and `ProviderRegistry`
4. Add to all web Record types (see EFFECT.md § "Type Errors When Adding Providers")
5. Add extension notification handlers for provider-specific notifications
6. Test: spawn the CLI manually first to understand its wire format before integrating
