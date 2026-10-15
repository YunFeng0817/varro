# Background slash commands

Varro already runs configured commands through OpenCode's native command executor. Type `/` to
discover them, then submit a command with its arguments as usual. Existing argument and attachment
forwarding rules are unchanged.

OpenCode V2's command catalog currently exposes only names and descriptions. Varro does not guess
delegation from a command's name, description, selected agent, or a separate config document.
Commands without descriptions say "Runs according to its OpenCode definition". Selecting a native
command in completion shows help about child navigation and result delivery, not a background badge.
Prompt templates are not included in Varro's V2 command catalog.

## Configure delegation in OpenCode

For example, create `.opencode/commands/audit.md` yourself:

```markdown
---
description: Audit changes
agent: general
subagent: true
---

Audit $ARGUMENTS for bugs and missing tests.
```

Run `/audit src/auth`. OpenCode expands the arguments and launches a child. The native command API
also preserves any attachments it receives. The parent keeps its agent and model. The child uses the
command's explicit model override, then the command agent's model, then the parent's model. Without delegation, native command agent
and model overrides can change the current session instead.

`subagent: false` forces the current session. When omitted, OpenCode follows the configured command
agent's mode. The legacy `subtask` alias is accepted by V2, but `subagent` takes precedence.
These are V2 semantics, not a promise about V1's task behavior.

Definitions can also live in global command directories or JSON/JSONC config. OpenCode owns discovery,
precedence, and reloads. Varro never rewrites definitions or adds a per-invocation background flag.
See the [V2 command guide](https://opencode.ai/v2/docs/commands/#background) and
[configuration guide](https://opencode.ai/v2/docs/config/).

## Follow work and results

Launching a child does not select it. Use the parent's sub-agent session list to follow running work.
Permission requests continue to use the existing owning-session approval flow.

OpenCode sends completed, failed, or cancelled child results back to the parent. Varro displays them
as expandable subagent activities. Expand a result to open its subagent session, using the same
navigation pattern as running subagent activities and the existing return navigation.
Attribution uses native completion metadata, not the wrapper text or session title. Older backends
without that metadata retain their existing automatic-context presentation.

A launch error belongs to the parent command execution. A later child failure appears as a failed
subagent result linked to that child. Interrupting the parent is not a new child-specific stop control.

If the connection drops after admission, the outcome is uncertain. Varro reads session state without
automatically invoking the command again. Reconnect restores native history and children through the
existing refresh path. Check them before manually retrying; no second prompt is sent to collect results.
