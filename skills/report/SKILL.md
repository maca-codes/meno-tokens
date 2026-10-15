---
name: report
description: Show how many tokens token-diet saved, per day.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[days]"
---

!`node "${CLAUDE_SKILL_DIR}/../../scripts/report.js" $ARGUMENTS`

Show the report above to the user exactly as it is, in a code block. Add nothing else.
