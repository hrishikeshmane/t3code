import type {
  CursorModelOptions,
  CursorSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  ServerSettingsError,
} from "@t3tools/contracts";
import { normalizeModelSlug, resolveContextWindow, resolveEffort } from "@t3tools/shared/model";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CursorProvider } from "../Services/CursorProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "cursor" as const;
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Auto",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "composer-2",
    name: "Composer 2",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "composer-1.5",
    name: "Composer 1.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex",
    name: "Codex 5.3",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "Codex 5.3 Spark",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "272k", label: "272k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "claude-opus-4-6",
    name: "Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "grok-4-20",
    name: "Grok 4.20",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

export function getCursorModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = normalizeModelSlug(model, "cursor");
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES
  );
}

/**
 * Resolve the ACP model ID for a Cursor model to be sent to session/set_config_option
 */
export function resolveCursorAcpModelId(
  model: string | null | undefined,
  modelOptions: CursorModelOptions | null | undefined,
): string {
  const slug = normalizeModelSlug(model, "cursor") ?? "auto";
  if (slug.includes("[") && slug.endsWith("]")) {
    return slug;
  }
  const caps = getCursorModelCapabilities(slug);
  const isBuiltIn = BUILT_IN_MODELS.some((candidate) => candidate.slug === slug);
  if (!isBuiltIn) {
    return slug;
  }

  const traits: string[] = [];

  if (slug === "gpt-5.3-codex") {
    const reasoning = resolveEffort(caps, modelOptions?.reasoning) ?? "medium";
    traits.push(`reasoning=${reasoning}`);
    traits.push(`fast=${modelOptions?.fastMode === true}`);
    return `${slug}[${traits.join(",")}]`;
  }

  if (caps.supportsFastMode && modelOptions?.fastMode === true) {
    traits.push("fast=true");
  }

  if (modelOptions?.reasoning !== undefined) {
    const reasoning = resolveEffort(caps, modelOptions.reasoning);
    if (reasoning) {
      traits.push(`${slug.startsWith("claude-") ? "effort" : "reasoning"}=${reasoning}`);
    }
  }

  if (caps.supportsThinkingToggle && modelOptions?.thinking !== undefined) {
    traits.push(`thinking=${modelOptions.thinking}`);
  }

  if (modelOptions?.contextWindow !== undefined) {
    const contextWindow = resolveContextWindow(caps, modelOptions.contextWindow);
    if (contextWindow) {
      traits.push(`context=${contextWindow}`);
    }
  }

  return traits.length > 0 ? `${slug}[${traits.join(",")}]` : slug;
}

/**
 * Resolve the Agent CLI model ID for a Cursor model to be set as `--model` arg for the `agent` command.
 *
 * Yes... Cursor uses different IDs. No... I don't know why.
 */
export function resolveCursorAgentModel(
  model: string | null | undefined,
  modelOptions: CursorModelOptions | null | undefined,
): string {
  const normalized = normalizeModelSlug(model, "cursor") ?? "default";
  const slug = normalized.includes("[") ? normalized.slice(0, normalized.indexOf("[")) : normalized;
  const caps = getCursorModelCapabilities(slug);
  const reasoning = resolveEffort(caps, modelOptions?.reasoning);
  const thinking = caps.supportsThinkingToggle ? (modelOptions?.thinking ?? true) : undefined;
  const fastMode = modelOptions?.fastMode === true;

  switch (slug) {
    case "default":
      return "auto";
    case "composer-2":
      return fastMode ? "composer-2-fast" : "composer-2";
    case "composer-1.5":
      return "composer-1.5";
    case "gpt-5.3-codex": {
      const suffix = reasoning && reasoning !== "medium" ? `-${reasoning}` : "";
      return `gpt-5.3-codex${suffix}${fastMode ? "-fast" : ""}`;
    }
    case "gpt-5.3-codex-spark": {
      const suffix = reasoning && reasoning !== "medium" ? `-${reasoning}` : "";
      return `gpt-5.3-codex-spark-preview${suffix}`;
    }
    case "gpt-5.4":
      return `gpt-5.4-${reasoning ?? "medium"}${fastMode ? "-fast" : ""}`;
    case "claude-opus-4-6":
      return thinking ? "claude-4.6-opus-high-thinking" : "claude-4.6-opus-high";
    case "claude-sonnet-4-6":
      return thinking ? "claude-4.6-sonnet-medium-thinking" : "claude-4.6-sonnet-medium";
    case "gemini-3.1-pro":
      return "gemini-3.1-pro";
    case "grok-4-20":
      return thinking ? "grok-4-20-thinking" : "grok-4-20";
    default:
      return slug === "default" ? "auto" : slug;
  }
}

/** Timeout for `agent about` — it's slower than a simple `--version` probe. */
const ABOUT_TIMEOUT_MS = 8_000;

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  // Determine auth from the User Email field.
  if (userEmail === undefined) {
    // Field missing entirely — can't determine auth.
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  // Any non-empty email value means authenticated.
  return { version, status: "ready", auth: { status: "authenticated" } };
}

const runCursorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const command = ChildProcess.make(cursorSettings.binaryPath, [...args], {
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

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      cursorSettings.customModels,
    );

    if (!cursorSettings.enabled) {
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
          message: "Cursor is disabled in T3 Code settings.",
        },
      });
    }

    // Single `agent about` probe: returns version + auth status in one call.
    const aboutProbe = yield* runCursorCommand(["about"]).pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(aboutProbe)) {
      const error = aboutProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(aboutProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        },
      });
    }

    const parsed = parseCursorAboutOutput(aboutProbe.success.value);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: cursorSettings.enabled,
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
  },
);

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCursorProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CursorSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.cursor),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursor),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
