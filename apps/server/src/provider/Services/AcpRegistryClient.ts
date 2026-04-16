import type { AcpRegistryListResult } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface AcpRegistryClientShape {
  readonly listAgents: Effect.Effect<AcpRegistryListResult, Error>;
}

export class AcpRegistryClient extends Context.Service<
  AcpRegistryClient,
  AcpRegistryClientShape
>()("t3/provider/Services/AcpRegistryClient") {}
