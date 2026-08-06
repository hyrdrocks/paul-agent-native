---
"@agent-native/core": patch
---

Resolve the durable background transport through a registry both hosts join as
peers. Transport selection used to be one host hardcoded in
`resolveBackgroundDispatchTarget()` with a second bolted on beside it, so a
reader saw two hosts handled two ways and could not tell which won when both
answered. Each host now registers a transport under `hosts/` declaring its own
consultation priority, and the resolver asks them in that declared order,
terminating in the portable in-process route. Priority is a declaration rather
than a position in a branch chain, so adding a host cannot silently displace an
existing one by being registered, imported, or bundled ahead of it.

The caller opt-out (`durableBackground: false`) resolves before any transport is
consulted — it is a caller fact, not a host fact, and never reaches the
registry.

`BackgroundDispatchTarget` no longer enumerates a per-host arm. What a caller
needs travels as declared properties — whether there is a `path` to POST to, and
whether the receiver carries its own long budget — rather than as a discriminant
every consumer in core has to recognise. The unclaimed-run watchdog now arms
from the transport's own `acknowledgesWithoutClaim` declaration: a transport
that acknowledges a handoff without proving a consumer claimed the run opts in,
one that returns a synchronous accepted status does not. Callers hand a run to a
transport with no path through the new `deliverBackgroundHandoff`, so no call
site needs to know which hosts POST and which do not.

`@agent-native/core/agent/durable-background` is now an export subpath, so a
consumer can ask which transport this process actually resolves without pulling
the whole server graph.
