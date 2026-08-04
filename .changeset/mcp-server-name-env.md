---
"@agent-native/core": patch
---

Let a deployment name its MCP server with `MCP_SERVER_NAME`.

The connect page, the copyable client config and device-flow grants all report a
server id that defaulted to `agent-native-<first label of the hostname>`. The
only way to change it was `createCoreRoutesPlugin({ mcpConnectServerName })`,
which a deployment consuming a pre-composed core-routes plugin cannot reach —
recomposing it would need that package's own private options — so such
deployments could not rename their MCP server at all.

`MCP_SERVER_NAME` now fills in when no explicit option was passed. Precedence is
explicit option, then env, then the derived default: an app that named its server
in code keeps that name, so a deployment-wide variable cannot silently take it
over.

`mcpConnectAppName` already had an equivalent escape hatch — core-routes falls
back to `getAppName()`, which reads `APP_NAME` — so the human-readable app name
needed no change.
