import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildPersonaPrompt,
  extractDispatch,
  model,
  resolveDispatch,
} from "./code_review_panel.ts";

Deno.test("buildPersonaPrompt: slash-command persona is passed through as a command", () => {
  const p = buildPersonaPrompt(
    "/ai-slop-check",
    "PR #24375 final state",
    "diff goes here",
  );
  assertStringIncludes(p, "Run the /ai-slop-check review.");
  assertStringIncludes(p, "PR #24375 final state");
  assertStringIncludes(p, "diff goes here");
  assertStringIncludes(p, "```json");
  assertStringIncludes(p, "single fenced JSON");
});

Deno.test("buildPersonaPrompt: role-name persona becomes a role instruction", () => {
  const p = buildPersonaPrompt(
    "query-performance",
    "working tree",
    "some code",
  );
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

// --- Provider catalog read --------------------------------------------------
//
// The catalog is the fleet's single switch point for {provider, model}. These
// cover the successful read, every fail-open path (a broken catalog must never
// take a review down), and the precedence contract an explicit per-call
// provider/model override relies on.

/** Global args with the catalog on, as a live instance would have them. */
function catalogGlobalArgs(overrides: Record<string, unknown> = {}) {
  return model.globalArguments.parse({
    cliAgentModel: "cli-agent",
    providerCatalogModel: "provider-catalog",
    ...overrides,
  });
}

/**
 * Fake MethodContext exposing `runModel` (recording each call so a test can
 * assert the catalog was or was NOT consulted) plus a no-op logger/writer.
 */
function makeContext(
  globalArgs: Record<string, unknown>,
  runModelImpl: (options: { definition: string; method: string }) => unknown,
): {
  context: unknown;
  calls: Array<{ definition: string; method: string; arguments?: unknown }>;
  written: Array<Record<string, unknown>>;
} {
  const calls: Array<
    { definition: string; method: string; arguments?: unknown }
  > = [];
  const written: Array<Record<string, unknown>> = [];
  const noop = (_msg: string, _props?: Record<string, unknown>) => {};
  const context = {
    globalArgs,
    logger: { info: noop, warning: noop, error: noop },
    writeResource: (
      _specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ) => {
      written.push(data);
      return Promise.resolve({ name: instanceName });
    },
    runModel: (
      options: { definition: string; method: string; arguments?: unknown },
    ) => {
      calls.push(options);
      return Promise.resolve(runModelImpl(options));
    },
  };
  return { context, calls, written };
}

Deno.test("extractDispatch: reads provider/model from a method-run envelope entry", () => {
  // Parsing contract, tested on the function that owns it. Driving it through
  // resolveDispatch would need a faked runModel payload carrying `attributes`,
  // a shape the real runtime never produces — see the regression guard below.
  assertEquals(
    extractDispatch([{
      name: "agent-dispatch-PR-1-correctness-1",
      attributes: { provider: "codex", model: "gpt-5-codex", tier: 0 },
    }]),
    { provider: "codex", model: "gpt-5-codex" },
  );
});

Deno.test("extractDispatch: also reads the `content` shape `swamp data get` returns", () => {
  assertEquals(
    extractDispatch([{
      name: "agent-dispatch-PR-1-correctness-1",
      content: { provider: "codex", model: "gpt-5-codex", tier: 0 },
    }]),
    { provider: "codex", model: "gpt-5-codex" },
  );
});

Deno.test("extractDispatch: scans past non-dispatch entries instead of indexing [0]", () => {
  assertEquals(
    extractDispatch([
      { name: "catalog-audit", attributes: { note: "audited" } },
      { name: "no-attributes" },
      {
        name: "agent-dispatch-PR-1-security-1",
        attributes: { provider: "codex", model: "gpt-5-codex" },
      },
    ]),
    { provider: "codex", model: "gpt-5-codex" },
  );
});

Deno.test("resolveDispatch: never reads the values off runModel's own payload", async () => {
  // REGRESSION GUARD. runModel resolves to {ok, resources:[{specName, name}]};
  // a DataHandle is metadata-only and carries NO `attributes`. An earlier
  // version did `return extractDispatch(run.resources)`, so the in-process path
  // always yielded null and the catalog silently never applied. The tests this
  // replaced mocked `attributes` onto resources and passed while the bug was
  // live. With the realistic name-only payload, resolveDispatch must not invent
  // a value; it reads the handle back by name, which in a unit test finds no
  // catalog and fails open to null. It must still have ASKED, with the persona
  // name as the role.
  const { context, calls } = makeContext(catalogGlobalArgs(), () => ({
    ok: true,
    resources: [
      { specName: "agentDispatch", name: "agent-dispatch-PR-1-correctness-1" },
    ],
  }));
  const dispatch = await resolveDispatch(
    catalogGlobalArgs(),
    // deno-lint-ignore no-explicit-any
    context as any,
    "PR #1",
    "correctness",
  );
  assertEquals(dispatch, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].definition, "provider-catalog");
  assertEquals(calls[0].method, "resolveAgentDispatch");
  assertEquals(
    (calls[0].arguments as Record<string, unknown>).role,
    "correctness",
  );
});

Deno.test("resolveDispatch: fails open (null) when runModel throws", async () => {
  const { context } = makeContext(catalogGlobalArgs(), () => {
    throw new Error("provider-catalog not found");
  });
  assertEquals(
    await resolveDispatch(
      catalogGlobalArgs(),
      // deno-lint-ignore no-explicit-any
      context as any,
      "PR #1",
      "correctness",
    ),
    null,
  );
});

Deno.test("resolveDispatch: fails open (null) on an ok:false catalog result", async () => {
  const { context } = makeContext(catalogGlobalArgs(), () => ({
    ok: false,
    error: { message: 'unknown role "correctness"' },
  }));
  assertEquals(
    await resolveDispatch(
      catalogGlobalArgs(),
      // deno-lint-ignore no-explicit-any
      context as any,
      "PR #1",
      "correctness",
    ),
    null,
  );
});

Deno.test("resolveDispatch: fails open (null) on a malformed payload missing model", async () => {
  const { context } = makeContext(catalogGlobalArgs(), () => ({
    ok: true,
    resources: [{ name: "agent-dispatch", attributes: { provider: "codex" } }],
  }));
  assertEquals(
    await resolveDispatch(
      catalogGlobalArgs(),
      // deno-lint-ignore no-explicit-any
      context as any,
      "PR #1",
      "correctness",
    ),
    null,
  );
});

Deno.test("resolveDispatch: does not consult the catalog when useProviderCatalog is false", async () => {
  const g = catalogGlobalArgs({ useProviderCatalog: false });
  const { context, calls } = makeContext(g, () => ({
    ok: true,
    resources: [{ attributes: { provider: "codex", model: "gpt-5-codex" } }],
  }));
  assertEquals(
    // deno-lint-ignore no-explicit-any
    await resolveDispatch(g, context as any, "PR #1", "correctness"),
    null,
  );
  assertEquals(calls.length, 0);
});

Deno.test("extractDispatch: ignores non-array and empty payloads", () => {
  assertEquals(extractDispatch(undefined), null);
  assertEquals(extractDispatch(null), null);
  assertEquals(extractDispatch({}), null);
  assertEquals(extractDispatch([]), null);
});

Deno.test("global args default the catalog on and keep the literals as fallback", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.useProviderCatalog, true);
  assertEquals(parsed.providerCatalogModel, "provider-catalog");
  assertEquals(parsed.reviewProvider, "claude");
  assertEquals(parsed.reviewModelId, "sonnet");
});

// --- review: provider precedence at the call site ---------------------------
//
// Precedence is explicit method arg > catalog > globalArg default. We observe
// what actually reached cli-agent by capturing the --input-file the `swamp
// model method run` shellout is handed.

/** A cli-agent envelope with zero findings — enough for `review` to complete. */
const EMPTY_FINDINGS_ENVELOPE = JSON.stringify({
  dataArtifacts: [{ attributes: { parsedResponse: { findings: [] } } }],
});

/**
 * Install a `Deno.Command` mock for the duration of `fn`, capturing the parsed
 * cli-agent input payload from every `swamp … invokeAndParse` spawn. Restores
 * the real constructor afterward.
 */
async function withCapturedCliAgentInput(
  fn: (captured: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const captured: Array<Record<string, unknown>> = [];
  const real = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #argv: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#argv = [cmd, ...(opts?.args ?? [])];
    }
    async output() {
      if (this.#argv.includes("invokeAndParse")) {
        const idx = this.#argv.indexOf("--input-file");
        const body = await Deno.readTextFile(this.#argv[idx + 1]);
        captured.push(JSON.parse(body));
        return {
          stdout: new TextEncoder().encode(EMPTY_FINDINGS_ENVELOPE),
          stderr: new Uint8Array(),
          code: 0,
          success: true,
        };
      }
      // The catalog read-back: resolveDispatch runs the catalog method in
      // process and then reads the resource back BY NAME, and `data get --json`
      // nests the payload under `content`. Stubbing the real transport here —
      // rather than faking `attributes` onto runModel's resources, a shape the
      // runtime never produces — is what makes the assertions below meaningful.
      if (this.#argv.includes("data") && this.#argv.includes("get")) {
        return {
          stdout: new TextEncoder().encode(JSON.stringify({
            name: "agent-dispatch",
            content: { provider: "codex", model: "gpt-5-codex", tier: 0 },
          })),
          stderr: new Uint8Array(),
          code: 0,
          success: true,
        };
      }
      return {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        code: 1,
        success: false,
      };
    }
  };
  try {
    await fn(captured);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = real;
  }
}

Deno.test("review: the catalog's provider/model overrides the globalArg literals", async () => {
  const g = catalogGlobalArgs();
  const { context } = makeContext(g, () => ({
    ok: true,
    resources: [{ specName: "agentDispatch", name: "agent-dispatch" }],
  }));
  await withCapturedCliAgentInput(async (captured) => {
    await model.methods.review.execute(
      { target: "PR #1 final state", context: "diff", personas: ["security"] },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0].provider, "codex");
    assertEquals(captured[0].model, "gpt-5-codex");
  });
});

Deno.test("review: an explicit method-arg provider/model still beats the catalog", async () => {
  const g = catalogGlobalArgs();
  const { context, calls } = makeContext(g, () => ({
    ok: true,
    resources: [{ specName: "agentDispatch", name: "agent-dispatch" }],
  }));
  await withCapturedCliAgentInput(async (captured) => {
    await model.methods.review.execute(
      {
        target: "PR #1 final state",
        context: "diff",
        personas: ["security"],
        provider: "gemini",
        model: "gemini-3-pro",
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0].provider, "gemini");
    assertEquals(captured[0].model, "gemini-3-pro");
  });
  // Both values were pinned, so the catalog is not even consulted.
  assertEquals(calls.length, 0);
});

Deno.test("review: a failing catalog falls back to the globalArg literals", async () => {
  const g = catalogGlobalArgs();
  const { context } = makeContext(g, () => {
    throw new Error("provider-catalog unreachable");
  });
  await withCapturedCliAgentInput(async (captured) => {
    await model.methods.review.execute(
      { target: "PR #1 final state", context: "diff", personas: ["security"] },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0].provider, "claude");
    assertEquals(captured[0].model, "sonnet");
  });
});
