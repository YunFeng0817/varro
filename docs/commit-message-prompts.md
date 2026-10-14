# Custom commit-message prompts

Set `varro.commitMessage.rules` in VS Code settings to define your own commit-message
style. These instructions supplement Varro's built-in prompt rather than replace it.

Use User settings for a personal default, or Workspace or Folder settings for a
repository-specific style. Repository settings take precedence over the user default.
Leave the setting empty to follow the inferred repository style.

For example, add this to your settings JSON:

```json
{
  "varro.commitMessage.rules": "Use an imperative, sentence-case subject without a prefix or final period. Omit the body unless needed."
}
```

## Short examples

Copy one example into the setting, or combine compatible instructions.
The sample messages illustrate formatting, not actual repository changes.

### Plain and concise

```text
Use an imperative, sentence-case subject without a prefix or final period.
Omit the body unless needed.
```

Sample: `Preserve chat drafts when switching sessions`

### Conventional Commits

```text
Use Conventional Commits with a lowercase description.
Add a scope only when it names a clear subsystem.
```

Sample: `fix(chat): preserve drafts when switching sessions`

### Explain substantial changes

```text
Use an imperative subject. For substantial changes, add a short body
explaining the behavior and any rationale supported by the diff.
```

Sample:

```text
Preserve chat drafts when switching sessions

Store each session's draft separately and restore it on selection.
```

### Subject only

```text
Return only an imperative subject, without a body or type prefix.
```

Sample: `Restore the selected session's draft`

## Writing your own rules

Specify format, capitalization, language, scope, or when to include a body.
Keep instructions short and avoid conflicting choices.

Custom rules override inferred style, but cannot allow invented claims, tool use,
or automatic commits. The subject limit remains 72 characters. Varro handles the
JSON response format; you do not need to request it in your rules.

See [Generate commit messages](usage.md#generate-commit-messages) for the workflow.
