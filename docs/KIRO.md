# Kiro ACP Integration — Learnings & Protocol Notes

## Branch: `kiro-acp-rebase` (based on PR #1601)

### Current Status: Session starts, prompt decode fails

**What Works:**
- `initialize` with `protocolVersion: 1` — decodes OK
- `authenticate` skipped (kiro returns -32601, authMethodId made optional)
- `session/new` with `mcpServers: []` — decodes OK, returns sessionId + modes + models
- Unknown extension request/notification handlers registered
- No requests from kiro to client during session init (confirmed)
- `session/update` notifications are pure notifications (no `id` field)

**What Fails:**
- `acp.prompt()` is never reached — error happens in ProviderService routing layer
- Error: "Method not found" at `SchemaTransformation.js:763` → `RpcClient.js:364`
- Stack: `sendTurn (ProviderCommandReactor)` → `sendTurn (ProviderService)` → crash

### Root Cause Investigation (via bp-ctx + effect source)

**How Effect's ndJsonRpc parser works:**
- Messages with `method` field → `Request` (id="" for notifications, id=N for requests)
- Messages with `error` field → `Exit` with `Failure` (`Die` defect if error lacks `_tag: "Cause"`)
- Messages with `result` field → `Exit` with `Success`
- Messages with `chunk: true` → `Chunk` (streaming)

**How RpcClient decode works (RpcClient.ts ~line 733):**
- Each RPC call creates a `Schema.Exit({success, failure, defect})` decode schema
- Response from queue is decoded against this schema
- If decode fails → `ParseError` → `.orDie` → unrecoverable defect
- "Method not found" is Schema's internal error for no matching transformation branch

**What "Method not found" really means here:**
- NOT a JSON-RPC error from kiro
- NOT a missing handler
- It's Effect Schema's decode failure when `Schema.Exit` transformation can't match the response

**Remaining mystery:** WHY does decode fail if:
- `initialize` response decodes OK
- `session/new` response decodes OK
- `prompt()` is never called (wire log confirms)
- kiro sends no requests to client during init

**Hypothesis:** Something in the ProviderService `sendTurn` → `resolveRoutableSession` path triggers a secondary ACP call (like session recovery) that fails. Or the error is in the notification stream processing, not the prompt path.

---

## ACP Protocol (JSON-RPC 2.0 over stdin/stdout)

### Spawning
```bash
kiro-cli acp --trust-all-tools
```

### Initialize
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion": 1,
  "clientInfo":{"name":"t3code","version":"1.0.0"},
  "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}
}}
```
Response: `protocolVersion: 1` (integer), `agentCapabilities`, `authMethods: []`, `agentInfo`

### Authenticate — NOT SUPPORTED
Returns `{code: -32601, message: "Method not found"}`. Skip entirely.

### session/new — REQUIRES `mcpServers`
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{
  "cwd":"/path","mcpServers":[]
}}
```
Response: `sessionId`, `modes.availableModes`, `models.availableModels`

### session/prompt
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
  "sessionId":"...","prompt":[{"type":"text","text":"message"}]
}}
```
Response: `{stopReason: "end_turn"}` — matches ACP `PromptResponse` schema

### Streaming: session/update (notifications, no id)
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}
}}
```

### session/set_model / session/cancel
Standard ACP methods, supported.

---

## Kiro Extension Notifications (`_kiro.dev/*`)

All sent as notifications (no `id`), never as requests.

| Method | Key Fields |
|---|---|
| `_kiro.dev/metadata` | `contextUsagePercentage` (number) |
| `_kiro.dev/commands/available` | `commands[]` with `name`, `description`, `meta.inputType` |
| `_kiro.dev/subagent/list_update` | `subagents[]` with `sessionId`, `sessionName`, `status` |
| `_kiro.dev/mcp/server_initialized` | `serverName` |
| `_kiro.dev/mcp/server_init_failure` | `serverName`, `error` |

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
| Models | Tokens |
|---|---|
| auto, claude-opus-4.6, claude-sonnet-4.6, claude-haiku-4.5 | 200k |
| claude-opus-4.6-1m, claude-sonnet-4.6-1m, minimax-m2.5, minimax-m2.1, agi-nova-beta-1m | 1M |
| deepseek-3.2, kimi-k2.5, glm-5, qwen3-coder-next, qwen3-coder-480b | 128k |

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
