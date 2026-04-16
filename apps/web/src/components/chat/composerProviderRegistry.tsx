import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderAgent,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  resolveEffort,
} from "@t3tools/shared/model";
import { ChevronDownIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  getProviderModelCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
} from "../../providerModels";
import { useServerProviders } from "../../rpc/serverState";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : "reasoning" in providerOptions
          ? providerOptions.reasoning
          : null
    : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  // Normalize options for dispatch
  const normalizedOptions = {
    codex: normalizeCodexModelOptionsWithCapabilities(caps, modelOptions?.codex),
    cursor: normalizeCursorModelOptionsWithCapabilities(caps, modelOptions?.cursor),
    claudeAgent: normalizeClaudeModelOptionsWithCapabilities(caps, modelOptions?.claudeAgent),
    kiro: modelOptions?.kiro,
    acp: undefined,
  }[provider];

  // Ultrathink styling (driven by capabilities data, not provider identity)
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? { composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]" }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Kiro agent picker
// ---------------------------------------------------------------------------

const FALLBACK_AGENTS: readonly ServerProviderAgent[] = [{ name: "kiro_default", isDefault: true }];

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

function useKiroAgentChange(threadId: ThreadId) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (agent: string) => {
      if (!threadId) return;
      setProviderModelOptions(threadId, "kiro", { agent }, { persistSticky: true });
    },
    [threadId, setProviderModelOptions],
  );
}

/**
 * Connected wrapper that pulls agents from server providers and wires up
 * the draft-store persistence via `useKiroAgentChange`.
 */
const KiroAgentPickerConnected = memo(function KiroAgentPickerConnectedImpl({
  threadId,
  modelOptions,
}: {
  threadId: ThreadId;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
}) {
  const providers = useServerProviders();
  const kiroProvider = providers.find((p) => p.provider === "kiro");
  const agents = kiroProvider?.agents ?? [];
  const selectedAgent = (modelOptions as ProviderModelOptions["kiro"] | undefined)?.agent ?? "";
  const onAgentChange = useKiroAgentChange(threadId);
  return (
    <KiroAgentPicker agents={agents} selectedAgent={selectedAgent} onAgentChange={onAgentChange} />
  );
});

const KiroAgentMenuContentConnected = memo(function KiroAgentMenuContentConnectedImpl({
  threadId,
  modelOptions,
}: {
  threadId: ThreadId;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
}) {
  const providers = useServerProviders();
  const kiroProvider = providers.find((p) => p.provider === "kiro");
  const agents = kiroProvider?.agents ?? [];
  const effectiveAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const selectedAgent = (modelOptions as ProviderModelOptions["kiro"] | undefined)?.agent ?? "";
  const label =
    selectedAgent ||
    effectiveAgents.find((a) => a.isDefault)?.name ||
    effectiveAgents[0]?.name ||
    "kiro_default";
  const onAgentChange = useKiroAgentChange(threadId);
  return (
    <KiroAgentMenuContent
      agents={effectiveAgents}
      selectedAgent={selectedAgent || label}
      onAgentChange={onAgentChange}
    />
  );
});

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "codex",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "codex",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "claudeAgent",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "claudeAgent",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  cursor: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "cursor",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "cursor",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  kiro: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, modelOptions }) => (
      <KiroAgentMenuContentConnected threadId={threadId} modelOptions={modelOptions} />
    ),
    renderTraitsPicker: ({ threadId, modelOptions }) => (
      <KiroAgentPickerConnected threadId={threadId} modelOptions={modelOptions} />
    ),
  },
  acp: {
    getState: (input) => ({
      provider: input.provider,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    }),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsPicker({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}
