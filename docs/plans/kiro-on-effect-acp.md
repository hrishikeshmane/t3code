# Kiro on effect-acp — Implementation Plan

> Rewrite KiroAdapter to use effect-acp and AcpSessionRuntime from PR #1601

## Architecture Decision

**Standalone adapter (like CursorAdapter)**, NOT a wrapper around generic AcpAdapter.

Rationale:
- CursorAdapter doesn't extend AcpAdapter — it uses AcpSessionRuntime directly
- Kiro has substantial behavioral differences requiring adapter-level customization
- Generic AcpAdapter is for third-party agents via AcpAgentRegistry
- Kiro needs its own ProviderKind to participate in model selection, settings, UI

## Phase 1: Contracts (packages/contracts)

1. Add `"kiro"` to ProviderKind in orchestration.ts
2. Add KiroModelSelection schema
3. Add KiroModelOptions to model.ts
4. Update all per-provider maps (DEFAULT_MODEL_BY_PROVIDER, etc.)
5. Add KiroSettings to settings.ts

## Phase 2: Server Services

6. Create KiroAdapter service definition (Services/KiroAdapter.ts)
7. Create KiroProvider service definition (Services/KiroProvider.ts)
8. Create KiroAcpExtension module (acp/KiroAcpExtension.ts)
9. Implement KiroAdapter layer using AcpSessionRuntime
10. Implement KiroProvider layer (status check)
11. Wire into ProviderAdapterRegistry
12. Wire into ProviderRegistry

## Phase 3: Web UI

13. Add kiro to PROVIDER_OPTIONS in session-logic.ts
14. Add kiro to composerProviderRegistry
15. Add KiroIcon to ProviderModelPicker
16. Update modelSelection.ts
17. Update providerModels.ts
18. Add Kiro settings panel

## Kiro-Specific Extension Handlers

Register via `acp.handleExtNotification()` before `acp.start()`:

- `_kiro.dev/metadata` → context usage percentage
- `_kiro.dev/commands/available` → dynamic slash commands
- `_kiro.dev/subagent/list_update` → subagent tracking
- `_kiro.dev/mcp/server_initialized` → MCP server status
- `_kiro.dev/mcp/server_init_failure` → MCP server errors

## Key: What AcpSessionRuntime Already Handles

- session/new with mcpServers: [] ✓
- session/prompt with prompt field ✓
- session/update parsing (agent_message_chunk, tool_call, etc.) ✓
- Turn completion via RPC response stopReason ✓
- Extension handler registration ✓
- Session lifecycle (initialize, start, close) ✓

## What KiroAdapter Adds

- kiro-cli binary resolution (~/.toolbox/bin/kiro-cli)
- --trust-all-tools flag
- _kiro.dev/* extension notifications
- Context window tracking with real model sizes
- Dynamic slash commands with inputType metadata
- Subagent session ID filtering
- Model switching via session/set_model
- Agent/mode switching via session/set_mode
