---
name: errors
description: List the known errors token-diet remembers, with the fix recorded for each, or delete them.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[delete N | clear]"
---

!`node "${CLAUDE_SKILL_DIR}/../../scripts/errors.js" $ARGUMENTS`

Show the output above to the user exactly as it is, in a code block. Add nothing else.
