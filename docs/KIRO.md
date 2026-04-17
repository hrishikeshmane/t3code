# Kiro ACP Integration — Learnings & Protocol Notes

## Branch: `kiro-acp-rebase` (based on PR #1601)

### Current Status: WORKING (resolved 2026-04-15)

Full effect-acp typed RPC integration is operational. initialize, session/new, session/prompt, session/update streaming, and extension notifications all work correctly.

### Root Cause of the ndJsonRpc Hang

**One-line summary:** Protocol logger callback used `event.data` instead of `event.payload`, causing a Die defect that silently killed the stdin processing fiber.

**Details:**

```ts
// KiroAdapter.ts — protocol logger callback (BEFORE fix)
logger: (event) =>
  Effect.sync(() => {
    const line = `${JSON.stringify(event.data).substring(0, 1000)}\n`;
    //                              ^^^^^^^^^^
    // AcpProtocolLogEvent has .payload, NOT .data
    // JSON.stringify(undefined) → JS undefined (not a string)
    // undefined.substring(0, 1000) → TypeError
    // → Die defect inside Effect.sync → kills the fiber
    // → stdin processing stops → all pending RPC calls hang forever
  }),
```

**Fix:** `event.data` → `event.payload`

**Additional fixes needed:**

- `Effect.catchAll` → `Effect.catch` (v3→v4 API change, 3 call sites)
- Event type `"token-usage"` → `"thread.token-usage.updated"` with proper nested payload
- Missing `kiro` in web `Record<BuiltInProviderKind>` types
- Missing `KiroAdapter` in test layer

**See also:** `docs/EFFECT.md` for the full Effect.sync/Die defect explanation and `docs/ACP.md` for the ACP integration guide.

---

## ACP Protocol (JSON-RPC 2.0 over stdin/stdout)

### Spawning

```bash
kiro-cli acp --trust-all-tools
```

### Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": { "name": "t3code", "version": "1.0.0" },
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false
    }
  }
}
```

Response: `protocolVersion: 1` (integer), `agentCapabilities`, `authMethods: []`, `agentInfo`

### Authenticate — NOT SUPPORTED

Returns `{code: -32601, message: "Method not found"}`. Skip entirely.

### session/new — REQUIRES `mcpServers`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/path",
    "mcpServers": []
  }
}
```

Response: `sessionId`, `modes.availableModes`, `models.availableModels`

### session/prompt

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "...",
    "prompt": [{ "type": "text", "text": "message" }]
  }
}
```

Response: `{stopReason: "end_turn"}` — matches ACP `PromptResponse` schema

### Streaming: session/update (notifications, no id)

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "..." }
    }
  }
}
```

### session/set_model / session/cancel

Standard ACP methods, supported.

---

## Kiro Extension Notifications (`_kiro.dev/*`)

All sent as notifications (no `id`), never as requests.

| Method                              | Key Fields                                                |
| ----------------------------------- | --------------------------------------------------------- |
| `_kiro.dev/metadata`                | `contextUsagePercentage` (number)                         |
| `_kiro.dev/commands/available`      | `commands[]` with `name`, `description`, `meta.inputType` |
| `_kiro.dev/subagent/list_update`    | `subagents[]` with `sessionId`, `sessionName`, `status`   |
| `_kiro.dev/mcp/server_initialized`  | `serverName`                                              |
| `_kiro.dev/mcp/server_init_failure` | `serverName`, `error`                                     |

### Command Meta Types

- `inputType: "selection"` — interactive picker (e.g. `/agent`, `/model`, `/prompts`)
- `inputType: "panel"` — display panel (e.g. `/usage`, `/context`, `/help`)
- No `inputType` — action command (e.g. `/clear`, `/compact`)
- `optionsMethod` — TUI-only, NOT callable over ACP

---

## Available Models (from session/new)

auto, claude-opus-4.6, claude-opus-4.6-1m, claude-sonnet-4.6, claude-sonnet-4.6-1m,
claude-haiku-4.5, deepseek-3.2, kimi-k2.5, minimax-m2.5, minimax-m2.1,
glm-5, qwen3-coder-next, agi-nova-beta-1m, qwen3-coder-480b

## Context Window Sizes

| Models                                                                                 | Tokens |
| -------------------------------------------------------------------------------------- | ------ |
| auto, claude-opus-4.6, claude-sonnet-4.6, claude-haiku-4.5                             | 200k   |
| claude-opus-4.6-1m, claude-sonnet-4.6-1m, minimax-m2.5, minimax-m2.1, agi-nova-beta-1m | 1M     |
| deepseek-3.2, kimi-k2.5, glm-5, qwen3-coder-next, qwen3-coder-480b                     | 128k   |

---

## Gotchas

1. Missing `mcpServers` in session/new → silent exit code 0
2. `content` instead of `prompt` in session/prompt → deserialization error + 3s timeout exit
3. `authenticate` method → -32601 Method not found (use OIDC)
4. `notifications/initialized` → -32601 Method not found
5. `_kiro.dev/commands/*/options` → -32601 (TUI-only)
6. kiro-cli binary: `~/.toolbox/bin/kiro-cli`, may not be on PATH
7. MCP server init: `amzn-mcp` deprecated; others take 2-5s
8. Subagent `session/update` has different sessionId — filter by main session
9. `protocolVersion: 1` (integer) in initialize response, not string
10. effect-acp `ndJsonRpc` decode: standard JSON-RPC errors become `Die` defects (no `_tag: "Cause"`)
11. `SessionNotification` schema is strict — unknown `sessionUpdate` types fail decode
