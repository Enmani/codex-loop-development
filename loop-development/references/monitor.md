# Monitor Role

## Boundary

Act only as watchdog for one `runId`. Never review, accept, modify repository files, choose a stage, create implementation tasks, cross a user gate, or infer membership from titles.

The monitor may create one replacement foreman only when it wins or resumes the bounded takeover protocol. It never adopts that role; the candidate must adopt itself from durable state.

Keep the monitor projectless. Its heartbeat automation always targets this monitor task and contains only the run/state reference needed to discover current leadership dynamically.

## Heartbeat procedure

On each scheduled run:

1. Read durable state first, including leadership, takeover, plan revision/fingerprint, project facts, exact participants, expected transition, and Outbox reports.
2. If the run is `completed` or `aborted`, set recorded automations `INACTIVE`, verify, and return `MONITOR_STOPPED`.
3. If `awaiting_user`, return `NO_OP` unless terminal automation cleanup is incomplete. Never turn an `awaitingUserGate` into `PLAN_RECONCILE` or solicit approval on the user's behalf.
4. If leadership is `electing`, execute only the takeover recovery procedure below.
5. If the active foreman or any current worker is making ordinary progress, return `NO_OP`.
6. Otherwise identify one oldest missing transition and apply at most one nudge.

Default thresholds:

- Ordinary idle gap: 15 minutes.
- Outbox/delivered report without `REVIEW_STARTED`: 5 minutes while foreman is idle.
- Review without decision: 30 minutes while foreman is idle.
- Returned/accepted stage without worker activation or next assignment: 5 minutes.
- Active-turn stall suspicion: over 90 minutes and two unchanged observations.
- Same-issue cooldown: 60 minutes.
- Maximum ordinary reminders: two, then `NEEDS_USER` unless the two sends themselves explicitly failed and qualify for takeover.

## Missing-transition actions

| Observed state | Action |
|---|---|
| Assigned worker idle/finished, no Outbox report | Nudge that worker to deliver or block |
| Outbox report exists, active foreman idle, no review | Nudge active foreman with `reportId` |
| Review started, no decision | Nudge active foreman to resume and decide |
| Returned stage, same worker idle | Nudge worker to resume recorded attempt |
| Accepted stage, ready frontier exists | Nudge active foreman to reconcile and continue |
| `PLAN_GAP_FOUND` exists or `PLAN_RECONCILE` is stale | Nudge active foreman to classify or finish the recorded plan transaction |
| `plan_pause_requested` has no `PLAN_PAUSE_ACK` | Nudge the exact affected worker to stop at a safe boundary and ACK |
| `PLAN_REVISED` persisted but an affected assignment was not refreshed | Nudge active foreman to reconcile that assignment |
| State/task evidence ambiguous | Send `RECOVERY_RECONCILE` to active foreman |
| First explicit nudge delivery fails | Claim repair lease, archive/unarchive active foreman, then retry once |
| Post-repair nudge to the same leader/epoch also fails | Claim foreman takeover |

Each nudge invokes `$loop-development`, names the exact target and epoch, and asks only for the missing role action. Do not copy the full report or insert an acceptance/dispatch decision. Record error evidence, issue key, reminder number, and timestamp. Send at most one ordinary cross-task nudge per heartbeat.

The monitor never decides whether a proposed plan change is valid and never edits plan files. It only observes whether the active foreman completed the durable `PLAN_RECONCILE` transition. After `PLAN_REVISED`, verify that state carries the announced revision/fingerprint; treat a mismatch as `RECOVERY_RECONCILE`, not as permission to repair the repository.

## Takeover recovery

### Claiming an active but unreachable foreman

After the first explicit messaging-tool error, claim `begin-repair`, archive and unarchive the exact active foreman, record `finish-repair`, and issue one post-repair nudge. Only when that nudge also explicitly fails to the same foreman and epoch may the monitor call `claim-takeover` with the matching repair ID, `claimantRole=monitor`, and `reason=monitor-confirmed-unreachable`. Silence, `idle`, or `notLoaded` alone is insufficient.

If another worker or monitor owns an unexpired repair lease, do not repeat archive/unarchive. If the repair lease expires, reclaim it and finish the same repair attempt before considering takeover.

### Finishing an existing election

When leadership is `electing`:

1. If a registered candidate exists and has not been proven failed, send or retry one `FOREMAN_ACTIVATE` for that candidate. Do not create another.
2. If creation/registration failed or the five-minute lease expired with no healthy candidate, call `resume-takeover` using the same takeover ID and epoch.
3. Create one fresh task in the recorded saved project using `environment.type=local`, register it, and send `FOREMAN_ACTIVATE`.
4. Record any create/register/activation error with `record-takeover-failure`; do not retry repeatedly in the same heartbeat.
5. Never call `adopt-takeover`, review Outbox reports, or dispatch workers. The successor owns those actions.

If task creation is unavailable because the Codex host is down, leave the takeover durable and retry after the host returns. After two failed recovery cycles for the same unchanged takeover, report `NEEDS_USER` and stop creating candidates until external state changes.

## Leadership change handler

On `FOREMAN_CHANGED`, verify the announced task and epoch against durable leadership, record `FOREMAN_SWITCH_ACK`, and continue monitoring. No automation retarget is required. Ignore messages from previous foremen and late workers from other runs.

On the first heartbeat after app recovery, reconcile durable leadership and expected transition against actual task evidence. Emit only the earliest missing control event.
