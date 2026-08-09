---
"@agent-native/core": minor
---

Add Azure OpenAI as a first-class `ai-sdk:azure` provider. Set `AZURE_API_KEY`
plus either `AZURE_RESOURCE_NAME` or `AZURE_BASE_URL` and Azure appears in the
model picker and the settings key form alongside every other provider, with its
endpoint configurable beside its key.

Azure model ids are per-resource deployment names the framework cannot
enumerate, so the built-in list is a picker seed rather than a catalog and any
deployment name is stored and sent verbatim. This is preserved on both the
live-engine path and the stored-settings path: normalizing an Azure model id is
a silent wrong-model failure, because a deployment named `gpt-5.4` matches the
seed's `gpt-5.5` on family and suffix and a resource can have both, so the run
would quietly use a model the user did not choose and report success.

Requests use the Responses API, where reasoning models accept function tools and
reasoning effort together, and Azure gets its own reasoning-effort branch rather
than inheriting OpenAI's base-URL-gated downgrade to `"none"` — for Azure a base
URL is the normal endpoint, not a gateway. `AZURE_API_KEY` and `AZURE_BASE_URL`
join the app-provided deploy-credential allow-list, without which a deployed app
on D1 reports Azure as unconfigured while the key is present.

The provider package is an optional peer dependency, so installing the framework
does not pull SDKs an app will never use.
