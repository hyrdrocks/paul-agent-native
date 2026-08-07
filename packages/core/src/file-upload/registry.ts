import { resolveFallbackStorageDecision } from "../hosts/fallback-storage.js";
import { builderFileUploadProvider } from "./builder.js";
import {
  FileUploadProviderUnreadableError,
  FileUploadStorageNotConfiguredError,
  type FileUploadProviderLookupFailure,
} from "./errors.js";
import { registerPortableFallbackStoragePolicy } from "./fallback-storage-baseline.js";
import type {
  FileUploadInput,
  FileUploadProvider,
  FileUploadResult,
} from "./types.js";

// Why globalThis: in dev (Vite HMR) and in some Nitro/Rollup bundle splits,
// this module can be evaluated more than once — the plugin file that
// registers a provider lands in one module instance and the request handler
// that reads providers lands in another, so the call site sees an empty map
// even though `registerFileUploadProvider` succeeded. Pinning the singletons
// on `globalThis` guarantees one set of providers per Node process,
// independent of how the bundler split the chunks.
interface FileUploadGlobals {
  __agentNativeFileUploadProviders?: Map<string, FileUploadProvider>;
  __agentNativeFileUploadWarnedFallback?: { value: boolean };
}
const globals = globalThis as typeof globalThis & FileUploadGlobals;
const providers: Map<string, FileUploadProvider> =
  (globals.__agentNativeFileUploadProviders ??= new Map());
const warnedFallbackRef: { value: boolean } =
  (globals.__agentNativeFileUploadWarnedFallback ??= { value: false });

// The baseline answers for every process no host adapter claims, so it must be
// registered wherever `uploadFile` is reachable rather than wherever the host
// barrel happened to be imported.
registerPortableFallbackStoragePolicy();

/**
 * Register a file upload provider. Call from a server plugin or app
 * bootstrap. Idempotent per id — later calls with the same id replace.
 */
export function registerFileUploadProvider(provider: FileUploadProvider): void {
  providers.set(provider.id, provider);
}

export function unregisterFileUploadProvider(id: string): void {
  providers.delete(id);
}

export function listFileUploadProviders(): FileUploadProvider[] {
  return [...providers.values()];
}

/**
 * Returns the first configured provider, checking user-registered ones first
 * and falling back to the built-in Builder.io provider when its env is set.
 * Returns `null` when nothing is configured. Whether that permits storing the
 * payload elsewhere is not this function's answer — see
 * `resolveFallbackStorageDecision`.
 */
export function getActiveFileUploadProvider(): FileUploadProvider | null {
  for (const provider of providers.values()) {
    if (provider.isConfigured()) return provider;
  }
  if (builderFileUploadProvider.isConfigured()) {
    return builderFileUploadProvider;
  }
  return null;
}

/**
 * What the provider lookup actually learned.
 *
 * `absent` and `unreadable` are separate cases because their repairs are: one
 * is "configure a bucket", the other is "the credential store is down". A
 * lookup that threw says nothing at all about whether a provider exists, so
 * collapsing it into `absent` reports an outage as a setup mistake — and, at
 * the call site below, turns it into a payload written somewhere else.
 */
export type FileUploadProviderResolution =
  | { status: "provider"; provider: FileUploadProvider }
  | { status: "absent" }
  | { status: "unreadable"; failures: FileUploadProviderLookupFailure[] };

export async function resolveFileUploadProviderForRequest(): Promise<FileUploadProviderResolution> {
  const failures: FileUploadProviderLookupFailure[] = [];
  for (const provider of providers.values()) {
    if (provider.isConfigured()) return { status: "provider", provider };
    if (provider.isConfiguredForRequest) {
      try {
        if (await provider.isConfiguredForRequest())
          return { status: "provider", provider };
      } catch (error) {
        failures.push({ providerId: provider.id, error });
      }
    }
  }
  if (builderFileUploadProvider.isConfigured()) {
    return { status: "provider", provider: builderFileUploadProvider };
  }
  try {
    const { resolveHasBuilderPrivateKey } =
      await import("../server/credential-provider.js");
    if (await resolveHasBuilderPrivateKey()) {
      return { status: "provider", provider: builderFileUploadProvider };
    }
  } catch (error) {
    failures.push({ providerId: builderFileUploadProvider.id, error });
  }
  if (failures.length > 0) return { status: "unreadable", failures };
  return { status: "absent" };
}

/**
 * The first provider configured for this request, or `null` when none is.
 *
 * Throws `FileUploadProviderUnreadableError` when a configuration check could
 * not be completed: `null` here means "no provider is configured", and it must
 * not also mean "we could not find out".
 */
export async function getActiveFileUploadProviderForRequest(): Promise<FileUploadProvider | null> {
  const resolution = await resolveFileUploadProviderForRequest();
  if (resolution.status === "provider") return resolution.provider;
  if (resolution.status === "unreadable") {
    throw new FileUploadProviderUnreadableError(resolution.failures);
  }
  return null;
}

/**
 * Upload a file via the active provider.
 *
 * Returns `null` for EXACTLY ONE condition: no provider is configured AND this
 * host permits the caller to store the payload somewhere else. That is the
 * whole contract, and it is deliberately narrow — `null` used to also cover a
 * credential store that could not be read and a host where a SQL fallback is
 * forbidden, so every caller resolved all three by writing the body into SQL.
 *
 * The other two conditions are typed throws:
 *  - `FileUploadProviderUnreadableError` — whether a provider exists is unknown.
 *  - `FileUploadStorageNotConfiguredError` — none exists and this host refuses
 *    the fallback, carrying the setup step that fixes it.
 *
 * Whether a fallback is permitted is NOT decided here. It is a property of the
 * host, answered once by `resolveFallbackStorageDecision`.
 */
export async function uploadFile(
  input: FileUploadInput,
): Promise<FileUploadResult | null> {
  const resolution = await resolveFileUploadProviderForRequest();
  if (resolution.status === "unreadable") {
    throw new FileUploadProviderUnreadableError(resolution.failures);
  }
  const provider =
    resolution.status === "provider" ? resolution.provider : null;
  // User-registered providers (S3, R2, etc.) may be configured by sync runtime
  // state or request-scoped DB secrets. Builder still gets an explicit async
  // credential check below because its sync isConfigured() only checks env.
  if (provider && provider !== builderFileUploadProvider) {
    return provider.upload(input);
  }

  // Resolve credentials asynchronously (works when request context is set
  // via runWithRequestContext — actions always have one via action-routes.ts).
  // Kept separate from the upload call so a real upload failure is never
  // swallowed as a "no credentials" case.
  let builderKey: string | null = null;
  try {
    const { resolveBuilderPrivateKey } =
      await import("../server/credential-provider.js");
    builderKey = await resolveBuilderPrivateKey();
  } catch (err) {
    // The credential store could not be read. Whether Builder is connected is
    // now unknown, which is not the same fact as it being unconnected —
    // reporting it as unconfigured would send the payload to the fallback on
    // the strength of a database blip.
    throw new FileUploadProviderUnreadableError([
      { providerId: builderFileUploadProvider.id, error: err },
    ]);
  }

  if (builderKey) {
    // Credentials confirmed — attempt the upload. Real errors (network,
    // API, rate-limit) propagate to the caller; do NOT catch them here.
    return await builderFileUploadProvider.upload(input);
  }

  const decision = resolveFallbackStorageDecision();
  if (!decision.permitted) {
    throw new FileUploadStorageNotConfiguredError(decision);
  }

  if (!warnedFallbackRef.value) {
    warnedFallbackRef.value = true;
    console.warn(
      "[agent-native] No file upload provider configured. " +
        "Connect or reconnect Builder.io in Settings → File uploads, " +
        "or register a custom provider (S3, R2, GCS, …) via registerFileUploadProvider().",
    );
  }
  return null;
}
