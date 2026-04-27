# Kiro Provider Patch — Maintenance Guide

This repo (`hrishikeshmane/t3code-kiro`) is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) that patches a Kiro ACP provider on top of upstream's ACP infrastructure.

Upstream PR [#1355](https://github.com/pingdotgg/t3code/pull/1355) landed the shared ACP/Cursor foundation. That infrastructure is now the source of truth — our fork only carries the Kiro-specific delta plus small additive extensions.

## Repository Layout

```
origin      → https://github.com/hrishikeshmane/t3code.git       (fork)
upstream    → https://github.com/pingdotgg/t3code.git            (source of truth)
```

Branches:

| Branch                   | Purpose                                                                       | Status                          |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------- |
| `main`                   | Mirror of `upstream/main`. No Kiro code here.                                 | Sync-only — never commit direct |
| `kiro-acp`               | **Single-commit patch branch** carrying the entire Kiro layer on top of main  | Active — develop here           |
| `main-pre-sync-YYYYMMDD` | Safety snapshot of `main` before a destructive sync                           | Long-lived                      |
| `kiro-acp-rebase`        | Historical pre-upstream-merge reference (Effect beta.43)                      | Frozen — deprecated             |
| `backup-YYYYMMDD`        | Transient safety snapshots                                                    | Transient                       |

### Why a single-commit patch branch?

Every change to the Kiro layer lives as **one squashed commit** on `kiro-acp`. This makes the upstream-sync workflow mechanical:

1. `main` fast-forwards to `upstream/main`.
2. `kiro-acp` rebases onto the new `main`. Since it's one commit, conflicts surface in one pass.
3. Open a PR from `kiro-acp` → `main` and merge (or leave open as a tracking PR — we squash-merge via the PR UI when we want to ship a release from main; otherwise `kiro-acp` is the deployable branch).

## Patch-Branch Workflow

### Daily development

Always work on `kiro-acp`. Never commit to `main` — `main` exists only to mirror upstream.

```bash
git checkout kiro-acp
# ... make changes, write tests, run bun typecheck && vitest ...
git add -A
git commit --amend --no-edit   # keep the Kiro patch as ONE commit
git push --force-with-lease origin kiro-acp
```

Amend-and-force-push preserves the single-commit invariant. If you want to preserve a logical history locally while iterating, use a feature branch off `kiro-acp`, squash-merge back, and force-push.

### Syncing with upstream (the routine)

When `pingdotgg/t3code` ships new changes on `main`:

```bash
# 1. Snapshot main before touching anything (the safety net)
TODAY=$(date +%Y%m%d)
git fetch origin upstream
git branch main-pre-sync-$TODAY origin/main
git push origin main-pre-sync-$TODAY

# 2. Fast-forward main to upstream/main
git checkout main
git merge --ff-only upstream/main
git push origin main

# 3. Rebase kiro-acp onto the new main
git checkout kiro-acp
git rebase main
# Resolve conflicts — see "Likely Conflict Zones". Stay as ONE commit.
git push --force-with-lease origin kiro-acp

# 4. Verify
bun install
bun typecheck
cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter
cd ../../packages/shared && bun test src/model.test.ts
# Manual smoke: bun run dev from repo root — walk the verification checklist below
```

Never merge `main` into `kiro-acp`. Always rebase. A merge creates two parents, which breaks the single-commit invariant and makes the next rebase a mess.

### Releasing / shipping

Two options depending on scope:

- **Point release from `kiro-acp`**: just run the build off `kiro-acp`. This is the default — `kiro-acp` is deployable.
- **Shipping Kiro features to `main`**: squash-merge the PR `kiro-acp` → `main` via GitHub UI. This collapses the Kiro layer into `main` as one commit, after which `kiro-acp` resets to zero-delta and new Kiro work starts fresh.

### Nuclear reset (last resort)

If `kiro-acp` diverges too far to rebase cleanly:

```bash
TODAY=$(date +%Y%m%d)
git branch kiro-acp-pre-reset-$TODAY kiro-acp
git push origin kiro-acp-pre-reset-$TODAY

git checkout kiro-acp
git reset --hard origin/main
git checkout origin/kiro-acp-pre-reset-$TODAY -- \
  'apps/server/src/provider/Layers/KiroAdapter.ts' \
  'apps/server/src/provider/Layers/KiroProvider.ts' \
  'apps/server/src/provider/Services/KiroAdapter.ts' \
  'apps/server/src/provider/Services/KiroProvider.ts' \
  'apps/server/src/provider/Layers/KiroAdapter.integration.test.ts' \
  'apps/server/src/provider/Layers/KiroAdapter.parsing.test.ts' \
  'apps/server/scripts/kiro-mock-agent.ts' \
  'PATCH.md' \
  'docs/KIRO.md'
# Manually re-apply integration-point edits (next section)
git add -A && git commit -m "feat(kiro): rebuild Kiro patch on upstream main"
git push --force-with-lease origin kiro-acp
```

## What the Patch Adds

Kiro as a first-class ACP provider, layered on top of upstream's shared ACP infrastructure.

### User-facing features

- Kiro provider in the model selector (purple owl icon)
- Agent picker in the composer (TraitsPicker) — rendered by the generic descriptor pipeline from each model's `optionDescriptors[{id: "agent"}]`
- Agent discovery via `kiro-cli agent list`, cached at `~/.t3/caches/kiro.json`
- Full ACP lifecycle: initialize, session/new, session/prompt, session/cancel, streaming session/update
- **In-session model switching** via `session/set_model` RPC (no respawn)
- **In-session agent switching** via `session/set_mode` RPC (no respawn)
- **Plan sidebar populated from Kiro** — both native ACP `plan` updates AND `todo_list` tool-call synthesis (create + complete) flow through `turn.plan.updated`. Derives an `inProgress` marker for the current task since Kiro's `todo_list` API has no explicit in-progress signal. See `docs/KIRO.md` → "Plan Sidebar Wiring" for state-model details.
- Dynamic slash commands from `_kiro.dev/commands/available` notifications
- Context window usage from `_kiro.dev/metadata` notifications
- Agent selection is persisted per-thread in the composer draft store
- Subagent crews fan out into collapsible Work-log groups: `_kiro.dev/subagent/list_update` roster transitions become `task.started` / `task.completed` envelopes keyed by the crew's ACP sessionId; per-tool activity inside each crew is pulsed as `task.progress` rows (one per distinct `toolCallId`) with labels formatted as `"{title}: {detail}"` (e.g. `Read file: src/foo.ts`, `Ran command: bun test`). Subagent ContentDelta / AssistantItem / PlanUpdated / ModeChanged events are dropped from the main thread — matching Claude Code's SDK behavior of hiding subagent internals behind task notifications.

### Server-only additions (new files)

```
apps/server/src/provider/Services/KiroAdapter.ts
apps/server/src/provider/Services/KiroProvider.ts
apps/server/src/provider/Layers/KiroAdapter.ts           (~880 lines)
apps/server/src/provider/Layers/KiroProvider.ts          (~375 lines)
apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
apps/server/src/provider/Layers/KiroAdapter.parsing.test.ts
apps/server/src/provider/acp/KiroAcpExtension.ts         (applyTodoToolCall — Plan sidebar synthesis)
apps/server/src/provider/acp/KiroAcpExtension.test.ts
apps/server/scripts/kiro-mock-agent.ts
```

### Integration points (additive edits to shared files)

Every shared-file edit is a _pure addition_ (new case in a union, new entry in an array, new layer in a chain). None replace upstream behavior.

**Contracts** (`packages/contracts/src/`):

| File               | Change                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `orchestration.ts` | Add `"kiro"` to `ProviderKind` union; add `KiroModelSelection`     |
| `model.ts`         | Add `KiroModelOptions { agent? }`; default model `"auto"`; aliases |
| `settings.ts`      | Add Kiro provider settings (enabled, binaryPath, customModels)     |
| `server.ts`        | (unchanged if upstream already has `ServerProviderAgent`)          |

**Shared** (`packages/shared/src/model.ts`):

- Add Kiro default/alias entries
- Add `normalizeKiroModelOptionsWithCapabilities` + `case "kiro"` in `normalizeProviderModelOptionsWithCapabilities` (preserves `agent` through dispatch — missing this silently strips agent selection)

**Server** (`apps/server/src/`):

| File                                         | Change                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `server.ts`                                  | Wire `KiroProviderLive` into `RuntimeServicesLive`                |
| `serverSettings.ts`                          | Include kiro settings                                             |
| `provider/Layers/ProviderRegistry.ts`        | Register `KiroProvider`                                           |
| `provider/Layers/ProviderAdapterRegistry.ts` | Register `KiroAdapter`                                            |
| `provider/providerStatusCache.ts`            | Add `"kiro"` to `PROVIDER_CACHE_IDS`                              |
| `provider/makeManagedServerProvider.ts`      | Add `patchSnapshot` (additive, does not replace `enrichSnapshot`) |
| `provider/acp/AcpSessionRuntime.ts`          | `authMethodId` optional (Kiro uses OIDC); thread `sessionId` through `AssistantSegmentState` + re-emitted `ToolCallUpdated` so subagent events can be filtered out of the main thread |
| `provider/acp/AcpRuntimeModel.ts`            | `AcpParsedSessionEvent` union gains `sessionId` on every variant so downstream consumers can tell main-session vs subagent events apart |
| `git/Services/TextGeneration.ts`             | Handle kiro provider kind                                         |

**Web** (`apps/web/src/`):

| File                                              | Change                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `components/Icons.tsx`                            | Add `KiroIcon` SVG                                               |
| `components/chat/composerProviderRegistry.tsx`    | Register kiro provider for composer                              |
| `components/chat/ChatComposer.tsx`                | Include kiro in model-selector options                           |
| `components/chat/ProviderModelPicker.browser.tsx` | Kiro rendering                                                   |
| `components/chat/TraitsPicker.tsx`                | Agent picker: `provider === "opencode" \|\| provider === "kiro"` |
| `components/chat/providerIconUtils.ts`            | Kiro icon resolution                                             |
| `components/settings/SettingsPanels.tsx`          | Kiro settings panel                                              |
| `components/KeybindingsToast.browser.tsx`         | Kiro in fixtures                                                 |
| `composerDraftStore.ts`                           | **Three hardcoded provider arrays** — see "Hidden Traps"         |
| `modelSelection.ts`                               | Kiro custom model options                                        |
| `session-logic.ts`                                | Kiro case in session routing                                     |

## Hidden Traps — Read Before Adding Another Provider

### Provider model options are now descriptor-driven (post upstream PR #2246)

As of the 2026-04-24 sync, `modelSelection.options` is `ReadonlyArray<ProviderOptionSelection>` where each selection is `{ id, value }`. Providers expose their supported options via `ModelCapabilities.optionDescriptors` on each `ServerProviderModel`. The per-provider `normalizeXxxModelOptionsWithCapabilities` helpers that used to exist in `packages/shared/src/model.ts` have been deleted — the generic descriptor pipeline in `composerProviderState.tsx` handles dispatch uniformly for every provider.

**Kiro agent picker wiring:** `KiroProvider.ts` injects a `buildSelectOptionDescriptor({ id: "agent", label: "Agent", options: ... })` into every model's capabilities when `kiro-cli agent list` returns agents. No per-provider normalizer case is needed.

**KiroAdapter reads agent selection via the generic helper:**
```ts
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
const agent = getProviderOptionStringSelectionValue(modelSelection.options, "agent");
```

Verify when adding a new provider feature:

```bash
rg 'buildSelectOptionDescriptor.*id: "<option-id>"' apps/server/src/provider/Layers/<Provider>Provider.ts
```

### The three-hardcoded-lists bug (composerDraftStore.ts)

`composerDraftStore.ts` is the per-thread composer draft store. It has **three hardcoded `ProviderKind` lists** that every new provider must be added to. If you miss any one of them, the symptom is silent:

> "I select the Kiro model but the UI reverts to Claude."

No error, no warning — just a silent no-op. Root cause: `normalizeProviderKind` filters unknown values to `null`, which makes `normalizeModelSelection` return `null`, which makes `setModelSelection` bail out.

**The three lists** (as of 2026-04-20):

1. `normalizeProviderKind(value)` — line ~533. Gatekeeper for all provider-kind normalization.
2. `legacyToModelSelectionByProvider` — line ~780. Migrates legacy single-selection to per-provider map.
3. `setModelOptions` provider loop — line ~2326. Iterates to clear stale options per provider.

**Grep to audit:**

```bash
rg '"codex"\s*,\s*"claudeAgent"\s*,\s*"cursor"\s*,\s*"opencode"' apps/web/src/composerDraftStore.ts
```

Every match must include `"kiro"` (or whatever new provider you are adding). Miss one → silent breakage.

**Ideal fix (not yet done):** export a `PROVIDER_KINDS` const readonly tuple from `packages/contracts/src/orchestration.ts`, derive `ProviderKind` as its element type, and import everywhere these lists are needed. This converts silent runtime no-ops into type errors at the next provider addition. Ticket-worthy follow-up.

### ACP authenticate is conditional

Upstream treats `authMethodId` as required in `AcpSessionRuntime`. Kiro uses OIDC and returns empty `authMethods` from `initialize`, meaning the ACP spec says **skip** `authenticate`. The fork's patch makes `authMethodId` optional; session/new runs directly after initialize. Do not re-tighten this type.

### Unknown ext requests need JSON-RPC error, not `{}`

Kiro (and other ACP agents) send `_kiro.dev/*` ext requests. If an adapter doesn't handle one, it **must** respond with JSON-RPC error `-32601` ("method not found"). Returning `{}` as a success result is a spec violation that some agents tolerate silently and others deadlock on.

### `.npmrc` gets clobbered by Amazon tooling

The fork pins `registry=https://registry.npmjs.org/` in a committed `.npmrc`. If you see E401 errors during `bun install` or `npm install -g`, an internal CodeArtifact registry was re-injected. Restore the public registry line. For local tools (e.g. `agent-browser`), install with the flag: `npm install -g <pkg> --registry=https://registry.npmjs.org/`.

### `patchSnapshot` is additive, not a replacement

Upstream's `makeManagedServerProvider` exposes `enrichSnapshot` for static provider metadata. Kiro needs **runtime-patched** slash commands delivered mid-session from `_kiro.dev/commands/available` notifications. The fork adds a new `patchSnapshot` alongside `enrichSnapshot` rather than replacing it — do not consolidate these. They serve different lifetimes.

## Likely Conflict Zones When Syncing

| File                                                        | Why it conflicts                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts/src/orchestration.ts`                   | ProviderKind union + KiroModelSelection variant                       |
| `packages/contracts/src/model.ts`                           | kiro entries in DEFAULT_*/ALIASES records                             |
| `packages/contracts/src/settings.ts`                        | KiroSettings + KiroSettingsPatch + providers map entry                |
| `apps/server/src/server.ts`                                 | RuntimeServicesLive layer chain                                       |
| `apps/server/src/provider/Layers/ProviderRegistry.ts`       | kiro wired into createBuiltInProviderSources + KiroProviderLive merge |
| `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`| kiro wired into createBuiltInAdapterList                              |
| `apps/server/src/provider/builtInProviderCatalog.ts`        | BUILT_IN_PROVIDER_ORDER + BuiltInAdapterMap extended with kiro        |
| `apps/server/src/provider/providerStatusCache.ts`           | `PROVIDER_CACHE_IDS` array includes "kiro"                            |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`         | Optional `authMethodId`; `sessionId` plumbing for subagent filtering  |
| `apps/server/src/provider/acp/AcpRuntimeModel.ts`           | `sessionId` on `AcpParsedSessionEvent` variants                       |
| `apps/server/src/provider/makeManagedServerProvider.ts`     | Added `patchSnapshot` + slashCommands merge across refreshes          |
| `apps/server/src/git/Layers/RoutingTextGeneration.ts`       | kiro routed through OpenCodeTextGenerationLive                        |
| `apps/web/src/composerDraftStore.ts`                        | Four provider-kind lists (normalizer + 3 loops)                       |
| `apps/web/src/modelSelection.ts`                            | kiro entry in `getCustomModelOptionsByProvider` Record                |
| `apps/web/src/components/chat/composerProviderState.tsx`    | `TraitsRenderInput` extended with `open`/`onOpenChange` for `/agent`  |
| `apps/web/src/components/chat/ChatComposer.tsx`             | `providerHasAgentPicker` replaced with descriptor check               |
| `apps/web/src/components/chat/TraitsPicker.tsx`             | controlled-open state support for `/agent` slash command              |
| `apps/web/src/components/settings/SettingsPanels.tsx`       | Provider panel registration                                           |

## Post-Rebuild Verification Checklist

After every sync, rebuild, or conflict resolution — run all of these:

1. `rg '"kiro"' packages/contracts/src/orchestration.ts` — `"kiro"` in `ProviderKind` union
2. `rg '"kiro"' apps/server/src/provider/providerStatusCache.ts` — in `PROVIDER_CACHE_IDS`
3. `rg 'KiroProviderLive' apps/server/src/server.ts` — wired in `RuntimeServicesLive`
4. `rg '"kiro"' apps/web/src/composerDraftStore.ts | wc -l` — should be ≥ 4 (normalizer + 3 loops)
4a. `rg 'buildSelectOptionDescriptor.*id: "agent"' apps/server/src/provider/Layers/KiroProvider.ts` — agent descriptor wired when agents are discovered
5. `bun install` — lockfile resolves cleanly
6. `bun typecheck` — 0 errors
7. `bun fmt && bun lint` — clean
8. `bun run test` — current baseline (post-2026-04-24 sync): 100 files / 933 passing, 1 file / 4 tests skipped
9. `bun run dev` — launch, pair, enable Kiro in settings, select a Kiro model, open agent picker, verify agent list populates
10. Manual: type `/` in composer → slash commands and MCP prompts populate

## Kiro ACP Protocol Notes

- Spawn: `kiro-cli acp --trust-all-tools [--agent <name>]`
- Auth: OIDC via `kiro-cli login` out-of-band — ACP `authenticate` is never called (authMethods empty)
- `mcpServers: []` is required in `session/new` (omitting it can silently exit kiro-cli)
- Streaming: `session/update` notifications (no `id` field)
- Turn end: RPC response `{stopReason: "end_turn"}`, not a notification
- Discovery: `kiro-cli agent list` → parsed and cached at `~/.t3/caches/kiro.json`; injected into each model's `optionDescriptors` as an `{id: "agent", type: "select"}` descriptor (post-PR#2246 generic shape).

### In-session switching (no respawn)

- Model switch: `session/set_model` RPC with `{sessionId, modelId}` → `{}`. Bypasses upstream `AcpSessionRuntime.setModel` (which routes through `session/set_config_option` — Kiro rejects that with `-32601`).
- Agent switch: `session/set_mode` RPC with `{sessionId, modeId}` → `{}`. Same bypass rationale. `session/set_mode` is not exposed by effect-acp's agent SDK; the mock agents wire it via `handleExtRequest("session/set_mode", ...)`.
- **Do NOT pass `--model` at spawn.** Passing `--model <slug>` makes Kiro silently ignore subsequent `session/set_model` RPCs — the RPC returns success but the active model never changes. `--agent` at spawn is safe.
- `KiroSessionContext` tracks `activeMode` and `activeModel` (both `undefined` at spawn). First turn fires the RPC to align Kiro's state with the user's selection; subsequent turns only fire on actual change.
- Cross-family model switches (Claude → DeepSeek → Kimi) may surface AWS Bedrock `ValidationException` on the next prompt — Kiro's conversation-history replay is not portable across model families. We surface the error; a fix is upstream-Kiro's.

## Effect Version Notes

Fork runs in lockstep with upstream (currently Effect v4 beta.45+). If you see these legacy patterns while cherry-picking from `kiro-acp-rebase`, update before using:

| Pattern        | Legacy               | Current                                 |
| -------------- | -------------------- | --------------------------------------- |
| Service tags   | `Context.Tag("key")` | `Context.Service<Self, Shape>()("key")` |
| Branded make   | `.makeUnsafe(value)` | `.make(value)`                          |
| Error handling | `Effect.catchAll`    | `Effect.catch`                          |

## Session Reflections (2026-04-24 — in-session model/agent switching rewrite)

### What broke and what fixed it

**Bug: in-session model switch appeared to succeed but conversations stayed on the original model.**

Four attempts on the same class of bug across threads `e3a5c1bf`, `55afbe27`, `23f518fe`, `3e377f8b`, `593e16ae`:

1. **PR #4 (original):** `session/set_model` RPC via `ctx.acp.request(...)`. Worked when tested manually but had a first-turn gotcha: the gate `model !== ctx.session.model` was false on turn 1 (session.model pre-populated from user selection), so Kiro stayed on its internal default.
2. **Respawn approach (commit 66faaf91, reverted):** tear down kiro-cli and respawn with `--model <slug>`. Didn't work — `session/load` on the second spawn reloads the session's persisted model state from disk and ignores the new `--model` CLI arg.
3. **Hybrid (commit 7badf022, reverted):** spawn with `--model` AND call `session/set_model`. Worse: passing `--model` at spawn **locks** Kiro's model and makes every subsequent `session/set_model` RPC a silent no-op. Model reported as switched but actual replies came from the original model.
4. **Final (commit 4374b260 + cf82043b):** Drop `--model` from spawn args entirely. Use `session/set_model` RPC for model switches and `session/set_mode` RPC for agent switches. Gate fires on `ctx.activeModel` / `ctx.activeMode` (both undefined at spawn) so the first turn always aligns Kiro's state with the user's selection.

Verified on thread `593e16ae`: 1 initialize, 3 set_mode, 4 set_model, 7 prompts, 0 failures, 0 respawns across the whole conversation.

### Lessons worth keeping

1. **Kiro's ACP protocol has product-specific quirks not documented in the spec.** `--model` at spawn silently disables in-session `set_model`. The fix is "don't do that" — spawn bare, rely on RPCs.
2. **"Who are you?" is not a reliable model-switch signal.** Kiro's system prompt brand-protects the underlying model; every model answers "I'm Kiro" or "I'm an AI assistant, I don't know my model." Use `_kiro.dev/metadata` `contextUsagePercentage` variance or per-model latency fingerprint as a behavioral check instead.
3. **`session/load` is NOT a context preservation mechanism, it's a sessionId preservation mechanism.** It doesn't replay history to the new process's model in a way that the new model can consume cross-family. That's why cross-family switches can ValidationException on subsequent prompts.
4. **Kirodex does the same thing we now do** — spawn bare kiro-cli and switch via `session/set_mode`/`setSessionModel` RPCs. They suppress the occasional failure silently; we surface it. Both are defensible; we picked the honest one.

### Outstanding follow-ups

- File a Kiro upstream bug for cross-family ValidationException. Minimal repro: thread with Claude tool_use blocks in history, set_model to DeepSeek, next prompt fails.
- Kiro's brand-protection system prompt makes debugging opaque. If this bites again, grep `_kiro.dev/metadata` for `contextUsagePercentage` — same conversation history should produce different percentages on different models.

## Session Reflections (2026-04-20)

### What broke and what fixed it

**Bug: Selecting a Kiro model reverted to Claude in the UI.**

- Server-side was fine: `~/.t3/caches/kiro.json` had 12 models × 17 agents discovered.
- `~/.t3/dev/settings.json` had `textGenerationModelSelection.provider = "kiro"`.
- TraitsPicker rendered fine when forced.
- The store silently rejected every `setModelSelection({provider: "kiro", ...})` call because `normalizeProviderKind` in `composerDraftStore.ts` didn't list `"kiro"`.
- Two adjacent hardcoded arrays (`legacyToModelSelectionByProvider`, `setModelOptions`) had the same omission.
- Fix: add `"kiro"` to all three. Typecheck + `composerDraftStore.test.ts` (62/62) + manual smoke: green.

### Lessons worth keeping

1. **Normalization gatekeepers produce silent no-ops.** If you ever wonder "why did selecting X do nothing", look for a `normalize*` function that filters unknown values to `null`.
2. **Enumerate from a single source.** Hardcoded provider-kind arrays across a file are a maintenance trap — each new provider needs N coordinated edits with no type-level enforcement. Short-term: the verification grep in the checklist. Long-term: export `PROVIDER_KINDS` const tuple from contracts and derive `ProviderKind` from it.
3. **Agent-browser installation.** Use `npm install -g agent-browser --registry=https://registry.npmjs.org/` to dodge internal CodeArtifact auth.

### Outstanding follow-ups

- Refactor to a single `PROVIDER_KINDS` const tuple exported from contracts to eliminate the three-list hazard permanently (also makes `normalizeProviderModelOptionsWithCapabilities` exhaustiveness-check at compile time).

## Session Reflections (2026-04-20 — round 3: subagent grouping)

### What broke and what fixed it

**Bug: Kiro subagent crews flooded the main chat — one flat stream of "Read file" / "Ran command" / assistant-message rows per subagent, no grouping.**

- Kiro's ACP transport multiplexes `session/update` for the main session *and* every spawned subagent crew over one channel, tagged with `sessionId`. Upstream's `AcpRuntimeModel.parseSessionUpdateEvent` dropped that `sessionId` before reaching the adapter, so everything looked like main-session activity.
- Fix landed in three passes:
  1. Thread `sessionId` through `AcpParsedSessionEvent` and `AcpSessionRuntime`, track a roster of in-flight subagents by their ACP sessionId, and translate `_kiro.dev/subagent/list_update` transitions into `task.started` / `task.completed` envelopes. Subagent session/update events are dropped on the main thread.
  2. Dropping *everything* from subagents made the Work-log look stuck — the group sat silent until the crew terminated. Emit one `task.progress` per distinct subagent `toolCallId` (tracked per-subagent in `seenToolCallIds`) so the Work-log shows live per-tool activity inside the collapsible group, matching Claude Code's native SDK behavior.
  3. Work-log rows initially rendered only the generic category ("Ran command", "Read file"). Kiro's typed tool-call presentation puts the action in `title` and the payload in `detail`; combine them as `"{title}: {detail}"` via a new `formatSubagentToolLabel` helper so rows show the actual command / path / query. 8 unit tests cover the helper.

### Lessons worth keeping

1. **Multiplexed channels need identity on every event.** Any time a transport fans in multiple logical streams, the parser must preserve the stream identity all the way to the consumer. Dropping it at the parser layer is irreversible downstream.
2. **"Don't route" is not the same as "don't show".** The first pass filtered subagent events out of main-thread routing entirely; the fix was to keep a single summarized breadcrumb (task.progress per tool call) so the user sees progress without being drowned in subagent internals.

## Session Reflections (2026-04-20 — round 2)

### What broke and what fixed it

**Bug: selecting an agent in TraitsPicker had no effect — kiro-cli always ran with `kiro_default`.**

- Server-side respawn logic worked in integration tests (2 tests green).
- The composer draft store correctly persisted `{ agent: "..." }` per thread.
- The TraitsPicker UI rendered the selected agent.
- But the agent never reached the server: `normalizeProviderModelOptionsWithCapabilities` had no `case "kiro"`, so the options switch fell through and returned `undefined` on every dispatch. The server received a bare `modelSelection` with no agent.
- Fix: add `normalizeKiroModelOptionsWithCapabilities` (mirrors opencode) + wire the kiro case. 4 new unit tests cover agent preservation and the provider-level switch.

**UX: TraitsPicker stayed open after agent selection.**

- Fix: `closeOnClick` on the Agent `MenuRadioItem` (base-ui built-in).

**Feature: `/agent` slash command opens the TraitsPicker.**

- Mirrors `/model` opening the model picker. Gated on `hasAgentPickerSupport` so it only appears for providers whose selected model exposes `agentOptions`.

**Feature: Opus 4.7 added to Kiro built-in models.**

- Alias `opus` now maps to `claude-opus-4.7` for kiro.

### Lessons worth keeping

1. **Passing integration tests do not imply end-to-end correctness.** The KiroAdapter respawn test hit `sendTurn` directly with a fully-formed `modelSelection`; the real bug was upstream in the web dispatch normalizer. Whenever a feature involves passing data across the web→server boundary, verify the *payload on the wire* once before trusting unit/integration tests.
2. **Switch statements over `ProviderKind` are landmines.** At least three such switches exist (draft store normalizers, shared model normalizer, contract `createModelSelection`). Each new provider needs an explicit case. Today's bug was cause #4 of "add-a-provider-or-it-silently-breaks" and makes the case for a `PROVIDER_KINDS` tuple stronger.

## Generating a Standalone Patch

```bash
# Full patch (everything this fork adds on top of upstream):
git diff upstream/main..HEAD > /tmp/kiro-full.patch

# Kiro-only (excludes meta docs):
git diff upstream/main..HEAD -- \
  ':(exclude)PATCH.md' \
  ':(exclude)CLAUDE.md' \
  ':(exclude)docs/' \
  > /tmp/kiro-code-only.patch
```
