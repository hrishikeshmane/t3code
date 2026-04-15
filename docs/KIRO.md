# Kiro ACP Integration — Learnings & Protocol Notes

## Branch Status

**`kiro-acp-rebase`** — Kiro integration using `effect-acp` from PR #1601.

### What Works
- `initialize` with `protocolVersion: 1` — OK
- `authenticate` skipped (kiro uses OIDC, returns "Method not found" for ACP authenticate) — OK
- `session/new` with `mcpServers: []` — OK, returns sessionId + modes + models
- Unknown extension request/notification handlers registered — OK

### What's Broken
- `session/prompt` call fails with "Method not found" at `RpcClient.js:364`
- The error occurs in Effect's RPC client response decoder, NOT in kiro
- Session starts successfully (initialize + session/new), but prompt fails
- Root cause: likely a protocol-level mismatch between `effect-acp`'s `ndJsonRpc` parser and kiro's JSON-RPC responses

### Debug Findings
- Kiro's raw JSON-RPC works perfectly (tested with manual Node.js scripts)
- `{stopReason: "end_turn"}` prompt response is schema-valid
- The error is in the RPC framework's wire-level message parsing
- `handleUnknownExtRequest` fallback doesn't fix it (the error is deeper)

---

## ACP Protocol (JSON-RPC 2.0 over stdin/stdout)

### Spawning
```bash
kiro-cli acp --trust-all-tools
```
- `--trust-all-tools` auto-approves all tool invocations
- Process communicates via newline-delimited JSON-RPC 2.0 on stdin/stdout

### Initialize
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion": 1,
  "clientInfo":{"name":"t3code","version":"1.0.0"},
  "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}
}}
```
- Response: `protocolVersion: 1` (integer), `agentCapabilities`, `authMethods: []`, `agentInfo`
- **NOTE**: kiro returns `protocolVersion: 1` (integer), not a date string

### Authenticate — NOT SUPPORTED
Kiro returns `{code: -32601, message: "Method not found"}` for `authenticate`.
Skip entirely — kiro uses OIDC auth via `~/.toolbox/bin/kiro-cli`.

### session/new — REQUIRES `mcpServers`
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{
  "cwd":"/path/to/project",
  "mcpServers":[]
}}
```
- **CRITICAL**: `mcpServers` field is required. Without it, kiro silently exits.
- Response includes `sessionId`, `modes` (available agents), `models` (available models)

### session/prompt
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
  "sessionId":"<from session/new>",
  "prompt":[{"type":"text","text":"user message"}]
}}
```
- **CRITICAL**: Field name is `prompt`, NOT `content`
- Response: `{"stopReason":"end_turn"}`

### Streaming: session/update
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"...",
  "update":{
    "sessionUpdate":"agent_message_chunk",
    "content":{"type":"text","text":"streamed text"}
  }
}}
```
Notification types via `update.sessionUpdate`:
| sessionUpdate | Description |
|---|---|
| `agent_message_chunk` | Streaming text |
| `tool_call_chunk` | Tool call start |
| `tool_call_update` | Tool status update |
| `plan` | Plan updates |

### session/set_model
```json
{"jsonrpc":"2.0","id":4,"method":"session/set_model","params":{
  "sessionId":"...","model":"claude-opus-4.6"
}}
```

### session/cancel
```json
{"jsonrpc":"2.0","id":5,"method":"session/cancel","params":{
  "sessionId":"..."
}}
```

---

## Kiro-Specific Notifications (`_kiro.dev/*`)

### `_kiro.dev/metadata`
```json
{"method":"_kiro.dev/metadata","params":{
  "sessionId":"...","contextUsagePercentage":25.65
}}
```

### `_kiro.dev/commands/available`
```json
{"method":"_kiro.dev/commands/available","params":{
  "sessionId":"...","commands":[
    {"name":"/agent","description":"Select agents","meta":{"inputType":"selection","optionsMethod":"_kiro.dev/commands/agent/options"}},
    {"name":"/model","description":"Select models","meta":{"inputType":"selection"}},
    {"name":"/usage","description":"Show usage","meta":{"inputType":"panel"}}
  ]
}}
```
- `meta.inputType`: "selection" (picker), "panel" (display), or absent (action)
- `meta.optionsMethod`: TUI-side only — NOT callable over ACP

### `_kiro.dev/subagent/list_update`
```json
{"method":"_kiro.dev/subagent/list_update","params":{
  "subagents":[{
    "sessionId":"sub-1","sessionName":"explore-server",
    "agentName":"codebase-explorer",
    "initialQuery":"List files in apps/server",
    "status":{"type":"working","message":"Running"}
  }],
  "pendingStages":[]
}}
```

### `_kiro.dev/mcp/server_initialized` / `_kiro.dev/mcp/server_init_failure`
MCP server lifecycle notifications. `amzn-mcp` is deprecated and always fails.

---

## Available Models (from session/new response)
- auto, claude-opus-4.6, claude-opus-4.6-1m, claude-sonnet-4.6, claude-sonnet-4.6-1m
- claude-haiku-4.5, deepseek-3.2, kimi-k2.5, minimax-m2.5, minimax-m2.1
- glm-5, qwen3-coder-next, agi-nova-beta-1m, qwen3-coder-480b

## Gotchas
1. **Missing `mcpServers` in session/new** → silent exit with code 0
2. **Using `content` instead of `prompt`** → deserialization error + 3s timeout exit
3. **`authenticate` method** → returns "Method not found" (use OIDC instead)
4. **`notifications/initialized`** → returns "Method not found"
5. **`_kiro.dev/commands/*/options`** → returns "Method not found" (TUI-only)
6. **kiro-cli path**: `~/.toolbox/bin/kiro-cli`, may not be on default PATH
7. **MCP server init**: `amzn-mcp` deprecated; other servers take 2-5s to init
8. **Subagent session/update**: Subagents have different sessionIds — filter main session only
9. **effect-acp compatibility**: `ndJsonRpc` parser has issues decoding kiro's responses during prompt (under investigation)
