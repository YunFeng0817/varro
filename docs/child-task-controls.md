# Child task controls

Expand an active subagent tool's details in the parent conversation. The compact **actions** row
contains the available buttons, aligned with the other label/value rows. Completed and failed tools
have no management controls. Child session views have no management controls or footer disclosure.

- **Stop task** uses native V2 interruption with automatic steering resume disabled. It does
  not interrupt the parent or siblings. Native cancellation also unwinds the child's blocking tools,
  including foreground descendants. Independent background descendants can keep running.
- **Background** calls the parent's native background operation. It moves
  all eligible blocking tools in that parent, not only the displayed child. Native completion
  notifications and unfinished-work guidance remain owned by OpenCode.

The actions row has no whole-task stop button. The ordinary parent composer stop is unchanged.

Child-only interruption requires the server's advertised interrupt contract. Background handoff is
shown only for verified native foreground subagent progress and an advertised background operation.
Running-tool history can omit progress. In that case, only progress observed in the current host
connection establishes eligibility; reconnecting hides the action until fresh native evidence exists.
The host rechecks native ancestry, directories, eligibility, and connection generation before dispatch.
A finished job can make handoff a no-op; HTTP success alone is not presented as a successful handoff.
V1 does not expose these new native actions. Cross-directory parent/child controls are unavailable.

Interrupt acknowledgement does not prove settlement. Status, permissions, and questions reconcile
from server events and fresh snapshots; stopping a child never locally removes an unresolved prompt.
