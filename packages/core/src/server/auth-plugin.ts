import {
  AuthMountIncompleteError,
  autoMountAuth,
  getAuthMountFailure,
} from "./auth.js";
import type { AuthOptions } from "./auth.js";
import { runBetterAuthMigrations } from "./better-auth-migrations.js";
import {
  getH3App,
  awaitBootstrap,
  markDefaultPluginProvided,
  trackPluginInit,
} from "./framework-request-handler.js";

type NitroPluginDef = (nitroApp: any) => void | Promise<void>;

export function createAuthPlugin(options?: AuthOptions): NitroPluginDef {
  return (nitroApp: any) => {
    markDefaultPluginProvided(nitroApp, "auth");
    // A Better Auth init failure leaves the guard mounted but not the routes the
    // client calls, and `autoMountAuth` still returns true for that (the app is
    // locked, which is its job). Failing the tracked init makes the readiness
    // gate answer `/_agent-native/auth` with a retryable 503 instead of
    // releasing it into the router's bare 404 — and `mount` is reusable because
    // the gate retries a failed init once, the usual cause being a database that
    // was not reachable yet on a cold instance.
    const mount = async () => {
      await awaitBootstrap(nitroApp);
      // guard:allow-boot-data-work — local/long-lived runtimes provision auth
      // before mounting routes; production functions are rejected by the
      // migration runner and use the release job instead.
      await runBetterAuthMigrations(nitroApp);
      const app = getH3App(nitroApp);
      await autoMountAuth(app, options);
      const failure = getAuthMountFailure(app);
      if (failure) throw new AuthMountIncompleteError(failure.cause);
    };
    // A thunk, not a running promise: on Workers this plugin runs at isolate
    // scope, where workerd refuses I/O outright, so the gate starts `mount`
    // inside the first request's context instead.
    trackPluginInit(nitroApp, mount, { paths: ["/_agent-native/auth"] });
  };
}

/**
 * Default auth plugin — email/password auth with optional Google OAuth.
 * Google sign-in button appears automatically on the login page when
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are set.
 */
export const defaultAuthPlugin: NitroPluginDef = async (nitroApp: any) => {
  return createAuthPlugin()(nitroApp);
};
