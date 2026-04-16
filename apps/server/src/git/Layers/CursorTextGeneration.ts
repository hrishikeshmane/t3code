import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CursorModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import {
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import { resolveCursorAgentModel } from "../../provider/Layers/CursorProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const CURSOR_TIMEOUT_MS = 180_000;

const CursorOutputEnvelope = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
});

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

const makeCursorTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("agent", operation, cause, "Failed to collect process output"),
      ),
    );

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CursorModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const cursorSettings = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => settings.providers.cursor,
      ).pipe(Effect.catch(() => Effect.undefined));

      const runCursorCommand = Effect.gen(function* () {
        const command = ChildProcess.make(
          cursorSettings?.binaryPath || "agent",
          [
            "-p",
            "--trust",
            "--mode",
            "ask",
            "--output-format",
            "json",
            "--model",
            resolveCursorAgentModel(modelSelection.model, modelSelection.options),
          ],
          {
            cwd,
            shell: process.platform === "win32",
            stdin: {
              stream: Stream.encodeText(Stream.make(prompt)),
            },
          },
        );

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("agent", operation, cause, "Failed to spawn Cursor Agent process"),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.mapError((cause) =>
                normalizeCliError(
                  "agent",
                  operation,
                  cause,
                  "Failed to read Cursor Agent exit code",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        const commandOutput = { stdout, stderr, exitCode };

        if (exitCode !== 0) {
          const stderrDetail = stderr.trim();
          const stdoutDetail = stdout.trim();
          const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
          return yield* new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Cursor Agent command failed: ${detail}`
                : `Cursor Agent command failed with code ${exitCode}.`,
          });
        }

        return commandOutput;
      });

      const commandOutput = yield* runCursorCommand.pipe(
        Effect.scoped,
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(CursorOutputEnvelope))(
        commandOutput.stdout,
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Cursor Agent returned unexpected output format.",
              cause,
            }),
          ),
        ),
      );

      if (
        envelope.type !== "result" ||
        envelope.subtype !== "success" ||
        envelope.is_error === true
      ) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor Agent returned an unsuccessful result.",
        });
      }

      const rawResult = envelope.result?.trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor Agent returned empty output.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(rawResult),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Cursor Agent returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
