# Kiro Provider — Protocol and Integration Notes

Kiro is an Amazon CLI that speaks the Agent Communication Protocol (ACP) over stdio. This doc captures the non-obvious pieces of the integration. For the fork's maintenance guide (sync, rebuild, conflict zones, verification checklist), see `../PATCH.md`.

## Spawn and Authentication

```
kiro-cli acp --trust-all-tools
```

- Authentication is OIDC via `kiro-cli login`, performed **out-of-band** before the ACP session starts.
- The `initialize` response returns an empty `authMethods: []`.
- Per the ACP spec, an empty `authMethods` means the client must skip `authenticate` and proceed directly to `session/new`.
- Upstream's `AcpSessionRuntime` types `authMethodId` as required; the fork relaxes it to optional for this reason. Do not re-tighten.

## session/new Requirements

- `mcpServers: []` is **required**. Omitting it can cause kiro-cli to exit silently with no diagnostic.
- Agent selection happens via the **CLI flag** `--agent <name>`, not an ACP protocol field. Agent must be chosen at spawn time (each agent change = new process).

## Streaming and Turn End

- Streaming content arrives as `session/update` notifications (no `id` field).
- The turn ends with the RPC response to `session/prompt`: `{stopReason: "end_turn"}`.
  - Do not wait for a notification-based end signal.
- Cancellation uses `session/cancel`.

## Kiro Extensions (`_kiro.dev/*`)

Ext methods Kiro emits that the adapter handles:

| Method                         | Effect                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| `_kiro.dev/commands/available` | Runtime-patch provider slash commands — delivered mid-session |
| `_kiro.dev/metadata`           | Context window usage stats                                    |

**Protocol correctness:** Any `_kiro.dev/*` request the adapter does _not_ handle **must** be answered with JSON-RPC error `-32601` ("method not found"). Returning `{}` as a success result is a spec violation — some agents tolerate it silently, others deadlock.

## Agent Discovery

```
kiro-cli agent list
```

- Parsed by `KiroProvider` and written to `~/.t3/caches/kiro.json`.
- Injected into each model's `ModelCapabilities.agentOptions`.
- The web `TraitsPicker` reads `agentOptions` to render the agent picker. Gate: `provider === "opencode" || provider === "kiro"`.

## Settings and Caches

| Path                      | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `~/.t3/dev/settings.json` | `providers.kiro.enabled`, `binaryPath`, `customModels` |
| `~/.t3/caches/kiro.json`  | Cached discovered models and agents                    |

## Agent Dispatch Path (where the `--agent` flag actually comes from)

Agent selection flows: TraitsPicker → `composerDraftStore` → `getProviderStateFromCapabilities` → WebSocket → `KiroAdapter.sendTurn`. Two normalization gates can silently drop the agent:

1. `normalizeProviderKind` + the two adjacent arrays in `composerDraftStore.ts` (see below)
2. `normalizeProviderModelOptionsWithCapabilities` in `packages/shared/src/model.ts` — a switch on `ProviderKind`. No `case "kiro"` means the dispatch payload loses `{ agent }` even though the store holds it.

`KiroAdapter.sendTurn` compares the requested agent against the live session's `activeAgent` and respawns the kiro-cli process when they differ (agent is a spawn-time CLI flag, not an in-session ACP field). Integration tests cover the respawn, but they don't catch upstream normalizer drops — always verify on-the-wire when touching this path.

## Composer State Model

Per-thread composer draft state lives in `apps/web/src/composerDraftStore.ts`. Three hardcoded `ProviderKind` arrays in that file **all** need `"kiro"`:

1. `normalizeProviderKind` (~line 533) — normalization gatekeeper
2. `legacyToModelSelectionByProvider` (~line 780) — migration loop
3. `setModelOptions` provider iteration (~line 2326)

Missing any one produces a silent no-op: the UI accepts the model-selector click but reverts to whatever the last valid selection was. No error, no log. This has bitten us once (2026-04-20). See `PATCH.md` → "Hidden Traps" for audit grep and the planned single-source refactor.

## Files Owned Entirely by This Fork

```
apps/server/src/provider/Services/KiroAdapter.ts
apps/server/src/provider/Services/KiroProvider.ts
apps/server/src/provider/Layers/KiroAdapter.ts
apps/server/src/provider/Layers/KiroProvider.ts
apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
apps/server/src/provider/Layers/KiroAdapter.parsing.test.ts
apps/server/scripts/kiro-mock-agent.ts
```

These live entirely within our fork — upstream never touches them. Safe to iterate freely.

## References

- `PATCH.md` — maintenance guide (sync, rebuild, verification checklist)
- `docs/effect-fn-checklist.md` — Effect v4 patterns used throughout the adapter
- Upstream PR [pingdotgg/t3code#1355](https://github.com/pingdotgg/t3code/pull/1355) — shared ACP infrastructure the Kiro layer builds on
