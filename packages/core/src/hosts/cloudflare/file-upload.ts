/**
 * This host's object storage provider.
 *
 * Registered unconditionally like every other piece of a host adapter: the
 * provider reports itself unconfigured when no bucket is bound, so a process
 * that is not a Worker sees it exactly as it sees a provider that never
 * registered.
 */

import { cloudflareR2FileUploadProvider } from "../../file-upload/cloudflare-r2.js";
import { registerFileUploadProvider } from "../../file-upload/registry.js";

export function registerCloudflareFileUploadProvider(): void {
  registerFileUploadProvider(cloudflareR2FileUploadProvider);
}
