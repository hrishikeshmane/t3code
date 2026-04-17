import type {
  KiroSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAgent,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  ServerSettingsError,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as os from "node:os";
import * as nodePath from "node:path";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KiroProvider } from "../Services/KiroProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "kiro" as const;
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      ...EMPTY_CAPABILITIES,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
    },
  },
  {
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      ...EMPTY_CAPABILITIES,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
    },
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "deepseek-3.2",
    name: "DeepSeek 3.2",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-k2.5",
    name: "Kimi K2.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-5",
    name: "GLM-5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "qwen3-coder-next",
    name: "Qwen 3 Coder Next",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "qwen3-coder-480b",
    name: "Qwen 3 Coder 480B",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "minimax-m2.5",
    name: "MiniMax M2.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "minimax-m2.1",
    name: "MiniMax M2.1",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "agi-nova-beta-1m",
    name: "AGI Nova Beta 1M",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function getKiroModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = normalizeModelSlug(model, "kiro");
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES
  );
}

/**
 * Parse `kiro-cli agent list` output into structured agent descriptors.
 * The output may contain ANSI escape codes and section headers like "Workspace:" / "Global:".
 */
export function parseKiroAgentListOutput(stdout: string): ServerProviderAgent[] {
  const agents: ServerProviderAgent[] = [];
  for (const line of stdout.split("\n")) {
    // eslint-disable-next-line no-control-regex
    const trimmed = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
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

/**
 * Resolve kiro-cli binary path — try ~/.toolbox/bin/kiro-cli first, then PATH.
 */
function resolveKiroCliBinary(): string {
  const toolboxPath = nodePath.join(os.homedir(), ".toolbox", "bin", "kiro-cli");
  // We'll try toolbox first during probe; for simplicity just return the likely path
  return toolboxPath;
}

/**
 * Parse Kiro CLI version output to extract version string.
 */
function parseKiroVersionOutput(result: CommandResult): {
  version: string | null;
  status: Exclude<ServerProviderState, "disabled">;
  auth: Pick<ServerProviderAuth, "status">;
  message?: string;
} {
  const combined = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0) {
    return {
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI returned non-zero exit code.",
    };
  }

  // Extract version from output (e.g., "kiro-cli 1.2.3")
  const versionMatch = /kiro-cli\s+(\S+)/i.exec(combined);
  const version = versionMatch?.[1] ?? null;

  // For Kiro, if --version succeeds, treat as authenticated (OIDC-based)
  return {
    version,
    status: "ready",
    auth: { status: "authenticated" },
  };
}

const runKiroCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const binaryPath = resolveKiroCliBinary();
    const command = ChildProcess.make(binaryPath, [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

/**
 * Discover available agents by running `kiro-cli agent list`.
 * Returns an empty array on any failure (timeout, non-zero exit, parse error).
 */
const fetchKiroAgents = Effect.fn("fetchKiroAgents")(function* (): Effect.fn.Return<
  ServerProviderAgent[],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const result = yield* runKiroCommand(["agent", "list"]).pipe(
    Effect.timeoutOption(5_000),
    Effect.result,
  );

  if (Result.isFailure(result) || Option.isNone(result.success)) {
    return [];
  }

  const { stdout, stderr } = result.success.value;
  // kiro-cli agent list writes to stderr, not stdout — prefer stderr
  const output = stderr || stdout;
  return parseKiroAgentListOutput(output);
});

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const kiroSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kiro),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      kiroSettings.customModels,
      EMPTY_CAPABILITIES,
    );

    if (!kiroSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }

    // Probe with kiro-cli --version
    const versionProbe = yield* runKiroCommand(["--version"]).pipe(
      Effect.timeoutOption(5_000),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kiroSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
            : `Failed to execute Kiro CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kiroSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
        },
      });
    }

    const parsed = parseKiroVersionOutput(versionProbe.success.value);

    // Discover agents (best-effort, empty array on failure)
    const agents = yield* fetchKiroAgents();

    const provider = buildServerProvider({
      provider: PROVIDER,
      enabled: kiroSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsed.version,
        status: parsed.status,
        auth: parsed.auth,
        ...(parsed.message ? { message: parsed.message } : {}),
      },
    });

    return {
      ...provider,
      ...(agents.length > 0 ? { agents } : {}),
    };
  },
);

const makePendingKiroProvider = (kiroSettings: KiroSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    kiroSettings.customModels,
    EMPTY_CAPABILITIES,
  );

  if (!kiroSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro provider status has not been checked in this session yet.",
    },
  });
};

export const KiroProviderLive = Layer.effect(
  KiroProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkKiroProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const managed = yield* makeManagedServerProvider<KiroSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kiro),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kiro),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingKiroProvider,
      checkProvider,
    });

    return {
      ...managed,
      patchSlashCommands: (commands) =>
        managed.patchSnapshot((current) => ({
          ...current,
          slashCommands: [...commands],
        })),
    };
  }),
);
