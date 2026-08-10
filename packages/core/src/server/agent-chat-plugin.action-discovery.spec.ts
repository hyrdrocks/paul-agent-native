import { describe, expect, it } from "vitest";

import { exportsAnything } from "./agent-chat-plugin.js";

describe("action discovery import guard", () => {
  it("recognises an action module written with defineAction", () => {
    expect(
      exportsAnything(
        [
          'import { defineAction } from "@agent-native/core/action";',
          "",
          "export default defineAction({",
          "  tool: { description: 'do a thing' },",
          "  run: async () => ({ ok: true }),",
          "});",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("recognises named, re-exported and type-only exports", () => {
    expect(exportsAnything("export const tool = {};")).toBe(true);
    expect(exportsAnything('export * from "./elsewhere.js";')).toBe(true);
    expect(exportsAnything("const a = 1;\nexport { a };")).toBe(true);
    expect(exportsAnything("export type Thing = { id: string };")).toBe(true);
  });

  // A CLI script's top-level `process.exit()` is not a throw, so discovery's
  // `catch` cannot contain it — importing this file would end the server
  // process. It has nothing to discover either way.
  it("rejects a CLI script that exports nothing", () => {
    expect(
      exportsAnything(
        [
          'import { readFileSync } from "node:fs";',
          "",
          "const path = process.argv[2];",
          "if (!path) {",
          '  console.error("usage: verify --html <file>");',
          "  process.exit(2);",
          "}",
          "console.log(readFileSync(path, 'utf8').length);",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("is not fooled by the word export inside other identifiers or text", () => {
    expect(exportsAnything("const exported = 1;\nconsole.log(exported);")).toBe(
      false,
    );
    expect(exportsAnything('runExport("nothing to see");')).toBe(false);
  });
});
