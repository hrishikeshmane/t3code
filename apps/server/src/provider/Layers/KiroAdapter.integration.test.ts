import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { it } from "@effect/vitest";
import { type ServerProvider, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import { KiroAdapter } from "../Services/KiroAdapter.ts";
import { KiroProvider, type KiroProviderShape } from "../Services/KiroProvider.ts";
import { makeKiroAdapterLive } from "./KiroAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/kiro-mock-agent.ts");

/**
 * Build a ChildProcessSpawner that intercepts kiro-cli commands and redirects
 * them to the mock agent script. All other commands pass through to the real
 * Node spawner.
 *
 * `capturedArgs` records every intercepted spawn for test assertions.
 */
const capturedArgs: Array<ReadonlyArray<string>> = [];

const redirectingSpawnerLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      // The KiroAdapter passes a StandardCommand with command "kiro-cli" or a
      // full path ending in kiro-cli. Intercept and redirect to mock agent.
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: Record<string, unknown>;
      };
      if (cmd.command.includes("kiro-cli") || cmd.command.includes("kiro")) {
        capturedArgs.push(cmd.args);
        const redirected = ChildProcess.make("bun", ["run", mockAgentPath], {
          cwd: (cmd.options?.cwd as string) ?? process.cwd(),
          shell: process.platform === "win32",
        });
        return realSpawner.spawn(redirected);
      }
      return realSpawner.spawn(command);
    });
  }),
).pipe(Layer.provide(NodeChildProcessSpawner.layer));

/**
 * Minimal KiroProvider mock — we only need the service tag satisfied.
 */
const fakeSnapshot: ServerProvider = {
  provider: "kiro",
  enabled: true,
  installed: true,
  version: "0.0.0-test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date().toISOString(),
  models: [],
  slashCommands: [],
  skills: [],
};

const fakeKiroProvider: KiroProviderShape = {
  getSnapshot: Effect.succeed(fakeSnapshot),
  refresh: Effect.succeed(fakeSnapshot),
  streamChanges: Stream.empty,
  patchSlashCommands: () => Effect.void,
};

/**
 * Compose the adapter layer with test dependencies.
 *
 * NodeServices provides FileSystem, Path, Stdio, Terminal, and the base
 * ChildProcessSpawner. We then override the spawner with our redirecting
 * layer so kiro-cli calls go to the mock agent.
 */
const adapterLayer = makeKiroAdapterLive().pipe(
  Layer.provideMerge(Layer.succeed(KiroProvider, fakeKiroProvider)),
  Layer.provideMerge(redirectingSpawnerLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("KiroAdapterLive integration", () => {
  it.effect("startSession initializes and creates session, hasSession returns true", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-start-1");

      const session = yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(session.provider).toBe("kiro");
      expect(session.threadId).toBe(threadId);
      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toBeDefined();

      const has = yield* adapter.hasSession(threadId);
      expect(has).toBe(true);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("stopSession tears down and hasSession returns false", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-stop-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      const has = yield* adapter.hasSession(threadId);
      expect(has).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("sendTurn dispatches prompt and receives content.delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-turn-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // Fork a fiber to collect the first content.delta event
      const deltaFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta"),
        Stream.runHead,
        Effect.forkChild,
      );

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello kiro",
        attachments: [],
      });

      expect(turn.threadId).toBe(threadId);
      expect(turn.turnId).toBeDefined();

      const deltaEvent = yield* Fiber.join(deltaFiber);
      expect(deltaEvent._tag).toBe("Some");
      if (deltaEvent._tag === "Some") {
        expect(deltaEvent.value.type).toBe("content.delta");
        if (deltaEvent.value.type === "content.delta") {
          expect(deltaEvent.value.payload.delta).toBe("hello from kiro mock");
        }
      }

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("emits session.started and turn.completed runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-events-1");

      // Collect runtime events
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const eventTypes = events.map((e) => e.type);

      expect(eventTypes).toContain("session.started");
      expect(eventTypes).toContain("turn.started");
      expect(eventTypes).toContain("turn.completed");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("listSessions returns active sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-list-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sessions = yield* adapter.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s) => s.threadId === threadId)).toBe(true);

      yield* adapter.stopSession(threadId);

      const afterStop = yield* adapter.listSessions();
      expect(afterStop.some((s) => s.threadId === threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("passes --agent flag when agent is selected in model options", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-agent-flag-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          provider: "kiro",
          model: "auto",
          options: [{ id: "agent", value: "custom-agent" }],
        },
      });

      // Verify the spawned args include --agent custom-agent
      const spawnedArgs = capturedArgs[capturedArgs.length - 1];
      expect(spawnedArgs).toBeDefined();
      expect(spawnedArgs).toContain("--agent");
      expect(spawnedArgs).toContain("custom-agent");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "switches agent in-session via session/set_mode without respawning kiro-cli",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-agent-set-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "agent-one" }],
          },
        });

        const startupSpawnCount = capturedArgs.length;
        const startupArgs = capturedArgs[startupSpawnCount - 1];
        expect(startupArgs).toContain("--agent");
        expect(startupArgs).toContain("agent-one");

        // Agent change MUST NOT respawn the child process — set_mode RPC only.
        yield* adapter.sendTurn({
          threadId,
          input: "switch agent",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "agent-two" }],
          },
        });

        // Critical assertion: spawn count unchanged.
        expect(capturedArgs.length).toBe(startupSpawnCount);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "fires session/set_mode on the first turn when a concrete agent is selected",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-agent-first-turn");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "ncs-agent" }],
          },
        });

        const spawnCountAfterStart = capturedArgs.length;

        // First turn with the same agent that was selected at startSession.
        // set_mode should fire to align Kiro's state, without respawn.
        yield* adapter.sendTurn({
          threadId,
          input: "hi",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "ncs-agent" }],
          },
        });

        expect(capturedArgs.length).toBe(spawnCountAfterStart);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "fires session/set_model on the first turn when a concrete model is selected",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-first-turn");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "claude-opus-4.6",
          },
        });

        // First turn with the same model that was selected at startSession.
        // Without the activeModel-based gate, set_model would not fire here
        // and Kiro would stay on its internal default (often a deprecated
        // preview like claude-opus-4.6-1m).
        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "claude-opus-4.6",
          },
        });

        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("claude-opus-4.6");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "switches model in-session via session/set_model without respawning kiro-cli",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-set-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        const spawnCountAfterStart = capturedArgs.length;

        // First turn on model "auto" — no set_model call expected
        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
        });

        // Second turn switches model — should call set_model, NOT respawn
        yield* adapter.sendTurn({
          threadId,
          input: "second turn with switched model",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "claude-sonnet-4.6",
          },
        });

        // Critical assertion: no new spawn fired. Model change is an in-session
        // RPC, not a process restart.
        expect(capturedArgs.length).toBe(spawnCountAfterStart);

        // Session state reflects the new model.
        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("claude-sonnet-4.6");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "does not respawn when sendTurn keeps the same agent",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-agent-same-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "agent-stable" }],
          },
        });

        const spawnCountAfterStart = capturedArgs.length;

        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: [{ id: "agent", value: "agent-stable" }],
          },
        });

        expect(capturedArgs.length).toBe(spawnCountAfterStart);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );


  it.effect(
    "updates session.model immediately after in-session model switch",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-state-1");

        const session = yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        expect(session.model).toBe("auto");

        // Collect turn.started events to verify model is correct after in-session switch
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "turn.started" || event.type === "turn.completed",
          ),
          Stream.take(2), // turn.started + turn.completed for the model-switch turn
          Stream.runCollect,
          Effect.forkChild,
        );

        // Send turn with new model (triggers in-session set_model RPC)
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "switch model turn",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "claude-sonnet-4-20250514",
          },
        });

        expect(turn.threadId).toBe(threadId);

        const events = yield* Fiber.join(eventsFiber);
        const turnStarted = events.find((e) => e.type === "turn.started");
        expect(turnStarted).toBeDefined();
        if (turnStarted?.type === "turn.started") {
          expect(turnStarted.payload.model).toBe("claude-sonnet-4-20250514");
        }

        // Verify session state reflects the new model
        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("claude-sonnet-4-20250514");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "does not call setModel when model is unchanged between turns",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-unchanged-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        // Two turns with the same model — should not trigger setModel
        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection: { provider: "kiro", model: "auto" },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "second turn same model",
          attachments: [],
          modelSelection: { provider: "kiro", model: "auto" },
        });

        // Both turns should succeed without issues (no setModel called)
        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("auto");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("emits turn.plan.updated from native ACP plan session/update", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-plan-native-1");

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "emit:plan please",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const planEvents = events.filter((e) => e.type === "turn.plan.updated");

      expect(planEvents).toHaveLength(1);
      const [planEvent] = planEvents;
      expect(planEvent).toBeDefined();
      if (planEvent?.type === "turn.plan.updated") {
        expect(planEvent.payload.plan).toEqual([
          { step: "Research spec", status: "inProgress" },
          { step: "Draft PR", status: "pending" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("synthesizes turn.plan.updated from todo_list tool call", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-plan-todos-1");

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "emit:todos please",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const planEvents = events.filter((e) => e.type === "turn.plan.updated");

      expect(planEvents).toHaveLength(1);
      const [planEvent] = planEvents;
      expect(planEvent).toBeDefined();
      if (planEvent?.type === "turn.plan.updated") {
        expect(planEvent.payload.plan).toEqual([
          { step: "Read files", status: "inProgress" },
          { step: "Write tests", status: "pending" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("synthesizes turn.plan.updated progression from create → complete", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-plan-progression-1");

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "emit:todos-progression please",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const planEvents = events.filter(
        (e): e is Extract<typeof e, { type: "turn.plan.updated" }> =>
          e.type === "turn.plan.updated",
      );

      expect(planEvents.length).toBeGreaterThanOrEqual(2);
      const first = planEvents[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.payload.plan).toEqual([
          { step: "First task", status: "inProgress" },
          { step: "Second task", status: "pending" },
        ]);
      }
      const last = planEvents[planEvents.length - 1];
      expect(last).toBeDefined();
      if (last) {
        expect(last.payload.plan).toEqual([
          { step: "First task", status: "completed" },
          { step: "Second task", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );
});
