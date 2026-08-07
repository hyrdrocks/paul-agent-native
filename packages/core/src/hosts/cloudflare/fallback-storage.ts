/**
 * The Cloudflare fallback-storage policy.
 *
 * A Worker's database is D1. Writing a file body there is not a degraded
 * upload — it is a row on a database that is not built to hand back megabytes,
 * on a host whose only durable store for bytes is a bucket. So this host
 * permits no fallback at all, and names the binding that is missing instead.
 */

import {
  cloudflareR2SetupStep,
  describeCloudflareR2Binding,
} from "../../file-upload/cloudflare-r2.js";
import { isCloudflareRuntime } from "../../shared/runtime.js";
import { registerFallbackStoragePolicy } from "../fallback-storage.js";

/**
 * Declared ahead of the portable baseline so the refusal a Worker produces
 * names R2 rather than the generic hosted-runtime advice. Spread out so a host
 * can be slotted between the two without renumbering either.
 */
const CLOUDFLARE_FALLBACK_STORAGE_PRIORITY = 20;

const POLICY_ID = "cloudflare";

export function registerCloudflareFallbackStorage(): void {
  registerFallbackStoragePolicy({
    id: POLICY_ID,
    priority: CLOUDFLARE_FALLBACK_STORAGE_PRIORITY,
    decide() {
      if (!isCloudflareRuntime()) return null;
      // The setup step names what is actually wrong. A binding that exists but
      // is not a bucket is not a missing binding, and telling that operator to
      // bind one sends them to check a variable they already set.
      const { state } = describeCloudflareR2Binding();
      return {
        permitted: false,
        policy: POLICY_ID,
        reason:
          "This app runs on Cloudflare Workers, where the database is D1 and a file payload is never stored in it.",
        setup: cloudflareR2SetupStep(state) ?? "",
      };
    },
  });
}
