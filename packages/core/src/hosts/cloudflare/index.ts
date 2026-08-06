/**
 * The Cloudflare host adapter.
 *
 * Everything the framework needs to know about running on this host lives
 * under this directory. Registration happens at module load — host identity is
 * a fact to detect, never a setting an app can contradict — and each piece
 * reports itself unavailable when the process is not on this host.
 */

import { registerCloudflareBackgroundTransport } from "./background-transport.js";

export function registerCloudflareHost(): void {
  registerCloudflareBackgroundTransport();
}

registerCloudflareHost();
