import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEngine, EngineEvent } from "./engine/types.js";
import { resetCodeGenerationProbeForTests } from "./json-schema-validator.js";
import { runAgentLoop, type ActionEntry } from "./production-agent.js";

/**
 * The agent loop's own two compile sites, exercised on a runtime that forbids
 * code generation from strings.
 *
 * `json-schema-validator.spec.ts` holds the seam itself to Ajv's decisions. This
 * file asserts the thing above it: that the loop reaches the seam at all. Before
 * it did, `ajv.compile` threw inside `getRawToolInputValidator`, the loop
 * reported "tool schema is invalid: Code generation from strings disallowed for
 * this context", and the action never ran — the agent could reply and could not
 * act. A green parity spec would not have caught that, because nothing in it
 * runs the loop.
 */

const CREATE_DESIGN_PARAMETERS = {
  type: "object" as const,
  properties: {
    title: { type: "string" },
    screens: { type: "integer" },
    draft: { type: "boolean" },
  },
  required: ["title"],
  additionalProperties: false,
};

/**
 * Each validator is cached on the `parameters` object identity, so every test
 * needs its own instance or the second one reuses a validator built under the
 * other runtime.
 */
function freshParameters(): typeof CREATE_DESIGN_PARAMETERS {
  return structuredClone(CREATE_DESIGN_PARAMETERS);
}

function engineCallingCreateDesign(input: unknown): AgentEngine {
  let calls = 0;
  return {
    name: "test",
    capabilities: { parallelToolCalls: true },
    async *stream(): AsyncIterable<EngineEvent> {
      calls += 1;
      if (calls > 1) {
        yield { type: "text", text: "done" };
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      yield {
        type: "tool-call",
        id: "call-1",
        name: "create-design",
        input,
      } as EngineEvent;
      yield { type: "stop", reason: "tool_use" };
    },
  } as AgentEngine;
}

async function runCreateDesign(input: unknown): Promise<{
  run: ReturnType<typeof vi.fn>;
  result: string;
}> {
  const run = vi.fn(async () => ({ ok: true }));
  const events: any[] = [];
  await runAgentLoop({
    engine: engineCallingCreateDesign(input),
    model: "test-model",
    systemPrompt: "system",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "make one" }] }],
    actions: {
      "create-design": {
        tool: { description: "Create a design", parameters: freshParameters() },
        run,
      } as unknown as ActionEntry,
    },
    send: (event) => events.push(event),
    signal: new AbortController().signal,
  });
  const result = String(
    events.find((e) => e.type === "tool_done" && e.tool === "create-design")
      ?.result ?? "",
  );
  return { run, result };
}

/**
 * What workerd actually refuses is the `Function` constructor. Stubbing it is
 * closer to the failure than any host flag, and the seam caches its probe on
 * first use, so the cache is cleared on both sides of the stub.
 */
function forbidCodeGeneration(): void {
  resetCodeGenerationProbeForTests();
  const RealFunction = globalThis.Function;
  const blocked = function BlockedFunction() {
    throw new EvalError(
      "Code generation from strings disallowed for this context",
    );
  } as unknown as FunctionConstructor;
  blocked.prototype = RealFunction.prototype;
  vi.stubGlobal("Function", blocked);
}

describe("agent tool input on a runtime that forbids code generation", () => {
  beforeEach(() => {
    resetCodeGenerationProbeForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCodeGenerationProbeForTests();
  });

  it("runs the tool, with the same coercion the compiled path applies", async () => {
    forbidCodeGeneration();
    const { run, result } = await runCreateDesign({
      title: "Northwind",
      screens: "3",
    });

    expect(
      result,
      "the loop rejected the call before running it — the pre-R2 failure",
    ).not.toContain("Code generation from strings disallowed");
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0] as any)[0]).toEqual({
      title: "Northwind",
      screens: 3,
    });
  });

  it("still rejects input the schema does not allow, and says why", async () => {
    forbidCodeGeneration();
    const { run, result } = await runCreateDesign({ screens: 3 });

    expect(run).not.toHaveBeenCalled();
    expect(result).toContain("Invalid action parameters for create-design");
    expect(result).not.toContain("Code generation from strings disallowed");
    // The interpreted formatter frames instance paths as `input/...`, which is
    // what `toolInputSchemaErrorResult` reads to name the offending property.
    expect(result).toContain("title");
  });

  it("agrees with the compiled path on both of those", async () => {
    const accepted = await runCreateDesign({
      title: "Northwind",
      screens: "3",
    });
    expect(accepted.run).toHaveBeenCalledTimes(1);
    expect((accepted.run.mock.calls[0] as any)[0]).toEqual({
      title: "Northwind",
      screens: 3,
    });

    const rejected = await runCreateDesign({ screens: 3 });
    expect(rejected.run).not.toHaveBeenCalled();
    expect(rejected.result).toContain(
      "Invalid action parameters for create-design",
    );
  });
});
