# Kiro Provider Patch for t3code

This document describes how to add Kiro (AWS's coding agent) as a provider to t3code. The implementation builds on top of the `effect-acp` typed RPC infrastructure from PR #1601 (Cursor ACP support by Julius).

**Branch:** `kiro-acp-rebase` on [github.com/hrishikeshmane/t3code](https://github.com/hrishikeshmane/t3code)

**Base:** PR #1601 (`t3code/acp-server-registry`) — adds `effect-acp` package, `AcpSessionRuntime`, `CursorAdapter`, and the generic ACP provider infrastructure. Kiro is built entirely on top of this.

**Status:** Working end-to-end. Tested with `kiro-cli acp --trust-all-tools`.

---

## What This Patch Adds

32 files changed, ~2200 lines added. The patch adds Kiro as a first-class provider using the same `effect-acp` infrastructure that Cursor uses.

### Features

- Full ACP lifecycle: initialize, session/new, session/prompt, session/cancel, session/update streaming
- Agent discovery via `kiro-cli agent list` with agent selection persistence
- Agent picker UI in the composer with `/agent` slash command interception
- Dynamic slash command parsing from `_kiro.dev/commands/available` notifications
- Context window usage tracking from `_kiro.dev/metadata` notifications
- Kiro extension notification handlers (`_kiro.dev/*`)
- KiroIcon (purple owl) in model selector and Open In editor picker
- 17 tests (11 unit + 6 integration) with mock ACP agent
- `ServerProviderAgent` and `ServerProviderSlashCommand` schemas (reusable by other providers)
- `handleSlashCommand` on `ProviderRegistryEntry` for scalable provider-specific command handling
- `patchSnapshot` on `ManagedServerProvider` for dynamic provider state updates

### Files Changed (Kiro-specific, on top of PR #1601)

```
packages/contracts/src/orchestration.ts        — Add "kiro" to ProviderKind union
packages/contracts/src/model.ts                — Add KiroModelOptions with agent field
packages/contracts/src/settings.ts             — Add kiro provider settings
packages/contracts/src/server.ts               — Add ServerProviderAgent, ServerProviderSlashCommand schemas
packages/contracts/src/editor.ts               — Add kiro to EDITORS array

packages/effect-acp/src/protocol.ts            — Fix Effect v3→v4 API (catchAll→catch), error resilience

apps/server/src/provider/Services/KiroAdapter.ts     — Service tag
apps/server/src/provider/Services/KiroProvider.ts    — Service tag with patchSlashCommands
apps/server/src/provider/Layers/KiroAdapter.ts       — Full adapter (~880 lines)
apps/server/src/provider/Layers/KiroProvider.ts      — Provider probe, agent discovery (~375 lines)
apps/server/src/provider/Layers/ProviderAdapterRegistry.ts  — Register KiroAdapter
apps/server/src/provider/Layers/ProviderRegistry.ts  — Register KiroProvider
apps/server/src/provider/acp/AcpSessionRuntime.ts    — Remove debug logging
apps/server/src/provider/makeManagedServerProvider.ts — Add patchSnapshot method
apps/server/src/server.ts                            — Wire KiroProvider into startup
apps/server/src/serverSettings.ts                    — Include kiro settings
apps/server/src/git/Layers/RoutingTextGeneration.ts  — Route kiro text generation

apps/web/src/components/Icons.tsx                          — KiroIcon SVG
apps/web/src/components/ChatView.tsx                       — Provider slash commands in / menu
apps/web/src/components/chat/ComposerCommandMenu.tsx       — provider-slash-command item type
apps/web/src/components/chat/ProviderModelPicker.tsx       — KiroIcon in model picker
apps/web/src/components/chat/OpenInPicker.tsx               — Kiro in Open In editor
apps/web/src/components/chat/composerProviderRegistry.tsx  — Agent picker, handleSlashCommand
apps/web/src/components/settings/SettingsPanels.tsx        — Kiro settings panel
apps/web/src/components/KeybindingsToast.browser.tsx       — Kiro in test fixture
apps/web/src/composerDraftStore.ts                         — Agent selection persistence
apps/web/src/modelSelection.ts                             — Kiro model selection
apps/web/src/session-logic.ts                              — Kiro in provider options

apps/server/src/provider/Layers/KiroAdapter.parsing.test.ts      — Unit tests
apps/server/src/provider/Layers/KiroAdapter.integration.test.ts  — Integration tests
apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts  — Updated assertions
apps/server/scripts/kiro-mock-agent.ts                           — Mock ACP agent for tests
```

---

## Prerequisites

1. **PR #1601 merged** — the `effect-acp` package and ACP infrastructure must be in place
2. **`kiro-cli`** installed and authenticated — typically at `~/.toolbox/bin/kiro-cli`
3. **Effect v4** (beta.43+) — the codebase must use `Effect.catch` not `Effect.catchAll`

---

## How to Apply

### Option A: Cherry-pick the kiro commits

The kiro work starts at commit `d67521eb` (first kiro-specific commit on the branch). Everything before that is PR #1601's ACP infrastructure.

```bash
# After PR #1601 is merged into main:
git fetch origin
git checkout main
git pull

# Cherry-pick kiro commits (squash recommended):
git cherry-pick d67521eb..kiro-acp-rebase
```

### Option B: Generate a patch file

```bash
git diff d67521eb..kiro-acp-rebase -- ':(exclude)docs/' > kiro-provider.patch
git apply kiro-provider.patch
```

### Option C: Manual integration

Follow the section-by-section guide below.

---

## Section-by-Section Integration Guide

### 1. Contracts (`packages/contracts/`)

**orchestration.ts** — Add `"kiro"` to the `ProviderKind` union and create `KiroModelSelection`:

```typescript
export const KiroModelSelection = Schema.Struct({
  provider: Schema.Literal("kiro"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(KiroModelOptions),
});
```

**model.ts** — Add `KiroModelOptions` with agent selection:

```typescript
export const KiroModelOptions = Schema.Struct({
  agent: Schema.optional(Schema.String),
});
```

Add kiro to `DEFAULT_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES`, and related maps.

**server.ts** — Add reusable schemas (any provider can use these):

```typescript
export const ServerProviderAgent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(Schema.Struct({ hint: TrimmedNonEmptyString })),
  inputType: Schema.optional(Schema.Literals(["selection", "panel"])),
});
```

Add optional `agents` and `slashCommands` fields to `ServerProvider`.

**editor.ts** — Add `{ id: "kiro", label: "Kiro", command: "kiro", launchStyle: "direct-path" }` to EDITORS.

**settings.ts** — Add kiro provider settings (enabled, binaryPath, customModels).

### 2. Server — KiroAdapter (`apps/server/src/provider/`)

**Services/KiroAdapter.ts** — Service tag:

```typescript
export type KiroAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
export class KiroAdapter extends Context.Tag("KiroAdapter")<KiroAdapter, KiroAdapterShape>() {}
```

**Services/KiroProvider.ts** — Service tag with slash command patching:

```typescript
export interface KiroProviderShape extends ServerProviderShape {
  readonly patchSlashCommands: (
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
}
export class KiroProvider extends Context.Tag("KiroProvider")<KiroProvider, KiroProviderShape>() {}
```

**Layers/KiroAdapter.ts** (~880 lines) — The main adapter. Key aspects:

- Spawns `kiro-cli acp --trust-all-tools [--agent <name>]` via ChildProcessSpawner
- Uses `AcpSessionRuntime` from effect-acp for typed RPC
- Handles kiro extension notifications: `_kiro.dev/metadata`, `_kiro.dev/commands/available`, `_kiro.dev/subagent/list_update`, `_kiro.dev/mcp/*`
- Parses slash commands via `parseKiroSlashCommands()` and patches provider
- Maps context usage percentage to `thread.token-usage.updated` events
- Agent selection via `--agent` CLI flag extracted from `KiroModelSelection.options.agent`

**Layers/KiroProvider.ts** (~375 lines) — Provider probe and agent discovery:

- Runs `kiro-cli --version` for status probe
- Runs `kiro-cli agent list` via `fetchKiroAgents()` for agent discovery
- `parseKiroAgentListOutput()` parses ANSI-escaped agent list output
- Uses `makeManagedServerProvider` with `patchSlashCommands` support
- 14 built-in models (Claude, DeepSeek, Kimi, Qwen, GLM, Minimax, AGI Nova)

**makeManagedServerProvider.ts** — Add `patchSnapshot` method to `ManagedServerProvider`:

```typescript
patchSnapshot: (fn: (current: ServerProvider) => ServerProvider) =>
  Ref.update(snapshotRef, fn).pipe(
    Effect.tap(() => Ref.get(snapshotRef).pipe(
      Effect.flatMap((s) => PubSub.publish(changesPubSub, s))
    )),
  ),
```

This enables dynamic provider state updates (e.g. patching slash commands after session creation).

**Registration** — Wire into `ProviderAdapterRegistry.ts`, `ProviderRegistry.ts`, and `server.ts`.

### 3. effect-acp Protocol Fix

**protocol.ts** — Three changes:

1. `Effect.catchAll` → `Effect.catch` (Effect v4 API)
2. Add `Effect.catch(() => Effect.void)` around `routeDecodedMessage` to prevent one malformed message from killing the stdin fiber
3. Add `Effect.catchTag("AcpProtocolParseError", ...)` for parse error resilience

These are critical — without them, a single unexpected message from the provider kills the stdin processing fiber and all pending RPC calls hang forever. See `docs/EFFECT.md` for the full explanation.

### 4. Web UI (`apps/web/src/`)

**Icons.tsx** — Add `KiroIcon` (purple `#9046FF` rounded square with white owl):

```typescript
export const KiroIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1200 1200" fill="none">
    <rect width="1200" height="1200" rx="260" fill="#9046FF" />
    {/* owl body + eyes paths */}
  </svg>
);
```

**composerProviderRegistry.tsx** — The biggest web change:

- `KiroAgentMenuContent` — radio group for agent selection
- `KiroAgentPicker` — dropdown menu with imperative open ref
- `useKiroAgentChange` — persists agent selection via draft store
- `handleSlashCommand` on kiro registry entry — opens agent picker for `/agent`
- `handleProviderSlashCommand()` export — scalable API for ChatView

**ChatView.tsx** — Read `slashCommands` from selected provider's ServerProvider snapshot, merge with built-in commands, handle `provider-slash-command` selection via `handleProviderSlashCommand()`.

**ComposerCommandMenu.tsx** — Add `provider-slash-command` variant to `ComposerCommandItem` union.

**Other web files** — Add kiro to all `Record<BuiltInProviderKind, ...>` types: SettingsPanels, KeybindingsToast, composerDraftStore, modelSelection, session-logic, ProviderModelPicker, OpenInPicker.

### 5. Tests

**KiroAdapter.parsing.test.ts** — 11 unit tests for `parseKiroSlashCommands` and `parseKiroAgentListOutput`.

**KiroAdapter.integration.test.ts** — 6 integration tests using a mock ACP agent (`scripts/kiro-mock-agent.ts`). Tests full lifecycle: start session, send turn, receive streaming events, stop session, agent flag passing. Uses a redirecting `ChildProcessSpawner` layer to intercept `kiro-cli` spawns and redirect to the mock.

**kiro-mock-agent.ts** — A real effect-acp agent that implements the ACP protocol for testing.

---

## Kiro ACP Protocol Notes

See `docs/KIRO.md`, `docs/ACP.md`, and `docs/EFFECT.md` in the branch for comprehensive protocol documentation.

Key gotchas:

- `kiro-cli acp --trust-all-tools` is the spawn command
- `authenticate` method returns `-32601` (not supported, uses OIDC)
- `mcpServers: []` is required in `session/new` (omitting it causes silent exit)
- `session/update` notifications are the streaming mechanism (no `id` field)
- Turn end is signaled by the RPC response `{stopReason: "end_turn"}`, not a notification
- `_kiro.dev/metadata` sends `contextUsagePercentage` for context window tracking
- `_kiro.dev/commands/available` sends dynamic slash commands after session creation
- Agent selection is via `--agent <name>` CLI flag, not an ACP field
- `kiro-cli agent list` outputs to stderr, not stdout

---

## Design Decisions

1. **effect-acp over raw JSON-RPC** — We built on Julius's typed RPC infrastructure rather than reimplementing manual JSON-RPC. This gives us schema validation, automatic request/response matching, and protocol-level error resilience.

2. **handleSlashCommand on ProviderRegistryEntry** — Instead of DOM querySelector hacks, each provider registers interactive slash command handlers. Scalable to any provider.

3. **patchSnapshot on ManagedServerProvider** — Enables dynamic provider state updates after initial probe. Used for slash commands that arrive via ACP notifications during the session.

4. **ServerProviderAgent/ServerProviderSlashCommand as shared schemas** — Not kiro-specific. Any provider can use these for agent discovery and dynamic commands.

5. **Imperative ref for agent picker** — The picker registers an open callback on mount. The slash command handler calls it without DOM coupling. Proper React pattern for cross-component-tree communication.

6. **Mock ACP agent for tests** — A real effect-acp agent script that speaks the protocol. Tests the full stack including protocol parsing, not just mocked service calls.
