import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface CursorProviderShape extends ServerProviderShape {}

export class CursorProvider extends Context.Tag("t3/provider/Services/CursorProvider")<
  CursorProvider,
  CursorProviderShape
>() {}
