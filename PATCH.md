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
t3code-dev  → /Users/ihrishi/personal/t3code                 (local working copy, kiro-acp-rebase branch)
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

### Option C: Nuclear Reset + Rebuild (when upstream has diverged too far)

When upstream has changed so much that merging/rebasing is impractical, reset to upstream and re-apply the kiro patch from the reference branch:

```bash
cd /Users/ihrishi/personal/t3code-kiro

# 1. Save current state on a backup branch
git branch backup-$(date +%Y%m%d) main

# 2. Reset to upstream
git fetch upstream
git reset --hard upstream/main

# 3. Re-apply kiro changes using the reference branch as source
#    (see "Rebuild from Reference Branch" section below)
```

## Rebuild from Reference Branch

The reference implementation lives at:

```
https://github.com/hrishikeshmane/t3code  (branch: kiro-acp-rebase)
Local: /Users/ihrishi/personal/t3code     (branch: kiro-acp-rebase, same content)
```

The `kiro-acp-rebase` branch is the original working implementation on Effect beta.43, before the merge into main. It is the canonical source of truth for what the kiro provider should look like.

### For a coding agent (Claude, Codex, etc.)

Give the agent this prompt after resetting to upstream/main:

```
I need you to add the Kiro ACP provider to this t3code codebase. The working
reference implementation is at /Users/ihrishi/personal/t3code on branch
kiro-acp-rebase.

Read these docs first:
- docs/KIRO.md       (protocol notes)
- docs/ACP.md        (integration guide)
- docs/EFFECT.md     (Effect v4 gotchas)
- PATCH.md           (this file — architecture overview)
- build-fail.md      (post-merge fix history — 12 root causes documented)

Then diff the reference branch against upstream to see exactly what was added:

  git fetch origin
  git diff upstream/main..origin/kiro-acp-rebase

Apply those changes to the current codebase, adapting for any API differences
in the current upstream version. The changes fall into these ordered layers:

1. Contracts (packages/contracts/) — schemas and types
2. effect-acp package (packages/effect-acp/) — ACP RPC infrastructure
3. Server provider services and adapters (apps/server/src/provider/)
4. Server wiring (apps/server/src/server.ts, cli.ts, serverSettings.ts)
5. Web UI (apps/web/src/) — icons, settings, composer, model selection
6. Tests

After applying, verify: bun typecheck && bun fmt && bun lint && bun run dev
```

### For manual rebuild

Generate a diff from the reference branch and apply it:

```bash
# Generate the patch from the reference branch:
git fetch origin
git diff upstream/main..origin/kiro-acp-rebase > /tmp/kiro-full.patch

# Apply it to current main:
git apply --3way /tmp/kiro-full.patch
# --3way enables conflict markers for hunks that don't apply cleanly

# Fix conflicts, then verify:
bun install && bun typecheck && bun fmt && bun lint && bun run dev
```

If `git apply --3way` has too many failures, apply file-by-file:

```bash
# Apply only kiro-specific files (skip ACP infra if PR #1601 is already merged):
git diff upstream/main..origin/kiro-acp-rebase -- \
  apps/server/src/provider/Services/KiroAdapter.ts \
  apps/server/src/provider/Services/KiroProvider.ts \
  apps/server/src/provider/Layers/KiroAdapter.ts \
  apps/server/src/provider/Layers/KiroProvider.ts \
  apps/web/src/components/Icons.tsx \
  apps/web/src/components/chat/composerProviderRegistry.tsx \
  apps/web/src/components/settings/SettingsPanels.tsx \
  apps/web/src/composerDraftStore.ts \
  docs/ \
  > /tmp/kiro-only.patch

git apply --3way /tmp/kiro-only.patch
```

## What Our Patch Adds

~2200 lines across 32+ files. The patch adds Kiro as a first-class provider using ACP (Agent Communication Protocol) infrastructure.

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

### Files Changed

**Layer 1 — Contracts** (`packages/contracts/`):

```
src/orchestration.ts   — "kiro" in ProviderKind union, KiroModelSelection
src/model.ts           — KiroModelOptions with agent field
src/settings.ts        — Kiro provider settings (enabled, binaryPath, customModels)
src/server.ts          — ServerProviderAgent, ServerProviderSlashCommand schemas
src/editor.ts          — Kiro in EDITORS array
src/acp.ts             — ACP agent registry schemas
```

**Layer 2 — effect-acp** (`packages/effect-acp/`):

```
src/client.ts          — ACP JSON-RPC client
src/errors.ts          — Typed ACP errors
src/protocol.ts        — Protocol codec, stdin/stdout transport
src/schema.ts          — ACP message schemas
src/protocol.test.ts   — Protocol tests
```

**Layer 3 — Server Provider** (`apps/server/src/provider/`):

```
Services/KiroAdapter.ts              — Service tag
Services/KiroProvider.ts             — Service tag with patchSlashCommands
Layers/KiroAdapter.ts                — Full adapter (~880 lines)
Layers/KiroProvider.ts               — Provider probe, agent discovery (~375 lines)
Layers/CursorAdapter.ts              — Cursor ACP adapter (PR #1601)
Layers/CursorProvider.ts             — Cursor provider probe (PR #1601)
Layers/AcpAdapter.ts                 — Generic ACP adapter (PR #1601)
Layers/ProviderAdapterRegistry.ts    — Register KiroAdapter
Layers/ProviderRegistry.ts           — Register KiroProvider
acp/AcpSessionRuntime.ts             — ACP session runtime (PR #1601)
acp/AcpCoreRuntimeEvents.ts          — ACP → ProviderRuntimeEvent mapping
acp/AcpRuntimeModel.ts               — ACP runtime model parsing
acp/AcpAdapterSupport.ts             — Shared adapter utilities
acp/AcpNativeLogging.ts              — NDJSON event logging
providerStatusCache.ts               — PROVIDER_CACHE_IDS (add kiro, cursor, acp)
```

**Layer 4 — Server Wiring** (`apps/server/src/`):

```
server.ts              — Wire KiroProvider/CursorProvider into RuntimeServicesLive
cli.ts                 — Ensure ServerSettingsLive is in the launch chain
serverSettings.ts      — Include kiro/cursor settings
```

**Layer 5 — Web UI** (`apps/web/src/`):

```
components/Icons.tsx                              — KiroIcon SVG
components/ChatView.tsx                           — Provider slash commands in / menu
components/chat/composerProviderRegistry.tsx       — Agent picker, handleSlashCommand
components/chat/ChatComposer.tsx                  — Kiro in composer
components/chat/CompactComposerControlsMenu.browser.tsx
components/settings/SettingsPanels.tsx             — Kiro settings panel
components/KeybindingsToast.browser.tsx            — Kiro in test fixture
components/ui/input.tsx                           — Input component updates
composerDraftStore.ts                             — Agent selection persistence
composerDraftStore.test.ts                        — Tests
store.ts                                          — ModelSelection type guards
localApi.test.ts                                  — Test fixture updates
```

**Layer 6 — Tests**:

```
apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
apps/server/src/provider/Layers/CursorAdapter.test.ts
apps/server/src/provider/Layers/AcpAdapter.test.ts
apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts
apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
apps/server/scripts/kiro-mock-agent.ts            — Mock ACP agent for tests
apps/server/src/server.test.ts                    — ACP service mocks in test layer
```

**Docs**:

```
docs/ACP.md            — ACP protocol reference
docs/EFFECT.md         — Effect v4 gotchas and Die defect patterns
docs/KIRO.md           — Kiro-specific protocol notes
build-fail.md          — Post-merge fix history (12 root causes documented)
```

## Likely Conflict Zones When Syncing

| File                                                  | Why                                      |
| ----------------------------------------------------- | ---------------------------------------- |
| `packages/contracts/src/orchestration.ts`             | ProviderKind union, ModelSelection       |
| `apps/server/src/server.ts`                           | Layer wiring (RuntimeServicesLive chain) |
| `apps/server/src/server.test.ts`                      | Test layer mock chain                    |
| `apps/server/src/provider/Layers/ProviderRegistry.ts` | Provider registration                    |
| `apps/server/src/provider/providerStatusCache.ts`     | PROVIDER_CACHE_IDS array                 |
| `apps/web/src/components/settings/SettingsPanels.tsx` | Provider settings UI                     |
| `apps/web/src/composerDraftStore.ts`                  | ModelSelection handling                  |
| `apps/web/src/store.ts`                               | normalizeModelSelection                  |

## Post-Rebuild Verification Checklist

After any sync, rebuild, or conflict resolution:

1. `"kiro"` is in the `ProviderKind` union (`packages/contracts/src/orchestration.ts`)
2. `"kiro"` is in `PROVIDER_CACHE_IDS` (`apps/server/src/provider/providerStatusCache.ts`)
3. `KiroProvider` is wired in `server.ts` RuntimeServicesLive chain
4. `AcpAgentRegistry` and `AcpRegistryClient` mocks exist in `server.test.ts`
5. `Layer.provideMerge` chain in `server.ts` has <= 20 calls (split if needed)
6. All `Context.Service` classes have key strings: `Context.Service<Self, Shape>()("key")`
7. No `.makeUnsafe()` calls — use `.make()` (check Effect version)
8. `providerModelsFromSettings` has correct arg count (4 args in current upstream)
9. `bun install` (lockfile may change after upstream sync)
10. `bun typecheck` passes (0 errors across all packages)
11. `bun fmt && bun lint` pass
12. `bun run dev` starts without runtime errors

## Effect Version Notes

This fork runs **Effect v4 beta.45**. If upstream is on a different beta, adapt accordingly:

| Pattern        | Older betas                                  | beta.45+                                          |
| -------------- | -------------------------------------------- | ------------------------------------------------- |
| Service tags   | `Context.Tag("key")` or `ServiceMap.Service` | `Context.Service<S,T>()("key")` — key is REQUIRED |
| Branded make   | `.makeUnsafe(value)`                         | `.make(value)` — makeUnsafe removed               |
| Error handling | `Effect.catchAll`                            | `Effect.catch`                                    |

If upstream upgrades to beta.45+, our compatibility fixes become redundant and can be dropped.

## Kiro ACP Protocol Notes

See `docs/KIRO.md`, `docs/ACP.md`, and `docs/EFFECT.md` for comprehensive docs.

Key gotchas:

- `kiro-cli acp --trust-all-tools` is the spawn command
- `authenticate` method returns `-32601` (not supported, uses OIDC)
- `mcpServers: []` is required in `session/new` (omitting it causes silent exit)
- `session/update` notifications are the streaming mechanism (no `id` field)
- Turn end is signaled by the RPC response `{stopReason: "end_turn"}`, not a notification
- Agent selection is via `--agent <name>` CLI flag, not an ACP field

## Generating a Standalone Patch File

```bash
# Full patch (everything we added):
cd /Users/ihrishi/personal/t3code-kiro
git diff upstream/main..HEAD > /tmp/kiro-full.patch

# Kiro-only (excludes docs and meta files):
git diff upstream/main..HEAD -- \
  ':(exclude)build-fail.md' \
  ':(exclude)PATCH.md' \
  ':(exclude)docs/' \
  > /tmp/kiro-code-only.patch
```

## Branch Guide

| Branch | Purpose | Status |
| --- | --- | --- |
| `main` | Live working branch with kiro patched on latest upstream | Active — develop here |
| `kiro-acp-rebase` | Reference implementation (clean kiro provider on Effect beta.43) | Frozen — insurance/rebuild source |
| `kiro` | Original pre-ACP branch (before effect-acp rebase) | Outdated — safe to delete |

- **`main`** is what you run and develop on. It stays in sync with `upstream/main` via merge (Option A above).
- **`kiro-acp-rebase`** is the canonical source of truth for rebuilds. PATCH.md's nuclear reset workflow and agent prompt both reference this branch. Do not delete it.
- **`kiro`** was the first attempt before ACP infrastructure existed. It has been superseded by `kiro-acp-rebase` and can be deleted with `git push origin --delete kiro`.
