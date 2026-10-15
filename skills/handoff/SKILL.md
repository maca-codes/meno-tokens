---
name: handoff
description: Write a short handoff note so the user can /clear and continue in a light session.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Write the handoff note to this exact file (use the Write tool):

!`node "${CLAUDE_SKILL_DIR}/../../scripts/handoff-path.js"`

The next session in this folder loads it automatically after `/clear`, so it must let a fresh session continue the work with no other context.

Rules:
- 40 lines at most. Facts only, no narration of what was done step by step.
- Write in the language the user uses.
- Use exactly these sections:

```
# Handoff — <date> — <task in a few words>
## Goal
<one or two sentences: what the user wants in the end>
## Done
<bullet list: results that exist now, with file paths>
## Open
<bullet list: what is left, in order; mark the very next step>
## Decisions and constraints
<choices the user made, preferences, things NOT to do>
## Key files
<paths, with line ranges when useful; only files the next step needs>
```

Leave out anything the next session can find quickly by itself (file contents, full logs, code already written).

Then tell the user, in one line, to type `/clear`: the new session will start from this note.
