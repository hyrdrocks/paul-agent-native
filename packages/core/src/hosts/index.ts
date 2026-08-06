/**
 * Host adapter registration barrel.
 *
 * One subdirectory per host; this module imports each so it registers itself
 * at module load. Registration is static on purpose: no dynamic import, no
 * runtime-conditional loading, no app-level configuration. An adapter reports
 * itself unavailable when the process is not on its host, so loading all of
 * them is always safe.
 *
 * Nothing a host answers *about* a host may be inferred from whether this
 * barrel ran: an adapter that never registered must be indistinguishable from
 * one that registered and reported itself unavailable. Importers must keep
 * this module free of cycles — an adapter imports the registry it registers
 * into, so the registry must never import this barrel.
 */

export { registerCloudflareHost } from "./cloudflare/index.js";
export { registerNetlifyHost } from "./netlify/index.js";
