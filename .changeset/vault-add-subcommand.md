---
"@agent-native/core": minor
---

Add `agent-native vault add KEY "description" [--app NAME]`, which stores one
secret in a workspace vault with its value read from a prompt that does not
echo. The value is never an argument: there is no value flag and a third
positional is refused, so the secret cannot reach this process's argv where
another local user reading the process table would see it, and it never lands
in shell history. The prompt ends on Enter rather than on an end-of-file
keystroke, so terminals that cannot send one still work, and standard input
ending before a value is entered is a loud refusal rather than an empty secret
— exit `74`, kept distinct from the `64` that means the command itself was
malformed.

Like `list`, it calls the workspace action — `create-vault-secret` — over HTTP
with the connect bearer the machine already holds, and takes the deployment as
an argument on the subcommand. No value reaches stdout or stderr on any path:
the confirmation names only the key, and the type carrying the deployment's
reply has no field for a value even though the action answers with the stored
row.
