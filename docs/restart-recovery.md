# Restart continuity

Connection recovery and execution recovery are different. Varro reattaches to a verified service and reloads canonical history, status, pending permissions, questions, and native inputs. An event subscription starts before connection readiness. Native events are live-only, so reconnect snapshots remain necessary even if no events appear missing.

## Who continues work

- OpenCode V2 owns durable execution recovery. Varro does not submit an automatic restart-continuation prompt, even if the active-session snapshot is empty. That snapshot describes process-local execution, not all durable claims waiting for recovery. A pending native input is not evidence that its session needs another prompt.
- The existing V1 continuation path remains under Varro's elected webview owner. The host rechecks status and pending attention before admitting a continuation.
- Explicit user sends and native Stop/Resume controls are unchanged. On older V2 versions or unmanaged services without native recovery, inspect the restored conversation and explicitly send the next instruction if needed. Varro does not infer recovery support from the installed client package.

OpenCode's managed service recovers interrupted durable claims. A standalone server need not perform the same recovery sweep. Reconnecting successfully does not prove an execution resumed or that an external operation happened only once.

## What survives

Native recovery is at-least-once. A process can die after an external effect but before recording its result, so recovery may repeat that effect. Use idempotent operations where possible and check actual results.

An active shell is not a durable OS process. Native recovery reports a lost background shell as cancelled because the server restarted. Varro also displays this native cancellation notice while it is still in the inbox, without waking an idle owner to deliver it. Its activity label says `Background command cancelled`, not `finished`. The notice keeps its native identity when delivery later moves it into history. A prior tool result saying that the shell started does not establish that it is still running. Long-lived services, awaited jobs, and child executions remain separate states.

Pending approval or a question still blocks work until the server acknowledges a reply. Child requests retain their child's session identity when displayed in the parent conversation. Native recovery can terminate after exhausting its retry budget. An idle status alone is not a successful outcome.

## Diagnostics and testing

The recovery entry points remain separate:

| Responsibility | Implementation |
| --- | --- |
| Endpoint discovery, credentials, listener identity, restart authority | `src/extension/open-code-process.ts`, `docs/server-ownership.md` |
| Stream attachment and generation-bound request admission | `src/extension/open-code-transport.ts`, `src/extension/server-connection-admission.ts` |
| Reconnect snapshots and missed terminal-event reconciliation | `src/webview/hooks/session/session-event-handlers.ts`, `src/webview/hooks/session/session-watchdog.ts` |
| Essential startup readiness and legacy continuation | `src/webview/hooks/connection-bootstrap.ts` |
| Webview recovery-owner election and acknowledgment | `src/extension/sidebar-provider.ts` |
| Host continuation admission and native-ownership guard | `src/extension/rest-proxy.ts` |
| Native inbox, shell, failure, and child projections | `src/extension/opencode-v2-adapter.ts`, `src/extension/opencode-v2-events.ts` |

The public V2 active-session snapshot does not expose suspended durable claims. The test fixture inspects only its own database read-only to retain claim and retry observations; production Varro does not read or change native claims to make recovery decisions.

Diagnostic exports retain connection and stream transitions, startup phase timings, and bounded `interrupted-recovery` decisions with the host request generation. `native-owned` means Varro skipped its own resubmission, not that the native execution succeeded. `legacy-blocked` and `legacy-admitted` describe the V1 admission check. These records contain no prompt, response, approval payload, or credential.

Run the isolated managed-service fixture with an explicit V2 executable:

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test scripts/restart-recovery.integration.test.mjs
```

Build first, then add `VARRO_AI_TEST_EDITOR=1` for real VS Code verification. The fixture uses a deterministic local provider, a separate database under `artifacts/ai-test-data/`, private service registration, and the existing isolated editor launcher. It verifies the listener and database owner before signalling only its own process. Graceful termination, abrupt death, native pending input, missed terminal events, lost shells, actual native child approvals, and the unchanged native retry budget have separate checks. Provider requests and canonical histories are retained as fixture evidence. These checks do not establish live subscription-model or cross-platform parity.

Rollback of the Varro checks changes no native claims or pending input. No extra recovery loop or durable recovery state is introduced.
