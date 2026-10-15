# token-diet

A Claude Code plugin that cuts token waste where it actually happens. There is no proxy, no server, no background process, and no dependencies beyond Node.js.

Every message you send re-sends the whole conversation. A session that grows to 150k tokens pays for those 150k tokens on every turn, and most of them are tool output the model has already used. token-diet works on that.

## What it does

| Where | What | How |
|---|---|---|
| Long tool output | Trims Bash, PowerShell and Grep output over ~2k tokens. Keeps the start, the end, and every error or warning line in between. | The full output is saved to a file. The model can Grep it or read a range when it needs more. |
| Big file reads | When the model reads a whole file of 400+ lines, it is asked to Grep or read a range first. | If the model repeats the same call, the read goes through. It is never stuck. |
| Re-reads | Stops reading a file again when it is unchanged and already in context. | Edits, `/clear` and compaction reset this. Subagents are tracked separately. |
| Loops | When a tool fails 3 times with the same error, or a command keeps returning the same error output, the model is told to stop and change strategy. You see a one-line notice. | Numbers in errors are ignored, so line numbers or timings do not hide a repeat. Generic errors (`Exit code 1`) only count when the call is the same. |
| Known errors | When a call fails and the same call later succeeds, the edits and commands in between (8 at most) are saved as the fix. If the same error comes back, in any project, that fix is passed to the model as a hint (~100 tokens). | Paths and numbers are masked, so the same error in another folder still matches. Stored in `~/.claude/token-diet/errors.json`, expires after 60 days. `/token-diet:errors` lists them, `/token-diet:errors delete N` removes one. |
| Heavy sessions | Warns you at 80k, 150k, 250k and 400k tokens of context. | The warning goes to you, not to the model, so it costs no tokens. |
| Restart light | `/token-diet:handoff` writes a short note (stored in `~/.claude/token-diet/`, never in the repo). After `/clear`, the new session loads it automatically. | You continue with a few hundred tokens instead of the whole old context. |
| Proof | `/token-diet:report [days]` shows the savings per day. | Reads the model insisted on are subtracted, so the number is not inflated. |

Every intervention is logged. Nothing is sent anywhere.

## Install

```
claude plugin marketplace add <owner>/token-diet
claude plugin install token-diet@token-diet
```

From a local folder:

```
claude plugin marketplace add ./token-diet
claude plugin install token-diet@token-diet
```

## Configure

Create `config.json` in the plugin data folder (`~/.claude/plugins/data/token-diet-<marketplace>/`). Set only the keys you want to change:

```json
{
  "lang": "en",
  "trimMaxChars": 8000,
  "trimHeadLines": 40,
  "trimTailLines": 30,
  "readMaxLines": 400,
  "contextWarnAt": [80000, 150000, 250000, 400000],
  "loopAfter": 3
}
```

To keep a single command's output untouched, end the command with `# full`.

## Works well with

- [RTK](https://github.com/rtk-ai/rtk), which rewrites shell commands into compact forms. token-diet trims whatever is still too long.
- [CodeBurn](https://github.com/getagentseal/codeburn), which measures real spend before and after.

## Test

```
node test/run.js
```

## License

MIT
