import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReviewerPersona,
  DEFAULT_PANEL,
  resolvePanel,
  stripFrontmatter,
} from "./code_review_panel_branch.ts";

Deno.test("resolvePanel: default panel excludes integrations", () => {
  const panel = resolvePanel(undefined, undefined);
  assertEquals(panel, [
    "ai-slop-detector",
    "query-performance",
    "oop-reviewer",
    "rails-master",
  ]);
  assertEquals(panel.includes("integrations"), false);
});

Deno.test("resolvePanel: exclude drops a reviewer from the default panel", () => {
  const panel = resolvePanel(undefined, ["query-performance"]);
  assertEquals(panel, ["ai-slop-detector", "oop-reviewer", "rails-master"]);
});

Deno.test("resolvePanel: explicit reviewers override the default (opt in integrations)", () => {
  const panel = resolvePanel(["integrations", "rails-master"], undefined);
  assertEquals(panel, ["integrations", "rails-master"]);
});

Deno.test("resolvePanel: reviewers wins over exclude", () => {
  const panel = resolvePanel(["ai-slop-detector"], ["ai-slop-detector"]);
  // reviewers is used verbatim; exclude is ignored when reviewers is given.
  assertEquals(panel, ["ai-slop-detector"]);
});

Deno.test("resolvePanel: dedupes and preserves order", () => {
  const panel = resolvePanel(["a", "b", "a", " b ", "c"], undefined);
  assertEquals(panel, ["a", "b", "c"]);
});

Deno.test("resolvePanel: excluding everything yields empty (caller errors)", () => {
  assertEquals(resolvePanel(undefined, [...DEFAULT_PANEL]), []);
});

Deno.test("stripFrontmatter: removes YAML header, keeps body", () => {
  const md = `---
name: ai-slop-detector
model: sonnet
---

# Purpose
You are a reviewer.`;
  assertEquals(stripFrontmatter(md), "# Purpose\nYou are a reviewer.");
});

Deno.test("stripFrontmatter: no frontmatter returns trimmed content", () => {
  assertEquals(stripFrontmatter("  # Just a body  "), "# Just a body");
});

Deno.test("buildReviewerPersona: embeds name and body", () => {
  const p = buildReviewerPersona("rails-master", "Review Rails code.");
  assertEquals(p.includes('"rails-master" code reviewer'), true);
  assertEquals(p.includes("Review Rails code."), true);
  assertEquals(p.includes("REVIEWER DEFINITION (rails-master)"), true);
});
