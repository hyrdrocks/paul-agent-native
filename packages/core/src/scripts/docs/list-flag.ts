/**
 * Shared `--list` semantics for the read-only docs lookup tools
 * (docs-search, framework-search, source-search).
 *
 * `--list` is the fallback view of these tools, not an override. Some models
 * populate every optional parameter a schema offers, so they send `list`
 * alongside the page they actually asked for. If `list` wins, the tool answers
 * with the index, the model re-asks for the same page, and the agent loop's
 * duplicate-read-only guard aborts the turn (`duplicate_read_only_tool`).
 * Selectors therefore take precedence, and these tools advertise no
 * single-value enum — a model that fills the enum must have a way to say "no".
 */

import type { AgentNativeJsonSchema } from "../../agent/types.js";

export function isListFlagSet(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function hasSelector(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/**
 * True only when the caller asked for the index and for nothing more specific.
 */
export function wantsIndexListing(
  parsed: Record<string, string | undefined>,
  selectors: readonly string[],
): boolean {
  if (!isListFlagSet(parsed.list)) return false;
  return !selectors.some((selector) => hasSelector(parsed[selector]));
}

/**
 * The `list` parameter as advertised to models. Two values, so filling the
 * enum is not the same as requesting the index.
 */
export function listToolParameter(what: string): AgentNativeJsonSchema {
  return {
    type: "string",
    description:
      `Set to "true" to list ${what}, or "false" to skip the listing. ` +
      "Only use this when you have nothing more specific to ask for: a " +
      "request that names a page, path, or search term is answered on its " +
      "own terms and ignores this flag.",
    enum: ["true", "false"],
  };
}
