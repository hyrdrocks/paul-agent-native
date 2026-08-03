---
"@agent-native/dispatch": minor
---

Record vault sync and vault request events in the dispatch audit log instead of
the vault log alone, and stamp every vault audit event with an explicit
visibility and org so the trail is readable by the same people who can read the
vault row it describes.
