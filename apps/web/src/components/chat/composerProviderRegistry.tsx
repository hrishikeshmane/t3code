import {
  type ProviderKind,
  type ProviderModelOptions,
  type ScopedThreadRef,
  type ServerProviderAgent,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  resolveEffort,
} from "@t3tools/shared/model";
import { ChevronDownIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import {
  getProviderModelCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
} from "../../providerModels";
import { useServerProviders } from "../../rpc/serverState";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

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
    threadRef?: ScopedThreadRef | undefined;
    draftId?: DraftId | undefined;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadRef?: ScopedThreadRef | undefined;
    draftId?: DraftId | undefined;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  /**
   * Handle a provider-specific slash command (e.g. /agent, /compact).
   * Returns true if the command was handled interactively (e.g. opened a picker).
   */
  handleSlashCommand?: (command: string) => boolean;
};

function hasComposerTraitsTarget(input: {
  threadRef: ScopedThreadRef | undefined;
  draftId: DraftId | undefined;
}): boolean {
  return input.threadRef !== undefined || input.draftId !== undefined;
}

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

/**
 * Imperative handle for opening the Kiro agent picker from outside React
 * component tree (e.g. from slash command handlers). The active picker
 * registers itself on mount and clears on unmount.
 */
const kiroAgentPickerRef: { current: (() => void) | null } = { current: null };

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

  // Register imperative open handle so slash commands can open the picker
  const openRef = useRef(() => setIsMenuOpen(true));
  openRef.current = () => setIsMenuOpen(true);
  useEffect(() => {
    kiroAgentPickerRef.current = () => openRef.current();
    return () => {
      kiroAgentPickerRef.current = null;
    };
  }, []);

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
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

function useKiroAgentChange(threadRef: ScopedThreadRef | undefined, draftId: DraftId | undefined) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (agent: string) => {
      const target = threadRef ?? draftId;
      if (!target) return;
      setProviderModelOptions(target, "kiro", { agent }, { persistSticky: true });
    },
    [threadRef, draftId, setProviderModelOptions],
  );
}

/**
 * Connected wrapper that pulls agents from server providers and wires up
 * the draft-store persistence via `useKiroAgentChange`.
 */
const KiroAgentPickerConnected = memo(function KiroAgentPickerConnectedImpl({
  threadRef,
  draftId,
  modelOptions,
}: {
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
}) {
  const providers = useServerProviders();
  const kiroProvider = providers.find((p) => p.provider === "kiro");
  const agents = kiroProvider?.agents ?? [];
  const selectedAgent = (modelOptions as ProviderModelOptions["kiro"] | undefined)?.agent ?? "";
  const onAgentChange = useKiroAgentChange(threadRef, draftId);
  return (
    <KiroAgentPicker agents={agents} selectedAgent={selectedAgent} onAgentChange={onAgentChange} />
  );
});

const KiroAgentMenuContentConnected = memo(function KiroAgentMenuContentConnectedImpl({
  threadRef,
  draftId,
  modelOptions,
}: {
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
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
  const onAgentChange = useKiroAgentChange(threadRef, draftId);
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
    renderTraitsMenuContent: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsMenuContent
          provider="codex"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
    renderTraitsPicker: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsPicker
          provider="codex"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsMenuContent
          provider="claudeAgent"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
    renderTraitsPicker: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsPicker
          provider="claudeAgent"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
  },
  cursor: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsMenuContent
          provider="cursor"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
    renderTraitsPicker: ({
      threadRef,
      draftId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) =>
      !hasComposerTraitsTarget({ threadRef, draftId }) ? null : (
        <TraitsPicker
          provider="cursor"
          models={models}
          {...(threadRef ? { threadRef } : {})}
          {...(draftId ? { draftId } : {})}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ),
  },
  kiro: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadRef, draftId, modelOptions }) => (
      <KiroAgentMenuContentConnected
        {...(threadRef ? { threadRef } : {})}
        {...(draftId ? { draftId } : {})}
        modelOptions={modelOptions}
      />
    ),
    renderTraitsPicker: ({ threadRef, draftId, modelOptions }) => (
      <KiroAgentPickerConnected
        {...(threadRef ? { threadRef } : {})}
        {...(draftId ? { draftId } : {})}
        modelOptions={modelOptions}
      />
    ),
    handleSlashCommand: (command) => {
      if (command === "agent" && kiroAgentPickerRef.current) {
        kiroAgentPickerRef.current();
        return true;
      }
      return false;
    },
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

/**
 * Attempt to handle a provider-specific slash command interactively.
 * Returns true if handled (e.g. opened a picker), false if the command
 * should be inserted as prompt text instead.
 */
export function handleProviderSlashCommand(provider: ProviderKind, command: string): boolean {
  return composerProviderRegistry[provider].handleSlashCommand?.(command) ?? false;
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    ...(input.threadRef ? { threadRef: input.threadRef } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsPicker({
    ...(input.threadRef ? { threadRef: input.threadRef } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}
