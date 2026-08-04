---
"@agent-native/core": minor
---

Add `agent-native vault list [--app NAME]`, which prints the credential keys and
display names of the secrets in a workspace vault and never a value — not even a
masked preview — so seeing what is available cannot put a credential in a
transcript. It calls `list-vault-secrets` over HTTP with the connect bearer the
machine already holds, discovered through the CLI's existing multi-client,
multi-scope scan, and takes the deployment as an argument so one installation
serves every connected app. This opens the vault subcommand dispatch point:
`exec` behaves exactly as before, and an unknown subcommand still exits `64`.

Every vault call now goes out through one request path, so the explicit
`User-Agent` — load-bearing, because the edge proxy in front of at least one
deployment rejects a default runtime agent string with an error that reads like
a disabled route — is sent by `vault exec`'s lease call as well.
