# Kiro Provider Patch — Maintenance Guide

This repo (`hrishikeshmane/t3code`) is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) with the Kiro ACP provider added on top.

## Critical Upstream Dependency: PR #1601

**[pingdotgg/t3code#1601](https://github.com/pingdotgg/t3code/pull/1601)** (`t3code/acp-server-registry`) adds the foundational ACP infrastructure that our Kiro provider builds on:

- `packages/effect-acp` — typed JSON-RPC 2.0 client/server over stdin/stdout
- `AcpSessionRuntime` — manages ACP child process lifecycle
- `CursorAdapter` / `CursorProvider` — Cursor ACP provider (first ACP consumer)
- `AcpAgentRegistry` / `AcpRegistryClient` — agent server discovery
- `AcpAdapter` — generic ACP adapter base

**Before PR #1601 lands:** Syncing with upstream will have heavy conflicts because our fork carries all of this ACP code. Expect conflicts in `server.ts`, `ProviderRegistry.ts`, `server.test.ts`, and the entire `provider/acp/` directory.

**After PR #1601 lands:** Syncing becomes much cleaner. The ACP infrastructure will already exist upstream, and only the Kiro-specific files (KiroAdapter, KiroProvider, web UI changes) will be our unique diff. The first sync after #1601 lands may still have conflicts where our beta.45 fixes overlap with their merged code — resolve by keeping whichever version matches the Effect version upstream is using.

## Repository Layout

```
origin      → https://github.com/hrishikeshmane/t3code.git   (your fork, push target)
upstream    → https://github.com/pingdotgg/t3code.git        (source of truth)
t3code-dev  → /Users/ihrishi/personal/t3code                 (local working copy)
```

## Syncing with Upstream

When `pingdotgg/t3code` has new changes you want to pull in:

### Option A: Merge (preserves history, safer)

```bash
cd /Users/ihrishi/personal/t3code-kiro
git fetch upstream
git merge upstream/main
# Resolve any conflicts
bun install
bun typecheck   # verify nothing broke
bun run dev     # smoke test
git push origin main
```

### Option B: Rebase (cleaner history, riskier)

```bash
cd /Users/ihrishi/personal/t3code-kiro
git fetch upstream
git rebase upstream/main
# Resolve conflicts commit-by-commit
bun install
bun typecheck
bun run dev
git push origin main --force-with-lease
```

**Recommendation:** Use merge unless you have a specific reason to rebase. Merge is safer and doesn't require force-push.

## What Our Patch Adds (97 commits on top of upstream)

32+ files changed, ~2200 lines. The patch adds Kiro as a first-class provider using ACP (Agent Communication Protocol) infrastructure.

### Features

- Full ACP lifecycle: initialize, session/new, session/prompt, session/cancel, session/update streaming
- Agent discovery via `kiro-cli agent list` with agent selection persistence
- Agent picker UI in the composer with `/agent` slash command interception
- Dynamic slash command parsing from `_kiro.dev/commands/available` notifications
- Context window usage tracking from `_kiro.dev/metadata` notifications
- Kiro extension notification handlers (`_kiro.dev/*`)
- KiroIcon (purple owl) in model selector and Open In editor picker
- Tests (unit + integration) with mock ACP agent
- `ServerProviderAgent` and `ServerProviderSlashCommand` schemas (reusable by other providers)
- `handleSlashCommand` on `ProviderRegistryEntry` for scalable provider-specific command handling
- `patchSnapshot` on `ManagedServerProvider` for dynamic provider state updates
- `effect-acp` package for typed JSON-RPC 2.0 over stdin/stdout
- Cursor ACP adapter (from PR #1601 infrastructure)
- ACP Agent Registry and Registry Client services
- Effect beta.45 compatibility fixes throughout

### Files Changed (Kiro-specific)

```
packages/contracts/src/orchestration.ts        — "kiro" in ProviderKind union, KiroModelSelection
packages/contracts/src/model.ts                — KiroModelOptions with agent field
packages/contracts/src/settings.ts             — Kiro provider settings
packages/contracts/src/server.ts               — ServerProviderAgent, ServerProviderSlashCommand schemas
packages/contracts/src/editor.ts               — Kiro in EDITORS array
packages/contracts/src/acp.ts                  — ACP agent registry schemas

packages/effect-acp/                           — Typed ACP RPC infrastructure (entire package)

apps/server/src/provider/Services/KiroAdapter.ts     — Service tag
apps/server/src/provider/Services/KiroProvider.ts    — Service tag
apps/server/src/provider/Layers/KiroAdapter.ts       — Full adapter (~880 lines)
apps/server/src/provider/Layers/KiroProvider.ts      — Provider probe, agent discovery
apps/server/src/provider/Layers/CursorAdapter.ts     — Cursor ACP adapter
apps/server/src/provider/Layers/CursorProvider.ts    — Cursor provider probe
apps/server/src/provider/Layers/AcpAdapter.ts        — Generic ACP adapter
apps/server/src/provider/Layers/ProviderAdapterRegistry.ts  — Register adapters
apps/server/src/provider/Layers/ProviderRegistry.ts  — Register providers
apps/server/src/provider/acp/AcpSessionRuntime.ts    — ACP session runtime
apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts — ACP event mapping
apps/server/src/provider/providerStatusCache.ts      — Cache for all providers
apps/server/src/server.ts                            — Wire providers into startup
apps/server/src/serverSettings.ts                    — Include kiro/cursor settings

apps/web/src/components/Icons.tsx                          — KiroIcon SVG
apps/web/src/components/ChatView.tsx                       — Provider slash commands
apps/web/src/components/chat/composerProviderRegistry.tsx  — Agent picker, handleSlashCommand
apps/web/src/components/settings/SettingsPanels.tsx        — Kiro settings panel
apps/web/src/composerDraftStore.ts                         — Agent selection persistence
apps/web/src/store.ts                                      — ModelSelection type guards

docs/ACP.md                                   — ACP protocol reference
docs/EFFECT.md                                — Effect v4 gotchas
docs/KIRO.md                                  — Kiro protocol notes
build-fail.md                                 — Post-merge fix documentation
```

## Likely Conflict Zones When Syncing

When merging upstream changes, conflicts are most likely in:

| File | Why |
|------|-----|
| `packages/contracts/src/orchestration.ts` | ProviderKind union, ModelSelection |
| `apps/server/src/server.ts` | Layer wiring (RuntimeServicesLive chain) |
| `apps/server/src/server.test.ts` | Test layer mock chain |
| `apps/server/src/provider/Layers/ProviderRegistry.ts` | Provider registration |
| `apps/server/src/provider/providerStatusCache.ts` | PROVIDER_CACHE_IDS array |
| `apps/web/src/components/settings/SettingsPanels.tsx` | Provider settings UI |
| `apps/web/src/composerDraftStore.ts` | ModelSelection handling |
| `apps/web/src/store.ts` | normalizeModelSelection |

### Conflict Resolution Checklist

After resolving conflicts, always verify:

1. `"kiro"` is in the `ProviderKind` union (`packages/contracts/src/orchestration.ts`)
2. `"kiro"` is in `PROVIDER_CACHE_IDS` (`apps/server/src/provider/providerStatusCache.ts`)
3. `KiroProvider` is wired in `server.ts` RuntimeServicesLive chain
4. `AcpAgentRegistry` and `AcpRegistryClient` mocks exist in `server.test.ts`
5. `Layer.provideMerge` chain in `server.ts` has <= 20 calls (split if needed)
6. All `Context.Service` classes have key strings: `Context.Service<Self, Shape>()("key")`
7. No `.makeUnsafe()` calls (use `.make()` — beta.45+)
8. `bun typecheck` passes (0 errors across all 9 packages)
9. `bun fmt && bun lint` pass
10. `bun run dev` starts without runtime errors

## Effect Version Notes

This fork runs **Effect v4 beta.45**. Key differences from upstream (which may be on an earlier beta):

| Pattern | Older betas | beta.45+ |
|---------|------------|----------|
| Service tags | `Context.Tag("key")` | `Context.Service<S,T>()("key")` — key is REQUIRED |
| Branded make | `.makeUnsafe(value)` | `.make(value)` — makeUnsafe removed |
| Error handling | `Effect.catchAll` | `Effect.catch` |

If upstream upgrades to beta.45+, many of our compatibility fixes become redundant and can be dropped.

## Kiro ACP Protocol Notes

See `docs/KIRO.md`, `docs/ACP.md`, and `docs/EFFECT.md` for comprehensive protocol documentation.

Key gotchas:
- `kiro-cli acp --trust-all-tools` is the spawn command
- `authenticate` method returns `-32601` (not supported, uses OIDC)
- `mcpServers: []` is required in `session/new` (omitting it causes silent exit)
- `session/update` notifications are the streaming mechanism (no `id` field)
- Turn end is signaled by the RPC response `{stopReason: "end_turn"}`, not a notification
- Agent selection is via `--agent <name>` CLI flag, not an ACP field

## Generating a Standalone Patch File

To extract just the kiro changes as a patch (useful for submitting upstream):

```bash
git diff upstream/main..HEAD -- \
  ':(exclude)build-fail.md' \
  ':(exclude)PATCH.md' \
  ':(exclude)docs/' \
  > kiro-provider.patch
```
