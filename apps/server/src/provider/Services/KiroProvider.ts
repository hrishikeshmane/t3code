import type { Effect } from "effect";
import { Context } from "effect";

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import type { ServerProviderShape } from "./ServerProvider";

export interface KiroProviderShape extends ServerProviderShape {
  readonly patchSlashCommands: (
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
}

export class KiroProvider extends Context.Tag("t3/provider/Services/KiroProvider")<
  KiroProvider,
  KiroProviderShape
>() {}
