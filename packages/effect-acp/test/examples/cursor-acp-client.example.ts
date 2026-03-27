import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpClient from "../../src/client";

Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make("cursor-agent", ["acp"], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  const handle = yield* spawner.spawn(command);
  const client = yield* AcpClient.fromChildProcess(handle, {
    logIncoming: true,
    logOutgoing: true,
    handlers: {
      requestPermission: () =>
        Effect.succeed({
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        }),
      sessionUpdate: (notification) => Effect.logInfo("session/update", notification),
    },
  });

  const initialized = yield* client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: "effect-acp-example",
      version: "0.0.0",
    },
  });
  yield* Effect.logInfo("initialized", initialized);

  const session = yield* client.createSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  yield* client.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: "gpt-5.4[reasoning=medium,context=272k,fast=false]",
  });
  // yield* client.setSessionConfigOption({
  //   sessionId: session.sessionId,
  //   configId: "reasoning_effort",
  //   value: "high",
  // });
  // yield* client.setSessionConfigOption({
  //   sessionId: session.sessionId,
  //   configId: "context_size",
  //   value: "1m",
  // });
  // yield* client.setSessionConfigOption({
  //   sessionId: session.sessionId,
  //   configId: "fast_mode",
  //   type: "boolean",
  //   value: true,
  // });

  const result = yield* client.prompt({
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text: "Illustrate your ability to create todo lists and then execute all of them. Do not write the list to disk, illustrate your built in ability!",
      },
    ],
  });

  yield* Effect.logInfo("prompt result", result);
  yield* client.cancel({ sessionId: session.sessionId });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
