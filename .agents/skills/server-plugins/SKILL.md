---
name: server-plugins
description: >-
  Framework server plugins and the `/_agent-native/` route namespace. Use when
  adding a custom server plugin, deciding whether to create an `/api/` route vs
  an action, or debugging auto-mounted framework routes.
scope: dev
metadata:
  internal: true
---

# Server Plugins & Framework Routes

## Default Plugins (auto-mount)

Five default plugins auto-mount when your app doesn't have a custom version in `server/plugins/`:

| Plugin        | Default behavior                                  | Customize when                              |
| ------------- | ------------------------------------------------- | ------------------------------------------- |
| `agent-chat`  | Agent chat endpoints                              | Custom `mentionProviders` or `systemPrompt` |
| `auth`        | Auth middleware                                   | Custom `publicPaths` or Google OAuth config |
| `core-routes` | `/_agent-native/poll`, `/_agent-native/ping`, etc | Custom `envKeys` or `sseRoute`              |
| `resources`   | Resource CRUD                                     | Rarely                                      |
| `terminal`    | Terminal emulator                                 | Rarely                                      |

**Only create plugin files for plugins you need to customize.** Let defaults auto-mount.

## Framework Route Namespace: `/_agent-native/`

All framework-level routes live under `/_agent-native/` to avoid collisions with template-specific `/api/*` routes.

### Hard rule

- **ALL framework routes go under `/_agent-native/`.**
- Templates own `/api/*` only for route-only domain concerns such as uploads,
  streaming, webhooks, OAuth callbacks, or non-JSON protocols.
- Never put framework routes under `/api/`.
- Never put template routes under `/_agent-native/` — that namespace is reserved.
- Never create `/api/*` routes that only wrap, proxy, or re-export actions. Use
  the existing `/_agent-native/actions/:name` endpoint or the React action hooks.

### Auto-mounted framework routes

| Route                                                         | Purpose                                  |
| ------------------------------------------------------------- | ---------------------------------------- |
| `GET /_agent-native/poll`                                     | Polling endpoint for DB change detection |
| `GET /_agent-native/events`                                   | SSE endpoint for real-time sync          |
| `GET /_agent-native/ping`                                     | Health check                             |
| `GET/PUT/DELETE /_agent-native/application-state/:key`        | Application state CRUD                   |
| `GET/PUT/DELETE /_agent-native/application-state/compose/:id` | Compose draft CRUD                       |
| `POST /_agent-native/agent-chat`                              | Agent chat SSE endpoint                  |
| `GET /_agent-native/agent-chat/mentions`                      | Mention search for @-tagging             |
| `GET /_agent-native/env-status`                               | Env key configuration status             |
| `POST /_agent-native/env-vars`                                | Save env vars                            |
| `/_agent-native/auth/*`                                       | Authentication (login, session, logout)  |
| `/_agent-native/google/*`                                     | Google OAuth (callback, auth-url, etc.)  |
| `/_agent-native/resources/*`                                  | Resource CRUD                            |
| `/_agent-native/actions/:name`                                | Auto-mounted action endpoints            |
| `/_agent-native/available-clis`                               | Available CLI tools                      |
| `/_agent-native/agent-terminal-info`                          | Terminal connection info                 |
| `/_agent-native/collab/*`                                     | Real-time collaboration (see `real-time-collab`) |
| `/_agent-native/a2a`                                          | A2A JSON-RPC endpoint (see `a2a-protocol`) |

## Async plugin init must be a thunk

A plugin that does async setup registers it with `trackPluginInit`, and it must
pass a FUNCTION, not an already-running promise:

```ts
// Right — the framework decides when and where the init starts.
const mount = async () => {
  await awaitBootstrap(nitroApp);
  /* … register routes … */
};
trackPluginInit(nitroApp, mount, { paths: ["/_agent-native/thing"] });

// Wrong — starts at isolate scope, which Cloudflare Workers forbids.
trackPluginInit(nitroApp, mount(), { paths: ["/_agent-native/thing"] });
```

Nitro calls plugins at isolate/module scope. On Workers, workerd answers any I/O
there with "Disallowed operation called within global scope", and work it does
attribute to the request that warmed the isolate is canceled the moment that
request answers — taking every other concurrent request's continuation with it.
A thunk lets the readiness gate start the init inside a live request context and
keep it alive with that request's `waitUntil`, and lets the gate re-run it once
after a failure instead of answering the same 503 for the isolate's whole life.

## Actions-First Approach

For standard CRUD and data operations, use `defineAction` in `actions/` — the framework auto-mounts them as HTTP endpoints at `/_agent-native/actions/:name`. Only create custom `/api/*` routes for things actions can't do:

- File uploads with multipart form data
- Streaming responses
- Webhooks from external services
- OAuth callbacks

Before adding a route, inspect the existing action files. Reuse the action if
it already encodes the business rule, or add a new action if the operation
should be available to both the agent and the UI. A route whose implementation
mostly calls an action is usually the wrong abstraction.

The Nitro Vite plugin handles both `/api/` and `/_agent-native/` prefixes via file-based routing in `server/routes/`.

## Related Skills

- `actions` — Prefer actions over custom `/api/` routes
- `authentication` — Auth middleware and session handling
- `portability` — Use H3 (not Express) for all routes
