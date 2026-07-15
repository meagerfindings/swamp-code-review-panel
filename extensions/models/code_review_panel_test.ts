import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildPersonaPrompt } from "./code_review_panel.ts";

Deno.test("buildPersonaPrompt: slash-command persona is passed through as a command", () => {
  const p = buildPersonaPrompt("/ai-slop-check", "PR #24375 final state", "diff goes here");
  assertStringIncludes(p, "Run the /ai-slop-check review.");
  assertStringIncludes(p, "PR #24375 final state");
  assertStringIncludes(p, "diff goes here");
  assertStringIncludes(p, "```json");
  assertStringIncludes(p, "single fenced JSON");
});

Deno.test("buildPersonaPrompt: role-name persona becomes a role instruction", () => {
  const p = buildPersonaPrompt("query-performance", "working tree", "some code");
  assertStringIncludes(p, 'Act as the "query-performance" code reviewer.');
});

Deno.test("buildPersonaPrompt: always embeds the context between fences", () => {
  const p = buildPersonaPrompt("/oop", "target", "THE_CODE");
  assertStringIncludes(p, "--- CONTEXT ---");
  assertStringIncludes(p, "THE_CODE");
  assertStringIncludes(p, "--- END CONTEXT ---");
});

Deno.test("buildPersonaPrompt: instructs empty-findings shape", () => {
  const p = buildPersonaPrompt("/x", "t", "c");
  assertStringIncludes(p, '{"findings": []}');
});
