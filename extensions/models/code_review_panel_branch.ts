import { z } from "npm:zod@4";

/**
 * @module code-review-panel-branch
 *
 * Branch-aware orchestration layer over `@mgreten/code-review-panel`.
 *
 * The base `review` method reviews ONE supplied `context` string with an
 * explicit list of `personas`. In practice a human running a panel over a git
 * branch does the same three chores by hand every time:
 *
 *   1. produce the diff — `git diff <base>...<head>` in the repo under review;
 *   2. decide the panel — a fixed roster of reviewers, minus whichever one they
 *      want to skip this run;
 *   3. give each reviewer its definition — the persona bodies live on disk at
 *      `<repo>/.claude/agents/<name>.md`, not as slash commands.
 *
 * This extension adds a `reviewBranch` method that does all three
 * deterministically and then delegates to the proven `review` fan-out via a
 * single `swamp model method run <self> review` subprocess. It never edits or
 * commits, and it never loops the panel from the caller — one method call runs
 * the whole panel, so callers don't contend on the model lock (repo rule 6).
 *
 * The default roster deliberately excludes the `integrations` reviewer; it is
 * opt-in via `reviewers`. Any reviewer can be dropped per-run with `exclude`.
 */

/**
 * The fixed default review panel, in run order. The `integrations` reviewer is
 * intentionally NOT here — it is heavy and only relevant to integration work,
 * so it must be requested explicitly via the `reviewers` argument.
 */
export const DEFAULT_PANEL = [
  "ai-slop-detector",
  "query-performance",
  "oop-reviewer",
  "rails-master",
] as const;

/** Result of a shelled-out command. */
type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Run an arbitrary command in a working directory and capture its output. */
async function runCmd(
  bin: string,
  args: string[],
  cwd: string,
): Promise<CmdResult> {
  const command = new Deno.Command(bin, {
    args,
    cwd,
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

/**
 * Strip a leading YAML frontmatter block (the `--- … ---` header the Claude
 * agent files carry) and return the reviewer's instruction body. If there is no
 * frontmatter, the whole file is returned unchanged.
 */
export function stripFrontmatter(md: string): string {
  const trimmed = md.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) return md.trim();
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return md.trim();
  const afterClose = trimmed.indexOf("\n", end + 1);
  return (afterClose === -1 ? "" : trimmed.slice(afterClose + 1)).trim();
}

/**
 * Resolve which reviewers run this pass. An explicit `reviewers` list wins and
 * is used verbatim (only de-duplicated); `exclude` applies ONLY when falling
 * back to the default panel — an explicit roster is taken as-is. Order is
 * preserved and duplicates are dropped.
 */
export function resolvePanel(
  reviewers: string[] | undefined,
  exclude: string[] | undefined,
): string[] {
  const explicit = !!(reviewers && reviewers.length > 0);
  const base = explicit ? reviewers! : [...DEFAULT_PANEL];
  // exclude only filters the default panel; an explicit roster is authoritative.
  const drop = explicit
    ? new Set<string>()
    : new Set((exclude ?? []).map((s) => s.trim()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of base) {
    const n = name.trim();
    if (!n || drop.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Build the persona role instruction for one reviewer from its agent-definition
 * body. The body IS the reviewer's role; we prepend a short line telling the
 * agent to apply it to the diff it will be handed in the shared context.
 */
export function buildReviewerPersona(name: string, agentBody: string): string {
  return `You are the "${name}" code reviewer. Apply the following reviewer ` +
    `definition to the diff supplied in the shared context. Read surrounding ` +
    `files in the working tree to confirm findings.\n\n` +
    `--- REVIEWER DEFINITION (${name}) ---\n${agentBody}\n` +
    `--- END REVIEWER DEFINITION ---`;
}

type MethodContext = {
  globalArgs: {
    cliAgentModel: string;
    swampRepoDir: string;
    repoPath: string;
    reviewProvider: string;
    reviewModelId: string;
    reviewTimeoutMs: number;
  };
  definition: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/**
 * Branch-review augmentation of `@mgreten/code-review-panel`. Adds a single
 * `reviewBranch` fan-out method; it reuses the base model's `panelReview`
 * resource (written by the delegated `review` call) and its global arguments.
 */
export const extension = {
  type: "@mgreten/code-review-panel",
  methods: [{
    reviewBranch: {
      description:
        "Run the fixed reviewer panel over a git branch diff. Computes " +
        "`git diff <base>...<head>` in repoPath, loads each reviewer's " +
        "`.claude/agents/<name>.md` body as its persona, then delegates to the " +
        "`review` fan-out. Default panel excludes the integrations reviewer. " +
        "Never edits or commits.",
      arguments: z.object({
        base: z.string().default("master").describe(
          "Base ref for the diff. Diff is `git diff <base>...<head>`.",
        ),
        head: z.string().default("HEAD").describe(
          "Head ref for the diff (default HEAD).",
        ),
        reviewers: z.array(z.string()).optional().describe(
          "Explicit reviewer roster (agent names under .claude/agents). " +
            "Overrides the default panel entirely. Use this to opt IN the " +
            "integrations reviewer.",
        ),
        exclude: z.array(z.string()).optional().describe(
          "Reviewer names to drop from the default panel for this run only " +
            "(e.g. ['integrations']). Ignored when `reviewers` is given.",
        ),
        target: z.string().optional().describe(
          "Label for the review bundle. Defaults to '<repo> <base>...<head>'.",
        ),
        agentsDir: z.string().default(".claude/agents").describe(
          "Directory holding <name>.md reviewer files. Relative to repoPath, " +
            "or an absolute path (use this when the reviewer definitions live " +
            "in a different checkout than the branch under review).",
        ),
        provider: z.string().optional().describe(
          "Override the CLI provider for this run.",
        ),
        model: z.string().optional().describe(
          "Override the CLI model for this run.",
        ),
        nowIso: z.string().optional().describe(
          "ISO timestamp for the bundle (deterministic tests).",
        ),
      }),
      execute: async (
        args: {
          base: string;
          head: string;
          reviewers?: string[];
          exclude?: string[];
          target?: string;
          agentsDir: string;
          provider?: string;
          model?: string;
          nowIso?: string;
        },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const repoPath = g.repoPath;

        // 1. Resolve the panel.
        const panel = resolvePanel(args.reviewers, args.exclude);
        if (panel.length === 0) {
          throw new Error(
            "Empty reviewer panel after applying excludes — nothing to run.",
          );
        }

        // 2. Compute the branch diff in the repo under review.
        const diff = await runCmd(
          "git",
          ["diff", `${args.base}...${args.head}`],
          repoPath,
        );
        if (!diff.success) {
          throw new Error(
            `git diff ${args.base}...${args.head} failed in ${repoPath} ` +
              `(exit ${diff.code}): ${diff.stderr.slice(0, 400)}`,
          );
        }
        const stat = await runCmd(
          "git",
          ["diff", "--stat", `${args.base}...${args.head}`],
          repoPath,
        );
        if (diff.stdout.trim().length === 0) {
          throw new Error(
            `Empty diff for ${args.base}...${args.head} in ${repoPath} — ` +
              `nothing to review.`,
          );
        }

        // 3. Load each reviewer's agent definition into a persona instruction.
        //    agentsDir may be absolute (reviewers in another checkout) or
        //    relative to the repo under review.
        const agentsRoot = args.agentsDir.startsWith("/")
          ? args.agentsDir
          : `${repoPath}/${args.agentsDir}`;
        const personas: string[] = [];
        const missing: string[] = [];
        for (const name of panel) {
          const path = `${agentsRoot}/${name}.md`;
          try {
            const md = await Deno.readTextFile(path);
            personas.push(buildReviewerPersona(name, stripFrontmatter(md)));
          } catch {
            missing.push(name);
            context.logger.warning(
              "Reviewer definition not found: {path} — skipping {name}",
              { path, name },
            );
          }
        }
        if (personas.length === 0) {
          throw new Error(
            `No reviewer definitions found under ${repoPath}/${args.agentsDir} ` +
              `for panel [${panel.join(", ")}].`,
          );
        }

        const target = args.target ??
          `${repoPath.split("/").pop()} ${args.base}...${args.head}`;

        context.logger.info(
          "reviewBranch: panel=[{panel}] missing=[{missing}] diffFiles from --stat",
          { panel: panel.join(", "), missing: missing.join(", ") },
        );

        // 4. Delegate to the base `review` fan-out via a single subprocess.
        //    context.definition.name is THIS model instance's name.
        const reviewInput = {
          target,
          context:
            `Branch diff ${args.base}...${args.head} of ${repoPath}\n\n` +
            `--- git diff --stat ---\n${stat.stdout}\n` +
            `--- git diff ${args.base}...${args.head} ---\n${diff.stdout}`,
          personas,
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.nowIso ? { nowIso: args.nowIso } : {}),
        };
        const inputFile = await Deno.makeTempFile({ suffix: ".json" });
        await Deno.writeTextFile(inputFile, JSON.stringify(reviewInput));

        const run = await runCmd(
          "swamp",
          [
            "model",
            "method",
            "run",
            context.definition.name,
            "review",
            "--input-file",
            inputFile,
            "--repo-dir",
            g.swampRepoDir,
            "--json",
          ],
          g.swampRepoDir,
        );
        try {
          await Deno.remove(inputFile);
        } catch { /* cleanup */ }

        if (!run.success) {
          throw new Error(
            `Delegated 'review' run failed (exit ${run.code}): ` +
              `${(run.stderr || run.stdout).slice(0, 600)}`,
          );
        }

        // Surface the delegated run's data handle(s) so the caller can read the
        // panelReview resource the base method wrote.
        let dataHandles: Array<{ name: string }> = [];
        try {
          const parsed = JSON.parse(run.stdout);
          const arts = parsed.dataArtifacts ?? parsed.dataHandles ?? [];
          dataHandles = arts
            .map((a: Record<string, unknown>) => ({
              name: String(a.name ?? a.instanceName ?? ""),
            }))
            .filter((h: { name: string }) => h.name.length > 0);
        } catch {
          context.logger.warning(
            "Could not parse delegated review output for data handles",
          );
        }

        context.logger.info(
          "reviewBranch complete: {n} reviewer(s) ran over {target}",
          { n: personas.length, target },
        );

        return { dataHandles };
      },
    },
  }],
};
