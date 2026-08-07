/**
 * Typed refusals from the file-upload seam.
 *
 * These exist so a caller can never confuse "the payload is not stored" with a
 * value that reads like a stored payload. The upload path used to answer that
 * with `null`, which every caller resolved by writing the body into SQL — the
 * one place a file payload must never be.
 */

import type { FallbackStorageRefusal } from "../hosts/fallback-storage.js";

/**
 * Object storage is not usable here and this host does not permit storing the
 * payload anywhere else. Carries the setup step, because a refusal an operator
 * cannot act on is only a different kind of dead end.
 *
 * Raised both when no provider is configured at all and when a configured
 * provider cannot form a durable URL for what it just stored — an object
 * written under a URL that resolves to nothing is not a completed upload.
 */
export class FileUploadStorageNotConfiguredError extends Error {
  /** Id of the host policy that refused, or of the provider that could not finish. */
  readonly policy: string;
  /** The concrete configuration that makes object storage usable. */
  readonly setup: string;

  constructor(refusal: FallbackStorageRefusal) {
    super(`${refusal.reason} ${refusal.setup}`);
    this.name = "FileUploadStorageNotConfiguredError";
    this.policy = refusal.policy;
    this.setup = refusal.setup;
  }
}

/** One provider's failed configuration check, kept with the provider it came from. */
export interface FileUploadProviderLookupFailure {
  providerId: string;
  error: unknown;
}

/**
 * A provider's configuration could not be READ — the credential store was
 * unreachable, not empty.
 *
 * Distinct from "no provider is configured" on purpose: the repairs are
 * different (fix the database versus configure a bucket), and coercing the
 * first into the second is what makes an outage report itself as a setup
 * mistake. Never caught to reach a fallback; an unreadable store says nothing
 * about whether a provider exists.
 */
export class FileUploadProviderUnreadableError extends Error {
  readonly failures: FileUploadProviderLookupFailure[];

  constructor(failures: FileUploadProviderLookupFailure[]) {
    const detail = failures
      .map(
        (f) =>
          `${f.providerId}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
      )
      .join("; ");
    super(
      "[agent-native] could not read file upload provider configuration, so whether one is " +
        `configured is unknown — this is NOT the same as no provider being configured. ${detail}`,
    );
    this.name = "FileUploadProviderUnreadableError";
    this.failures = failures;
  }
}

/** One refusal, in the terms every surface reports it with. */
export interface FileUploadRefusal {
  /** Message to show. Already names the setup step where there is one. */
  error: string;
  /** The concrete configuration that makes object storage usable, when known. */
  setup?: string;
  /** True when we could not find out whether a store is configured. */
  storageStatusUnknown?: true;
}

/**
 * Translate a thrown refusal into the shape a surface reports, or `null` when
 * this is not a refusal and must keep propagating.
 *
 * One function rather than the same `instanceof` cascade at every surface: a
 * fourth refusal type would otherwise have to be added in four places, and the
 * one that got missed would report the payload as stored.
 */
export function describeFileUploadRefusal(
  err: unknown,
): FileUploadRefusal | null {
  if (err instanceof FileUploadStorageNotConfiguredError) {
    return { error: err.message, setup: err.setup };
  }
  if (err instanceof FileUploadProviderUnreadableError) {
    return { error: err.message, storageStatusUnknown: true };
  }
  return null;
}
