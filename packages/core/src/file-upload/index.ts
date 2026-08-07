// Host adapters register this host's object storage provider and its
// fallback-storage policy at module load, the same way
// `agent/durable-background` pulls them in for background transports. The
// import lives HERE and not in `registry.js`: an adapter imports the registry
// to register into it, so a registry that imported the barrel back would
// evaluate the adapter before its own provider map exists.
import "../hosts/index.js";

export type {
  FileUploadInput,
  FileUploadProvider,
  FileUploadResult,
  ResumableUploadSession,
  ResumableChunkResult,
} from "./types.js";
export {
  registerFileUploadProvider,
  unregisterFileUploadProvider,
  listFileUploadProviders,
  getActiveFileUploadProvider,
  getActiveFileUploadProviderForRequest,
  resolveFileUploadProviderForRequest,
  uploadFile,
  type FileUploadProviderResolution,
} from "./registry.js";
export {
  FileUploadProviderUnreadableError,
  FileUploadStorageNotConfiguredError,
  type FileUploadProviderLookupFailure,
} from "./errors.js";
export {
  buildCloudflareR2ObjectKey,
  cloudflareR2FileUploadProvider,
  hasBoundCloudflareR2Bucket,
  resolveCloudflareR2Bucket,
  CLOUDFLARE_R2_BINDING_NAME,
  CLOUDFLARE_R2_PROVIDER_ID,
  CLOUDFLARE_R2_PUBLIC_BASE_URL_KEY,
} from "./cloudflare-r2.js";
export { builderFileUploadProvider } from "./builder.js";
export {
  preUploadImageAttachments,
  preUploadAttachments,
  isFileUploadProviderConfigured,
  type PreUploadAttachmentsResult,
  type PreUploadedImageAttachment,
  type PreUploadedFileAttachment,
} from "./pre-upload-attachments.js";
