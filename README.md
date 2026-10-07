# superpowers-progress

A Claude Code mod that draws a progress band above the prompt while you run a [superpowers](https://github.com/obra/superpowers) plan. It shows the overall done/total count, one segment per phase, the current task, and (for subagent-driven runs) the stage of that task: brief, implementer, review, fix, gate, PR.

It reads two things from disk and nothing else:

- the plan file, `docs/superpowers/plans/*.md`;
- the SDD ledger of the run, `.superpowers/sdd/<plan-slug>/progress.md`, with the lines `Task N: complete`.

The band stays hidden until the session has either run a `superpowers:*` skill or touched a ledger or plan path with a tool call, so it never shows up in projects that don't use superpowers.

## Install

In a terminal session:

```
/plugin install superpowers-progress --marketplace Dave93/superpowers-progress
```

Answer `y` to add the marketplace and pick the **user** scope. The mod then loads in every project, in each session started after the install, and in the current one at once.

## Command

`/sp-progress` with no argument opens a pane with every phase and task. Arguments:

| Argument | Effect |
| --- | --- |
| `hide`, `show` | hide or show the band |
| `status` | print the active target and the newest ledgers found |
| `use <slug-or-path>` | pin a ledger; it beats the automatic choice |
| `use auto` | release the pin |

Worktrees that sit beside the session's directory and hold a ledger of the same plan slug are merged: a task done in any of them counts as done.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`.claude-plugin/types/` is written by the engine on load and is git-ignored.

## License

MIT
