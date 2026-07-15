# @mgreten/code-review-panel

Run a panel of independent reviewer personas over **one** body of code and get
back a single, unified list of actionable findings. Where a rubric-grading model
grades many pull requests against one rubric, this model does the transpose: one
context (a diff, a working tree, any supplied code) reviewed by N personas at
once, each persona a slash command or a role instruction executed through the
[`@mgreten/cli-agent`](https://github.com/meagerfindings/swamp-cli-agent) model
in readonly mode. Output is findings — severity plus a concrete fix per item, not
letter grades — ready for a synthesis step to rank and a human to turn into
changes.

It is deliberately generic: the personas, the code context, the CLI provider,
and the working directory are all inputs. Nothing in the model is tied to a
particular codebase.

## Installation

```bash
swamp extension pull @mgreten/code-review-panel
```

This model shells out to a `cli-agent` model instance, so install
[`@mgreten/cli-agent`](https://github.com/meagerfindings/swamp-cli-agent) too:

```bash
swamp extension pull @mgreten/cli-agent
swamp model create @mgreten/cli-agent cli-agent
```

## Setup

```bash
swamp model create @mgreten/code-review-panel code-panel
```

Point it at the code under review and (optionally) a different CLI provider:

```bash
swamp model create @mgreten/code-review-panel code-panel \
  --global repoPath=/path/to/repo/under/review \
  --global reviewProvider=claude \
  --global reviewModelId=sonnet
```

## Usage

Review one PR's final-state diff with three personas:

```bash
swamp model method run code-panel review \
  --input target="PR #123 final state" \
  --input context="$(git diff main...HEAD)" \
  --input personas='["Query performance reviewer — flag N+1 queries and unbounded scans","OOP design reviewer — flag SRP violations and long methods","Security reviewer — flag injection, missing authorization, and unsafe input"]'
```

Personas can also be slash commands your `cli-agent` resolves from its commands
directory:

```bash
swamp model method run code-panel review \
  --input target="working tree" \
  --input context="$(git diff)" \
  --input personas='["/ai-slop-check","/query-performance-check"]'
```

Read the merged findings:

```bash
swamp data get code-panel panel-PR-123-final-state --json
```

## Global Arguments

| Argument | Type | Default | Description |
|---|---|---|---|
| `cliAgentModel` | string | `cli-agent` | Name of the `cli-agent` model instance used to run personas. |
| `swampRepoDir` | string | current working dir | Swamp repo directory the cli-agent invocations run against. |
| `repoPath` | string | current working dir | Working directory the reviewer agents run in (the code under review). |
| `reviewProvider` | string | `claude` | CLI provider for review passes (claude, codex, gemini, …). |
| `reviewModelId` | string | `sonnet` | Provider-specific model id. |
| `reviewTimeoutMs` | number | `300000` | Per-persona wall timeout in milliseconds. |

## Method: review

Run each persona over the supplied context via `cli-agent` (readonly) and merge
the results into one findings list with per-severity counts. Never edits or
commits.

| Argument | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | Label for what is under review, e.g. `PR #123 final state`. |
| `context` | string | yes | The code context every persona reviews — a diff, file dump, or summary. |
| `personas` | string[] | yes | Reviewer personas: slash commands resolved by cli-agent, or role instructions. |
| `provider` | string | no | Override the CLI provider for this run. |
| `model` | string | no | Override the CLI model for this run. |
| `nowIso` | string | no | ISO timestamp to stamp the result with (for deterministic tests). |

The method writes one `panelReview` resource: `findings[]` (each with `persona`,
`severity`, `category`, `file`, `line`, `title`, `rationale`, `suggestedFix`,
`confidence`), a `skipped[]` list of personas that failed, and `severityCounts`.

## How It Works

For each persona the model builds a prompt that embeds the shared context and a
strict JSON output contract, then invokes `cli-agent`'s `invokeAndParse` method
in readonly mode. Personas run in a sequential loop — one `swamp model method
run cli-agent` subprocess at a time — so the model never contends on its own
lock or overwhelms the machine. If a persona returns unparseable output (headless
review agents routinely drift into prose), it is retried once with a
format-only reminder before being recorded as skipped. Findings from every
persona are merged into a single list and tallied by severity.

Prerequisites: a working `cli-agent` model instance and whichever CLI tool the
chosen `reviewProvider` points at (e.g. the `claude` CLI), authenticated on the
host.

## License

MIT — see LICENSE for details.
