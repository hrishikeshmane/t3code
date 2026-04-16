# Kiro Feature Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port agent discovery, agent selection UI, slash commands, Open Picker integration, and test suites from main's manual JSON-RPC Kiro implementation onto the effect-acp typed RPC branch (`kiro-acp-rebase`).

**Architecture:** We're building on top of `effect-acp` (the typed RPC layer from PR #1601). Main deleted effect-acp and went with raw JSON-RPC — we're going the opposite direction. Features are ported conceptually, not copy-pasted, since the underlying adapter architecture differs.

**Tech Stack:** Effect v4 (beta.43+), React, Zustand, Effect Schema, Vitest

**Branch:** `kiro-acp-rebase`

---

## Task 1: Add ServerProviderAgent and ServerProviderSlashCommand schemas to contracts

**Files:**
- Modify: `packages/contracts/src/server.ts`

**Step 1: Add the schemas**

After `ServerProviderModel` (line 58), add:

```typescript
export const ServerProviderAgent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type ServerProviderAgent = typeof ServerProviderAgent.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(Schema.Struct({ hint: TrimmedNonEmptyString })),
  inputType: Schema.optional(Schema.Literal("selection", "panel")),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;
```

**Step 2: Add agents and slashCommands to ServerProvider**

In the `ServerProvider` schema (line 60-70), add two optional fields after `models`:

```typescript
export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  agents: Schema.optional(Schema.Array(ServerProviderAgent)),
  slashCommands: Schema.optional(Schema.Array(ServerProviderSlashCommand)),
});
```

**Step 3: Export from barrel**

Check `packages/contracts/src/index.ts` — ensure `ServerProviderAgent` and `ServerProviderSlashCommand` are exported. They should be auto-exported if `server.ts` is re-exported with `*`.

**Step 4: Verify**

Run: `bun typecheck`
Expected: PASS (new optional fields don't break existing consumers)

**Step 5: Commit**

```bash
git add packages/contracts/src/server.ts
git commit -m "feat(contracts): add ServerProviderAgent and ServerProviderSlashCommand schemas"
```

---

## Task 2: Add agent discovery to KiroProvider

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroProvider.ts`
- Modify: `apps/server/src/provider/Services/KiroProvider.ts`
- Modify: `apps/server/src/provider/makeManagedServerProvider.ts`

**Step 1: Add parseKiroAgentListOutput function**

In `KiroProvider.ts`, add before `checkKiroProviderStatus`:

```typescript
import type { ServerProviderAgent, ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * Parse the output of `kiro-cli agent list` into ServerProviderAgent entries.
 *
 * Each agent line looks like:
 *   `* kiro_default            (Built-in)    Default agent`
 *   `  amzn-builder            Global        Some description...`
 *
 * The `*` prefix marks the current default agent.
 */
export function parseKiroAgentListOutput(stdout: string): ServerProviderAgent[] {
  const agents: ServerProviderAgent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!trimmed || trimmed.startsWith("Workspace:") || trimmed.startsWith("Global:")) continue;

    const isDefault = trimmed.startsWith("*");
    const content = isDefault ? trimmed.slice(1).trim() : trimmed;

    const nameMatch = content.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;

    const afterName = content.slice(name.length).trim();
    const scopeMatch = afterName.match(/^(\(Built-in\)|Global|Workspace)\s*(.*)/i);
    if (!scopeMatch) continue;
    const scope = scopeMatch[1]?.replace(/[()]/g, "") ?? undefined;
    const description = scopeMatch[2]?.trim() || undefined;

    agents.push({
      name,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
      ...(isDefault ? { isDefault: true } : {}),
    });
  }
  return agents;
}
```

**Step 2: Add fetchKiroAgents function**

```typescript
const fetchKiroAgents = Effect.fn("fetchKiroAgents")(function* (): Effect.fn.Return<
  ServerProviderAgent[],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = ChildProcess.make(KIRO_BINARY, ["agent", "list"], {
    shell: process.platform === "win32",
  });
  const result = yield* spawnAndCollect(KIRO_BINARY, command).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none<{ stdout: string; stderr: string; code: number }>()),
  );
  if (Option.isNone(result)) return [];
  const { stdout, stderr, code } = result.value;
  if (code !== 0) return [];
  const output = stderr || stdout;
  return parseKiroAgentListOutput(output);
});
```

Add required imports: `Option` from `effect`, ensure `ChildProcess`, `ChildProcessSpawner`, `spawnAndCollect` are available (check how version probing already works in the file).

**Step 3: Integrate into checkKiroProviderStatus**

In the `checkKiroProviderStatus` function, after version probing and before building the return value, add:

```typescript
const agents = yield* fetchKiroAgents();
```

Then include `agents` in the return object. The exact shape depends on how `buildServerProvider` works — if it's a helper, add `agents` to its params. If it returns a raw `ServerProvider`, add `agents` to the object literal.

**Step 4: Add patchSlashCommands to KiroProvider service**

In `apps/server/src/provider/Services/KiroProvider.ts`, extend the service shape:

```typescript
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export interface KiroProviderShape extends ServerProviderShape {
  readonly patchSlashCommands: (
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
}
```

**Step 5: Add patchSnapshot to makeManagedServerProvider**

In `apps/server/src/provider/makeManagedServerProvider.ts`, the return object currently satisfies `ServerProviderShape`. Add a `patchSnapshot` method:

```typescript
return {
  getSnapshot: /* ... */,
  refresh: /* ... */,
  get streamChanges() { /* ... */ },
  patchSnapshot: (fn: (current: ServerProvider) => ServerProvider) =>
    Ref.update(snapshotRef, fn).pipe(
      Effect.tap(() => Ref.get(snapshotRef).pipe(Effect.flatMap((s) => PubSub.publish(changesPubSub, s)))),
    ),
} satisfies ServerProviderShape & { patchSnapshot: (fn: (current: ServerProvider) => ServerProvider) => Effect.Effect<void> };
```

**Step 6: Wire patchSlashCommands in KiroProvider layer**

In `KiroProvider.ts`, where the layer returns the managed provider, add:

```typescript
return {
  ...managed,
  patchSlashCommands: (commands) =>
    managed.patchSnapshot((current) => ({
      ...current,
      slashCommands: [...commands],
    })),
};
```

**Step 7: Verify**

Run: `bun typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/server/src/provider/Layers/KiroProvider.ts apps/server/src/provider/Services/KiroProvider.ts apps/server/src/provider/makeManagedServerProvider.ts
git commit -m "feat(kiro): add agent discovery via kiro-cli agent list and slash command patching"
```

---

## Task 3: Add slash command parsing and patching in KiroAdapter

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts`

**Step 1: Add parseKiroSlashCommands function**

Add near the top of the file, after imports:

```typescript
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

function parseKiroSlashCommands(
  raw: ReadonlyArray<unknown>,
): ServerProviderSlashCommand[] {
  const commands: ServerProviderSlashCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const cmd = entry as Record<string, unknown>;
    const rawName = typeof cmd.name === "string" ? cmd.name : "";
    const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
    if (!name) continue;
    const description =
      typeof cmd.description === "string" && cmd.description.length > 0
        ? cmd.description
        : undefined;
    const meta = cmd.meta && typeof cmd.meta === "object" ? (cmd.meta as Record<string, unknown>) : null;
    const rawInputType = meta?.inputType;
    const inputType =
      rawInputType === "selection" ? ("selection" as const)
        : rawInputType === "panel" ? ("panel" as const)
        : undefined;
    const hint = typeof meta?.hint === "string" && meta.hint.length > 0 ? meta.hint : undefined;
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
      ...(inputType ? { inputType } : {}),
    });
  }
  return commands;
}
```

**Step 2: Wire the `_kiro.dev/commands/available` handler to patch slash commands**

Find the existing no-op handler for `_kiro.dev/commands/available` (currently around line 364-377). Replace it:

```typescript
yield* acp.handleExtNotification(
  "_kiro.dev/commands/available",
  Schema.Unknown,
  (params) =>
    Effect.gen(function* () {
      yield* logNative(
        input.threadId,
        "_kiro.dev/commands/available",
        params,
        "acp.kiro.extension",
      );
      const cmdParams = params as Record<string, unknown>;
      if (Array.isArray(cmdParams.commands)) {
        const commands = parseKiroSlashCommands(cmdParams.commands);
        yield* kiroProvider.patchSlashCommands(commands);
      }
    }),
);
```

**Step 3: Get kiroProvider reference**

The `startSession` function needs access to `KiroProvider`. Add it to the dependencies:

```typescript
const kiroProvider = yield* KiroProvider;
```

This should be yielded inside `makeKiroAdapter` (or passed through options) so it's available in the session scope.

**Step 4: Verify**

Run: `bun typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.ts
git commit -m "feat(kiro): parse and patch dynamic slash commands from _kiro.dev/commands/available"
```

---

## Task 4: Add KiroIcon to Icons.tsx

**Files:**
- Modify: `apps/web/src/components/Icons.tsx`

**Step 1: Add KiroIcon SVG component**

Add alongside other provider icons:

```typescript
export const KiroIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1200 1200" fill="none">
    <rect width="1200" height="1200" rx="260" fill="#9046FF" />
    <path
      d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
      fill="#fff"
    />
    <path
      d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z"
      fill="#000"
    />
    <path
      d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"
      fill="#000"
    />
  </svg>
);
```

**Step 2: Verify**

Run: `bun typecheck`

**Step 3: Commit**

```bash
git add apps/web/src/components/Icons.tsx
git commit -m "feat(web): add KiroIcon SVG component"
```

---

## Task 5: Add Kiro to Open Picker

**Files:**
- Modify: `apps/web/src/components/chat/OpenInPicker.tsx`

**Step 1: Add Kiro editor entry**

Import `KiroIcon` and add to the editor options array alongside existing entries:

```typescript
import { KiroIcon } from "../Icons";

// In the editor options array:
{
  label: "Kiro",
  Icon: KiroIcon,
  value: "kiro",
},
```

**Step 2: Verify**

Run: `bun typecheck`

**Step 3: Commit**

```bash
git add apps/web/src/components/chat/OpenInPicker.tsx
git commit -m "feat(web): add Kiro to Open In editor picker"
```

---

## Task 6: Add Kiro agent selection persistence to composerDraftStore

**Files:**
- Modify: `apps/web/src/composerDraftStore.ts`

**Step 1: Add KiroModelOptions type**

Find the `ProviderModelOptions` type definition. Add kiro agent options:

```typescript
export type KiroModelOptions = { agent?: string };

// In ProviderModelOptions:
export type ProviderModelOptions = {
  // ... existing providers ...
  kiro?: KiroModelOptions;
};
```

**Step 2: Add kiro agent normalization**

In the `normalizeProviderModelOptions` function (or wherever provider model options are hydrated from persistence), add kiro agent handling:

```typescript
const kiroCandidate =
  candidate?.kiro && typeof candidate.kiro === "object"
    ? (candidate.kiro as Record<string, unknown>)
    : null;
const kiroAgent =
  typeof kiroCandidate?.agent === "string" && kiroCandidate.agent.length > 0
    ? kiroCandidate.agent
    : undefined;
const kiro = kiroCandidate !== null ? (kiroAgent ? { agent: kiroAgent } : {}) : undefined;
```

Include `kiro` in the returned normalized object.

**Step 3: Verify**

Run: `bun typecheck`

**Step 4: Commit**

```bash
git add apps/web/src/composerDraftStore.ts
git commit -m "feat(web): add kiro agent selection persistence in composer draft store"
```

---

## Task 7: Add KiroAgentPicker UI and /agent interception

**Files:**
- Modify: `apps/web/src/components/chat/composerProviderRegistry.tsx`
- Modify: `apps/web/src/components/ChatView.tsx` (or wherever slash command interception lives)

**Step 1: Add KiroAgentMenuContent component**

In `composerProviderRegistry.tsx`:

```typescript
import type { ServerProviderAgent } from "@t3tools/contracts";
import { KiroIcon } from "../Icons";

const FALLBACK_AGENTS: readonly ServerProviderAgent[] = [
  { name: "kiro_default", isDefault: true },
];

const KiroAgentMenuContent = memo(function KiroAgentMenuContentImpl({
  agents,
  selectedAgent,
  onAgentChange,
}: {
  agents: ReadonlyArray<ServerProviderAgent>;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
}) {
  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Agent</div>
      <MenuRadioGroup value={selectedAgent} onValueChange={onAgentChange}>
        {agents.map((agent) => (
          <MenuRadioItem key={agent.name} value={agent.name}>
            {agent.name}
            {agent.isDefault ? " (default)" : ""}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
});
```

**Step 2: Add KiroAgentPicker component**

```typescript
const KiroAgentPicker = memo(function KiroAgentPickerImpl({
  agents,
  selectedAgent,
  onAgentChange,
}: {
  agents: ReadonlyArray<ServerProviderAgent>;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const effectiveAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const label =
    selectedAgent ||
    effectiveAgents.find((a) => a.isDefault)?.name ||
    effectiveAgents[0]?.name ||
    "kiro_default";

  const handleAgentChange = useCallback(
    (agent: string) => {
      onAgentChange(agent);
      setIsMenuOpen(false);
    },
    [onAgentChange],
  );

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            data-chat-kiro-agent-picker="true"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <KiroAgentMenuContent
          agents={effectiveAgents}
          selectedAgent={selectedAgent || label}
          onAgentChange={handleAgentChange}
        />
      </MenuPopup>
    </Menu>
  );
});
```

**Step 3: Add useKiroAgentChange hook**

```typescript
function useKiroAgentChange(threadRef: ScopedThreadRef | undefined, draftId: DraftId | undefined) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (agent: string) => {
      const target = threadRef ?? draftId;
      if (!target) return;
      setProviderModelOptions(target, "kiro", { agent } as KiroModelOptions, {
        persistSticky: true,
      });
    },
    [threadRef, draftId, setProviderModelOptions],
  );
}
```

**Step 4: Update kiro entry in composerProviderRegistry**

Replace the current `kiro: undefined` or null-returning entry with actual trait rendering:

```typescript
kiro: {
  getState: (input) => getProviderStateFromCapabilities(input),
  renderTraitsMenuContent: ({ threadRef, draftId, modelOptions, providers }) => {
    if (!hasComposerTraitsTarget({ threadRef, draftId })) return null;
    // Render agent picker menu content
    // ... wire up using providers to find kiro agents
    return null; // Placeholder — wire with wrapper component
  },
  renderTraitsPicker: ({ threadRef, draftId, modelOptions, providers }) => {
    if (!hasComposerTraitsTarget({ threadRef, draftId })) return null;
    // Render agent picker
    // ... wire up using providers to find kiro agents
    return null; // Placeholder — wire with wrapper component
  },
},
```

The exact wiring depends on how other providers (codex, claudeAgent) access provider data in the registry. Follow the same pattern.

**Step 5: Add /agent slash command interception**

In `ChatView.tsx` or `ChatComposer.tsx`, where slash commands are handled, add provider-specific command interception. When user types `/agent`:

```typescript
// In the slash command handler:
if (command === "agent") {
  // Click the kiro agent picker to open it
  const agentPicker = document.querySelector('[data-chat-kiro-agent-picker]');
  if (agentPicker instanceof HTMLElement) {
    agentPicker.click();
    return true; // handled
  }
}
```

**Step 6: Verify**

Run: `bun typecheck`

**Step 7: Commit**

```bash
git add apps/web/src/components/chat/composerProviderRegistry.tsx apps/web/src/components/ChatView.tsx
git commit -m "feat(web): add Kiro agent picker with /agent slash command interception"
```

---

## Task 8: Add KiroAdapter unit tests

**Files:**
- Create: `apps/server/src/provider/Layers/KiroAdapter.test.ts`

**Context:** Main's tests use `FakeAcpProcess` with raw JSON-RPC. Our branch uses effect-acp. The tests need to be adapted to test the effect-acp based adapter.

**Step 1: Understand the testing approach**

Our adapter uses `AcpSessionRuntime` which depends on the effect-acp protocol layer. For unit tests, we need to either:
- A) Mock at the `AcpSessionRuntime` level (provide a fake ACP client)
- B) Create a fake stdio transport that speaks JSON-RPC 2.0 to the effect-acp client

Option B is preferred — it tests the full stack including protocol parsing.

**Step 2: Create the test file**

The test should cover:
1. `startSession` sends `initialize` + `session/new` via ACP
2. `sendTurn` sends `session/prompt` and emits `content.delta` events from `session/update` notifications
3. `sendTurn` emits `turn.completed` when prompt response arrives with `stopReason: "end_turn"`
4. `interruptTurn` sends `session/cancel`
5. `stopSession` kills the process
6. `_kiro.dev/metadata` emits `thread.token-usage.updated`
7. `_kiro.dev/commands/available` calls `patchSlashCommands`
8. `parseKiroSlashCommands` parses command names, strips `/`, extracts metadata

The exact test implementation depends on how the effect-acp test infrastructure is set up. Check if `packages/effect-acp` has test utilities for creating fake transports.

**Step 3: Add parseKiroSlashCommands unit tests**

These are pure functions and easy to test:

```typescript
import { parseKiroSlashCommands } from "./KiroAdapter";

describe("parseKiroSlashCommands", () => {
  it("strips leading / from command names", () => {
    const result = parseKiroSlashCommands([
      { name: "/agent", description: "Run an agent task" },
      { name: "/compact", description: "Compact context" },
      { name: "tools" },
    ]);
    assert.equal(result.length, 3);
    assert.equal(result[0]!.name, "agent");
    assert.equal(result[0]!.description, "Run an agent task");
    assert.equal(result[1]!.name, "compact");
    assert.equal(result[2]!.name, "tools");
    assert.equal(result[2]!.description, undefined);
  });

  it("parses inputType and hint from meta", () => {
    const result = parseKiroSlashCommands([
      { name: "/agent", meta: { inputType: "selection", hint: "Choose agent" } },
      { name: "/usage", meta: { inputType: "panel" } },
    ]);
    assert.equal(result[0]!.inputType, "selection");
    assert.equal(result[0]!.input?.hint, "Choose agent");
    assert.equal(result[1]!.inputType, "panel");
  });

  it("skips malformed entries", () => {
    const result = parseKiroSlashCommands([null, undefined, {}, { name: "" }, "string"]);
    assert.equal(result.length, 0);
  });
});
```

**Step 4: Add parseKiroAgentListOutput unit tests**

```typescript
import { parseKiroAgentListOutput } from "./KiroProvider";

describe("parseKiroAgentListOutput", () => {
  it("parses agent list with default marker", () => {
    const output = [
      "Global:",
      "* kiro_default            (Built-in)    Default agent",
      "  amzn-builder            Global        Amazon builder agent",
      "",
    ].join("\n");
    const agents = parseKiroAgentListOutput(output);
    assert.equal(agents.length, 2);
    assert.equal(agents[0]!.name, "kiro_default");
    assert.equal(agents[0]!.isDefault, true);
    assert.equal(agents[0]!.scope, "Built-in");
    assert.equal(agents[1]!.name, "amzn-builder");
    assert.equal(agents[1]!.isDefault, undefined);
    assert.equal(agents[1]!.scope, "Global");
    assert.equal(agents[1]!.description, "Amazon builder agent");
  });

  it("strips ANSI escape codes", () => {
    const output = "\x1b[1m* kiro_default\x1b[0m            (Built-in)    Default\n";
    const agents = parseKiroAgentListOutput(output);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "kiro_default");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseKiroAgentListOutput(""), []);
  });
});
```

**Step 5: Run tests**

Run: `bun run test apps/server/src/provider/Layers/KiroAdapter.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.test.ts
git commit -m "test(kiro): add unit tests for slash command and agent list parsing"
```

---

## Task 9: Add KiroAdapter integration tests

**Files:**
- Create: `apps/server/src/provider/Layers/KiroAdapter.integration.test.ts`

**Step 1: Write integration tests**

These test the full adapter lifecycle using effect-acp's test infrastructure. The tests should:

1. Start a session (verify `initialize` + `session/new` are sent)
2. Send a turn (verify `session/prompt` is sent, response is processed)
3. Verify streaming events from `session/update` notifications produce `content.delta`
4. Verify `turn.completed` is emitted after prompt response
5. Test interrupt via `session/cancel`
6. Test model switching via `session/set_model`
7. Test context usage from `_kiro.dev/metadata`

**Step 2: Test approach**

Since our adapter uses effect-acp with RpcClient, we need a test transport. Two approaches:

A) If effect-acp provides test utilities (check `packages/effect-acp/src/` for test helpers), use those.

B) Create a `FakeKiroProcess` that implements the stdio interface expected by the effect-acp protocol layer. This process:
   - Accepts JSON-RPC requests on stdin
   - Auto-responds to `initialize`, `session/new`
   - Sends `session/update` notifications for streaming
   - Responds to `session/prompt` with `{ stopReason: "end_turn" }`

The implementer should check `apps/server/src/provider/Layers/KiroAdapter.ts` for how the process is spawned (via `ChildProcessSpawner` or direct `createProcess` option) and create a compatible fake.

**Step 3: Run tests**

Run: `bun run test apps/server/src/provider/Layers/KiroAdapter.integration.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
git commit -m "test(kiro): add integration tests for KiroAdapter effect-acp lifecycle"
```

---

## Task 10: Final verification and cleanup

**Step 1: Run full checks**

```bash
bun typecheck
bun lint
bun fmt
```

All must pass.

**Step 2: Run all kiro-related tests**

```bash
bun run test apps/server/src/provider/Layers/KiroAdapter
bun run test apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

**Step 3: Manual smoke test**

```bash
bun run dev
```

1. Open `http://localhost:5733`
2. Select Kiro provider
3. Verify agent picker appears in composer
4. Send a message — verify response streams back
5. Check that slash commands appear in command menu (if `/agent`, `/compact`, etc. are available)

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(kiro): address lint/typecheck issues from feature parity port"
```

---

## Dependency Order

```
Task 1 (contracts)
  ↓
Task 2 (agent discovery) ← depends on Task 1
  ↓
Task 3 (slash commands) ← depends on Task 2
  ↓
Task 4 (KiroIcon) ← independent
Task 5 (Open Picker) ← depends on Task 4
Task 6 (draft store) ← depends on Task 1
  ↓
Task 7 (agent picker UI) ← depends on Tasks 3, 4, 6
  ↓
Task 8 (unit tests) ← depends on Tasks 2, 3
Task 9 (integration tests) ← depends on Tasks 2, 3
  ↓
Task 10 (verification) ← depends on all
```

Tasks 4, 5, 6 can run in parallel with Tasks 2, 3.
Tasks 8, 9 can run in parallel with Task 7.
