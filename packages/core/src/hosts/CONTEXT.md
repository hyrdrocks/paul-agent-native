# Agent Native — Host

The framework runs the same application on more than one deployment platform.
This is the vocabulary of that seam, and it is the vocabulary of the framework
itself: nothing here depends on our forks existing. The repository's other
glossary is `CONTEXT.md` at the root, which is about the forks; `CONTEXT-MAP.md`
says which is which and why they stay apart.

Use these terms as defined. Where a term has common synonyms, they are listed
under `_Avoid_` — the synonyms mean something else here, or nothing.

## Language

**Host**:
A deployment platform an app runs on, together with the runtime it provides.
_Avoid_: Provider, environment, target

**Host adapter**:
The framework's knowledge of one host, kept in one place and reached through
registration rather than by the framework asking for it by name.
_Avoid_: Host plugin, host driver, platform shim

**Background transport**:
The mechanism a host offers for handing a run to a worker that outlives the
request which created it.
_Avoid_: Queue, background function, dispatcher

**Dialect capability**:
A named guarantee a database dialect either offers or does not, stated as the
guarantee itself rather than as the dialect's name.
_Avoid_: Dialect flag, database feature, driver check

**Provider tier**:
Whether a registered provider came from the app or from the platform beneath
it — the declaration that decides which one is preferred.
_Avoid_: Priority, rank, provider level

**Fallback storage**:
Storing a payload somewhere that is not the intended store because the intended
one is unavailable. Whether it is permitted at all is a property of the host.
_Avoid_: Backup storage, degraded storage, SQL blobs

**Seam allow-list**:
The enumerated set of modules permitted to hold knowledge that a boundary
otherwise keeps out, maintained as the record of where that boundary sits.
_Avoid_: Exception list, whitelist, ignore list
