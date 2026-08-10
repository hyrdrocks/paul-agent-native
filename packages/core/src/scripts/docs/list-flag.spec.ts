import { describe, expect, it } from "vitest";

import {
  isListFlagSet,
  listToolParameter,
  wantsIndexListing,
} from "./list-flag.js";

describe("docs lookup --list semantics", () => {
  it("lists when the caller asked for nothing more specific", () => {
    expect(wantsIndexListing({ list: "true" }, ["slug", "query"])).toBe(true);
  });

  it("does not list when a selector is present alongside list", () => {
    expect(
      wantsIndexListing({ list: "true", slug: "actions" }, ["slug", "query"]),
    ).toBe(false);
    expect(
      wantsIndexListing({ list: "true", query: "actions" }, ["slug", "query"]),
    ).toBe(false);
  });

  it("treats a blank selector as absent", () => {
    expect(wantsIndexListing({ list: "true", slug: "  " }, ["slug"])).toBe(
      true,
    );
  });

  it("does not list when list is anything but true", () => {
    expect(wantsIndexListing({ list: "false" }, ["slug"])).toBe(false);
    expect(wantsIndexListing({}, ["slug"])).toBe(false);
  });

  it("accepts the flag regardless of case or surrounding space", () => {
    expect(isListFlagSet(" TRUE ")).toBe(true);
    expect(isListFlagSet("false")).toBe(false);
    expect(isListFlagSet(undefined)).toBe(false);
  });

  it("advertises both enum values so filling the enum is not a request", () => {
    expect(listToolParameter("all available doc pages").enum).toEqual([
      "true",
      "false",
    ]);
  });
});
