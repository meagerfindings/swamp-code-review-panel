import { z } from "npm:zod@4";

/**
 * @module code-review-panel
 *
 * Run a panel of independent reviewer personas over ONE body of code and return
 * unified, actionable findings.
 *
 * Where a rubric-grading model grades N pull requests against a single rubric,
 * this model does the transpose: one context (a PR's final-state diff, a working
 * tree, or any supplied code) reviewed by N personas, each persona a slash
 * command or role instruction run through the `cli-agent` model in readonly
 * mode. The output is a merged findings list — severity + concrete fix per
 * finding, not letter grades — that a synthesis step can rank and a human can
 * turn into changes.
 *
 * Generic and host-agnostic: personas, context, provider, and the working
 * directory are all inputs; nothing here is specific to any codebase. Fan-out is
 * a sequential loop of `swamp model method run cli-agent` subprocesses, so it
 * never contends on this model's own lock. Each persona is retried once if it
 * returns unparseable output, because prose drift is the most common failure
 * mode of headless review agents.
 */

/** Configuration shared across every method invocation. */
const GlobalArgsSchema = z.object({
  /** cli-agent model instance used to run each persona. */
  cliAgentModel: z.string().default("cli-agent"),
  /** Swamp repo dir the cli-agent invocations run against. Defaults to the current working directory. */
  swampRepoDir: z.string().default(Deno.cwd()),
  /** Working directory the reviewer agents run in (the code under review). */
  repoPath: z.string().default(Deno.cwd()),
  /** Default CLI provider + model for review passes. */
  reviewProvider: z.string().default("claude"),
  reviewModelId: z.string().default("sonnet"),
  /** Per-persona wall timeout (ms). */
  reviewTimeoutMs: z.number().default(300_000),
});

const FindingSchema = z.object({
  /** Which persona surfaced this (slash command / rubric name). */
  persona: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "nit"]),
  /** Short kebab-case category, e.g. "n-plus-one", "srp-violation", "ai-slop". */
  category: z.string(),
  file: z.string().optional(),
  line: z.number().nullable().optional(),
  title: z.string(),
  rationale: z.string(),
  /** Concrete fix suggestion, or null when the finding is informational. */
  suggestedFix: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});

const PanelReviewSchema = z.object({
  reviewedAt: z.string(),
  repoPath: z.string(),
  /** Free-form label for what was reviewed (e.g. "PR #24375 final state"). */
  target: z.string(),
  personas: z.array(z.string()),
  findings: z.array(FindingSchema),
  /** Personas that failed to run (agent error/timeout), for transparency. */
  skipped: z.array(z.object({ persona: z.string(), reason: z.string() })),
  /** Count by severity, for a caller's summary bar. */
  severityCounts: z.record(z.string(), z.number()),
}).passthrough();

/** A single reviewer finding surfaced by one persona. */
export type Finding = z.infer<typeof FindingSchema>;
/** The merged output of a panel run: all findings plus run metadata. */
export type PanelReview = z.infer<typeof PanelReviewSchema>;

/** Result of a shelled-out command. */
type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Run a `swamp` subcommand in the given repo directory and capture its output. */
async function runSwampCmd(
  args: string[],
  repoDir: string,
): Promise<CmdResult> {
  const command = new Deno.Command("swamp", {
    args: [...args, "--repo-dir", repoDir],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/** Invoke the cli-agent model's `invokeAndParse` method and return its parsed JSON response. */
async function invokeCliAgent(
  cliAgentModel: string,
  repoDir: string,
  opts: {
    prompt: string;
    provider: string;
    model: string;
    cwd: string;
    tags: Record<string, string>;
    wallTimeoutMs: number;
    toolProfile: "readonly" | "actor";
  },
): Promise<
  { success: boolean; output: Record<string, unknown> | null; error?: string }
> {
  const inputFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    inputFile,
    JSON.stringify({
      prompt: opts.prompt,
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
      tags: opts.tags,
      wallTimeoutMs: opts.wallTimeoutMs,
      toolProfile: opts.toolProfile,
    }),
  );
  const result = await runSwampCmd(
    [
      "model",
      "method",
      "run",
      cliAgentModel,
      "invokeAndParse",
      "--input-file",
      inputFile,
      "--json",
    ],
    repoDir,
  );
  try {
    await Deno.remove(inputFile);
  } catch { /* cleanup */ }

  if (!result.success) {
    const detail = result.stderr.slice(0, 500) || result.stdout.slice(0, 500) ||
      `exit ${result.code}`;
    return {
      success: false,
      output: null,
      error: `CLI failed (exit ${result.code}): ${detail}`,
    };
  }
  try {
    const data = JSON.parse(result.stdout);
    if (data.error || data.status === "failed") {
      return {
        success: false,
        output: null,
        error: data.error ?? "method failed",
      };
    }
    const artifact = data.dataArtifacts?.[0]?.attributes;
    if (!artifact?.parsedResponse) {
      return {
        success: false,
        output: null,
        error: "no parsedResponse in cli-agent output",
      };
    }
    return {
      success: true,
      output: artifact.parsedResponse as Record<string, unknown>,
    };
  } catch (e) {
    return {
      success: false,
      output: null,
      error: `parse error: ${(e as Error).message}`,
    };
  }
}

/**
 * Build the per-persona review prompt. When `persona` looks like a slash
 * command (starts with "/"), it is passed through so cli-agent resolves it from
 * its commands dir; otherwise it is treated as a role instruction. Either way
 * the shared context and the required JSON output contract are appended.
 */
export function buildPersonaPrompt(
  persona: string,
  target: string,
  context: string,
): string {
  const isCommand = persona.trim().startsWith("/");
  const roleLine = isCommand
    ? `Run the ${persona} review.`
    : `Act as the "${persona}" code reviewer.`;

  return `${roleLine}

You are reviewing: ${target}
Review ONLY the code in the context below. Read surrounding files in the working tree to confirm
findings, but do not review code outside the changes described here.

--- CONTEXT ---
${context}
--- END CONTEXT ---

Report concrete, actionable findings. Skip praise and generic observations. For each finding give a
severity (critical/high/medium/low/nit), a short kebab-case category, the file and line if known, a
one-line title, a rationale grounded in the actual code, and a concrete suggestedFix (or null if
informational). Only report issues you are confident are real.

Do NOT write a summary, preamble, or any prose. Your ENTIRE response must be a single fenced JSON
block and nothing else — no text before or after the fence:

\`\`\`json
{"findings": [{"severity": "high", "category": "n-plus-one", "file": "path.rb", "line": 42, "title": "...", "rationale": "...", "suggestedFix": "...", "confidence": "high"}]}
\`\`\`

If there are no findings, respond with a fenced block containing {"findings": []}.`;
}

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/**
 * The `@mgreten/code-review-panel` model. Exposes a single `review` method that
 * fans a panel of reviewer personas over one code context and writes a merged
 * `panelReview` resource of findings.
 */
export const model = {
  type: "@mgreten/code-review-panel",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    panelReview: {
      description:
        "Unified findings from a panel of reviewer personas over one body of code. " +
        "Findings only (severity + fix), not grades — feeds a synthesis/fix step.",
      schema: PanelReviewSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    review: {
      description:
        "Run each persona (slash command or role) over the supplied context via cli-agent " +
        "(readonly), merge into one findings list with severity counts. Never edits or commits.",
      arguments: z.object({
        target: z.string().describe(
          "Label for what is under review, e.g. 'PR #24375 final state'",
        ),
        context: z.string().describe(
          "The code context to review — a diff, file dump, or summary. Passed to every persona.",
        ),
        personas: z.array(z.string()).min(1).describe(
          "Reviewer personas: slash commands (e.g. '/ai-slop-check') resolved by cli-agent, " +
            "or role names used as instructions.",
        ),
        provider: z.string().optional().describe(
          "Override CLI provider for this run",
        ),
        model: z.string().optional().describe(
          "Override CLI model for this run",
        ),
        nowIso: z.string().optional().describe(
          "ISO timestamp for the bundle (deterministic tests)",
        ),
      }),
      execute: async (
        args: {
          target: string;
          context: string;
          personas: string[];
          provider?: string;
          model?: string;
          nowIso?: string;
        },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const provider = args.provider ?? g.reviewProvider;
        const modelId = args.model ?? g.reviewModelId;

        const findings: z.infer<typeof FindingSchema>[] = [];
        const skipped: Array<{ persona: string; reason: string }> = [];

        for (const persona of args.personas) {
          context.logger.info("Running persona {persona}", { persona });
          const basePrompt = buildPersonaPrompt(
            persona,
            args.target,
            args.context,
          );
          let agentResult = await invokeCliAgent(
            g.cliAgentModel,
            g.swampRepoDir,
            {
              prompt: basePrompt,
              provider,
              model: modelId,
              cwd: g.repoPath,
              tags: { phase: "code-review-panel", persona },
              wallTimeoutMs: g.reviewTimeoutMs,
              toolProfile: "readonly",
            },
          );

          // Reviewers routinely drift into prose and produce no parseable JSON.
          // Retry once with a terse format-only reminder before giving up — this
          // is the single most common failure mode of headless review agents.
          if (
            (!agentResult.success || !agentResult.output) &&
            /parseable JSON|parse error/i.test(agentResult.error ?? "")
          ) {
            context.logger.warning(
              "Persona {persona} returned unparseable output; retrying JSON-only",
              { persona },
            );
            agentResult = await invokeCliAgent(
              g.cliAgentModel,
              g.swampRepoDir,
              {
                prompt: basePrompt +
                  `\n\nYour previous response was not valid JSON. Respond with ONLY a \`\`\`json fenced block ` +
                  `containing {"findings": [...]}. No summary, no prose, nothing outside the fence.`,
                provider,
                model: modelId,
                cwd: g.repoPath,
                tags: { phase: "code-review-panel", persona, retry: "1" },
                wallTimeoutMs: g.reviewTimeoutMs,
                toolProfile: "readonly",
              },
            );
          }

          if (!agentResult.success || !agentResult.output) {
            context.logger.warning("Persona {persona} skipped: {err}", {
              persona,
              err: agentResult.error ?? "unknown",
            });
            skipped.push({ persona, reason: agentResult.error ?? "unknown" });
            continue;
          }

          const raw =
            (agentResult.output as { findings?: unknown[] }).findings ?? [];
          let count = 0;
          for (const f of raw) {
            const fo = f as Record<string, unknown>;
            findings.push({
              persona,
              severity:
                (fo.severity as z.infer<typeof FindingSchema>["severity"]) ??
                  "medium",
              category: String(fo.category ?? "general"),
              file: fo.file ? String(fo.file) : undefined,
              line: typeof fo.line === "number" ? fo.line : null,
              title: String(fo.title ?? ""),
              rationale: String(fo.rationale ?? ""),
              suggestedFix: fo.suggestedFix != null
                ? String(fo.suggestedFix)
                : null,
              confidence: (fo.confidence as z.infer<
                typeof FindingSchema
              >["confidence"]) ?? "medium",
            });
            count++;
          }
          context.logger.info("Persona {persona}: {n} finding(s)", {
            persona,
            n: count,
          });
        }

        const severityCounts: Record<string, number> = {};
        for (const f of findings) {
          severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
        }

        const panelReview = {
          reviewedAt: args.nowIso ?? new Date().toISOString(),
          repoPath: g.repoPath,
          target: args.target,
          personas: args.personas,
          findings,
          skipped,
          severityCounts,
        };

        const safeTarget = args.target.replace(/[^a-zA-Z0-9]+/g, "-").replace(
          /^-|-$/g,
          "",
        ).slice(0, 40);
        const handle = await context.writeResource(
          "panelReview",
          `panel-${safeTarget || "review"}`,
          panelReview as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Panel complete: {f} finding(s) across {p} persona(s), {s} skipped",
          {
            f: findings.length,
            p: args.personas.length,
            s: skipped.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
