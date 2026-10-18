---
name: hygiene
description: Measure the fixed context every session loads (instructions, memory, skill descriptions, MCP servers, startup hooks) and what of it was used. With "analyze", also propose cuts.
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
argument-hint: "[days] [analyze]"
context: fork
model: sonnet
---

You run in a separate subagent so the files you read stay out of the main conversation. Your final message is what the user gets: put the whole answer in it.

!`node "${CLAUDE_SKILL_DIR}/../../scripts/hygiene.js" $ARGUMENTS --files`

Show the report above to the user exactly as it is, in a code block, without the FILES list at the end.

If the arguments do not contain "analyze" or "analizza": add only one line, in the user's language, saying that `/token-diet:hygiene analyze` gives a full analysis with proposals. Stop there.

If they do, read every file in the FILES list, then propose cuts in the user's language, grouped like this:

1. **Contradictions and duplicates**: rules that say opposite things, or the same thing in two places. Say which copy to keep.
2. **Rules to scope**: instructions that only matter for some files or folders (one project, one language). Propose moving them to `.claude/rules/<name>.md` with a `paths:` frontmatter, or into that project's CLAUDE.md.
3. **Procedures to turn into skills**: long step-by-step instructions that are needed only for one kind of task. A skill loads only when used.
4. **Text to shorten**: show the current text and the shorter one, with the same meaning.
5. **Skills and MCP servers never used** in the report: list them as candidates to review. Do not recommend removing them without the user's decision.

For each proposal give the file, the change, and the estimated tokens saved per session (1 token ≈ 4 characters). Keep it short: only proposals with a real saving or a real conflict.

Change nothing. Ask the user which proposals to apply.
