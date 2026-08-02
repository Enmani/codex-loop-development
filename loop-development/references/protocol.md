# Loop Development Protocol

## Contents

1. Truth ownership and plan contract
2. Durable state and leadership
3. Immutable report Outbox
4. Event envelope and stage state machine
5. Adaptive plan amendment transaction
6. Foreman failover transaction
7. Foreman snapshot and terminal shutdown
8. Idempotency and ready-frontier rules

## Truth ownership and plan contract

Keep one owner for each kind of truth:

- Repository plan and checklists: required scope, dependencies, acceptance, and user gates.
- Durable run state: execution state, active leadership epoch, participants, automation IDs, plan revision/fingerprint, decisions, and expected transition.
- Immutable report Outbox: worker delivery payloads that must survive message failure.
- Foreman's latest full `LOOP_STATE`: compact human-visible mirror of durable state.
- Worker messages and coordination cards: wake signals and evidence pointers, never acceptance truth.
- Monitor history: reminder cooldown and watchdog observations only.

Do not make task titles, summaries, delegation ancestry, or the monitor's interpretation authoritative.

Before dispatch, establish a stable `runId`, exact project ID/cwd, source plan paths, unique stage IDs, dependencies, scope, write sets, shared locks, verification, user gates, and maximum parallelism. Normalize ambiguous Markdown plans with the bundled manifest validator.

## Durable state and leadership

Store one record per run at `${CODEX_HOME}/loop-development/runs/<runId>.json`, falling back to `~/.codex/loop-development/runs/<runId>.json`.

Use schema version 2. The minimum leadership shape is:

```json
{
  "schemaVersion": 2,
  "runId": "loop-20260802-example",
  "revision": 7,
  "status": "running",
  "foremanThreadId": "thread-current",
  "leadership": {
    "epoch": 2,
    "status": "active",
    "activeForemanThreadId": "thread-current",
    "previousForemanThreadIds": ["thread-old"],
    "repair": null,
    "lastRepair": null,
    "takeover": null,
    "lastTakeover": null
  },
  "project": {
    "projectId": "saved-project-id",
    "cwd": "C:/repo",
    "environmentType": "local"
  },
  "workerProfile": {
    "model": "gpt-5.6-luna",
    "thinking": "max"
  },
  "monitorThreadId": "thread-monitor",
  "automationId": "automation-monitor",
  "auxiliaryAutomationIds": [],
  "planFiles": ["C:/repo/docs/plan.md"],
  "planRevision": 1,
  "planFingerprint": "sha256:...",
  "lastPlanChange": null,
  "awaitingUserGate": null,
  "planGapDecisions": {},
  "decisionLedger": [],
  "reportDecisions": {},
  "accepted": [],
  "active": {},
  "returned": {},
  "blocked": {},
  "ready": [],
  "expectedNext": null,
  "automationShutdown": null
}
```

`foremanThreadId` is only a compatibility mirror. Route from `leadership.activeForemanThreadId` and `leadership.epoch`. While `leadership.status=electing`, both active IDs are null and the prior foreman is fenced.

`workerProfile` is part of execution truth and is fixed to `gpt-5.6-luna` with `max` reasoning. Every initial or downstream implementation task must pass both overrides explicitly. The monitor remains `gpt-5.6-luna` with `xhigh`; the foreman profile is not changed unless the user separately specifies it.

Only the active foreman may use the generic execution write:

```text
node <skill-dir>/scripts/state-store.mjs write <runId> <expectedRevision> <actorForemanThreadId> <actorForemanEpoch> '<full-state-json>'
```

The tool rejects stale foreman ID/epoch pairs and rejects leadership edits through generic writes. It automatically reads legacy schema-1 records as epoch-1 active records; the next valid schema-2 write persists the migration.

## Immutable report Outbox

Before cross-task delivery, a worker must append the full report to:

```text
${CODEX_HOME}/loop-development/runs/<runId>/outbox/<reportId>.json
```

Use:

```text
node <skill-dir>/scripts/report-outbox.mjs enqueue <runId> <reportId> '<report-json>'
node <skill-dir>/scripts/report-outbox.mjs show <runId> <reportId>
node <skill-dir>/scripts/report-outbox.mjs list <runId>
```

Example report:

```json
{
  "schemaVersion": 1,
  "runId": "loop-20260802-example",
  "reportId": "G01-A1",
  "eventId": "loop-20260802-example/G01/1/report",
  "stageId": "G01",
  "attempt": 1,
  "sourceThreadId": "thread-worker",
  "targetForemanThreadIdAtCreation": "thread-old",
  "foremanEpochAtCreation": 1,
  "evidence": {
    "changedFiles": ["src/example.ts"],
    "verification": ["targeted tests passed"],
    "risks": []
  }
}
```

Outbox entries are immutable and idempotent by `reportId`. Only the active foreman records a result in `reportDecisions`; never delete a report during an active run.

## Event envelope and stage state machine

Begin every cross-task message with an explicit skill invocation and one JSON line:

```text
$loop-development
LOOP_EVENT {"v":3,"runId":"...","eventId":"...","role":"foreman","type":"STAGE_REPORT_READY","foremanEpoch":2,"stageId":"G01","attempt":1,"reportId":"G01-A1","targetThreadId":"...","requiredAction":"START_OR_RESUME_REVIEW"}
```

Set `role` to the receiver's handler role. Require `runId`, `eventId`, `role`, `type`, exact `targetThreadId`, `foremanEpoch`, and `requiredAction`. Initial child prompts may use `targetThreadId="delegated-child"` until creation returns an exact ID.

Primary events:

- `MONITOR_CONFIG`, `STAGE_ASSIGN`, `STAGE_REPORT_READY`, `STAGE_BLOCKED`.
- `REVIEW_STARTED`, `STAGE_DECISION`, `STAGE_REWORK`, `DELIVERY_RETRY`.
- `PLAN_GAP_FOUND`, `PLAN_PAUSE`, `PLAN_PAUSE_ACK`, `PLAN_REVISED`, `USER_DECISION_REQUIRED`, `USER_DECISION_RECORDED`.
- `WATCHDOG_NUDGE`, `RECOVERY_RECONCILE`, `RUN_COMPLETE`, `RUN_ABORTED`.
- `FOREMAN_REPAIR_STARTED`, `FOREMAN_REPAIR_FINISHED`, `FOREMAN_ACTIVATE`, `FOREMAN_CHANGED`, `FOREMAN_SWITCH_ACK`, `FAILOVER_HELP_REQUEST`.

The receiver must compare the event epoch and source identity with durable leadership. A report originally created under an older epoch may be recovered from Outbox, but its new wake event must target the current foreman and current epoch. Deduplicate wake events by `eventId`, reports by `reportId` plus recorded decision, and takeover by `takeoverId`.

Allow only these stage transitions:

```text
pending -> assigned -> report_ready -> reviewing -> accepted
             |         |              |
             |         |              -> returned -> report_ready
             |         -> blocked
             -> plan_paused
             -> plan_pause_requested -> plan_paused -> assigned
                                      |               -> returned -> report_ready
                                      -> report_ready
reviewing -> blocked
```

The direct `assigned -> plan_paused` edge is allowed only for the reporting worker whose delivered `PLAN_GAP_FOUND` has `safeBoundaryReached=true`; every other active worker must use the ACK path. Store `plan_pause_requested` in the active stage entry so its capacity and locks remain reserved. After `PLAN_PAUSE_ACK`, move it to the blocked map with `status=plan_paused`, preserving exact worker ID, attempt, previous plan revision, gap ID, and resume mode. Re-activate the same worker with a refreshed assignment and unchanged attempt when its existing work remains valid; use `STAGE_REWORK` with an incremented attempt when the new contract invalidates submitted work. Mark an unrecoverable worker `superseded` before replacing it. `partial` and `plan_paused` do not satisfy dependencies.

## Adaptive plan amendment transaction

Workers may discover that the approved plan is incomplete or technically wrong while implementing it. They must preserve a `kind=plan-gap` report with stable `gapId` and `reportId` in Outbox and send `PLAN_GAP_FOUND` to the active foreman; they do not edit the governing plan, broaden their assignment, or decide the remedy. The report includes `safeBoundaryReached=true`, and successful delivery is the worker's last tool action, so that event also acknowledges the reporting worker's pause. Other affected active workers still require `PLAN_PAUSE`/`PLAN_PAUSE_ACK`.

The active foreman owns `planGapDecisions[gapId]`. Its status is one of `reported`, `pause_requested`, `reconciling`, `awaiting_user`, `applied`, or `not_a_plan_gap`, and it records the report ID, classification, change ID, and resulting plan revision when known. A duplicate gap event resumes this recorded transition; `applied` returns the existing result and can never increment `planRevision` again.

The active foreman first distinguishes a genuine plan defect from temporary unavailability, ordinary implementation difficulty, or a currently blocked external dependency. Only a genuine defect enters plan amendment; the others remain normal `STAGE_BLOCKED` handling. Then classify the proposed plan change:

- `technical-closure`: may be applied autonomously when it only adds a missing prerequisite, corrects dependencies, splits an existing stage, or strengthens verification needed to reach the already approved goal.
- `user-approved`: required before changing the product goal or scope boundary, weakening acceptance, removing or crossing a user gate, adding external services/cost/credentials, authorizing irreversible operations, or changing an active worker's write/safety authority.

For `user-approved`, keep the affected stage blocked, write `status=awaiting_user`, `expectedNext=null`, and a durable `awaitingUserGate` containing a stable `gateId`, `proposalId`, gap/report IDs, requested changes, preserved acceptance, and exact authority requested. Emit `USER_DECISION_REQUIRED` and stop. Do not edit the plan or dispatch affected descendants until the user explicitly approves that exact proposal.

A vague `continue`, worker/monitor agreement, or approval of a different gate is not approval. When external services are involved, the proposal must separately disclose service identity, spending bound, credential provisioning/storage, data handling, and permitted side effects; omitted authority remains forbidden, and approval to revise the plan does not imply that credentials are available. Record an explicit, scoped user response as `USER_DECISION_RECORDED` with a stable event ID. Only then clear `awaitingUserGate`, return to `running`, set `expectedNext=PLAN_RECONCILE`, and apply the change. A user-approved applied change names that event in `lastPlanChange.approvalEventId`.

Apply an authorized change as one recoverable transaction:

1. Pass the foreman fence check, load the immutable gap report, and create or resume `planGapDecisions[gapId]` through a completed fenced state write. When the reporting worker is still active and its delivered report has `safeBoundaryReached=true`, that same write moves it directly from active to blocked `plan_paused`; do not send it a redundant `PLAN_PAUSE`.
2. For each other affected active worker, process one at a time: set the gap decision to `pause_requested`, persist that exact stage as `plan_pause_requested`, keep its capacity/locks reserved, set `expectedNext=PLAN_PAUSE_ACK` for that worker, send one `PLAN_PAUSE`, and end the foreman turn. The worker stops at a safe boundary, re-reads state, sends `PLAN_PAUSE_ACK`, and finishes. On ACK, move it to blocked `plan_paused` and release its active locks/capacity; then pause the next affected worker in a later event turn. Never edit the plan concurrently with an unacknowledged affected worker; if that task is independently confirmed unrecoverable, use the existing supersede rules.
3. After the reporting worker and every other affected worker are durably `plan_paused`, complete a separate fenced write setting the gap decision to `reconciling` and `expectedNext.type=PLAN_RECONCILE`. This durable write must finish before editing plan files. Pause only dispatches that could cross the affected dependency boundary.
4. Re-read all `planFiles`; ensure no active worker owns their write set. Preserve accepted-stage history and existing stable stage IDs. Add new stable IDs instead of renumbering old stages.
5. Edit the governing plan/checklists, then validate stage IDs, dependencies, write sets, locks, acceptance, and user gates. A plan edit that lowers prior acceptance or invalidates accepted evidence is not autonomous.
6. Compute the canonical fingerprint over the ordered current `planFiles`:

```text
node <skill-dir>/scripts/plan-fingerprint.mjs '<plan-files-json-array>'
```

Use this helper at startup, after amendment, and during successor reconciliation so path normalization, byte framing, and ordering stay identical.
7. Advance `planRevision` by exactly one and write a new fingerprint plus `lastPlanChange`: gap ID, change ID, from/to revisions, reason, active foreman ID, classification, affected stage IDs, changed files, timestamp, and approval event when required.
8. Record the reasoning in `decisionLedger`, mark the same stable gap decision `applied` with matching change ID and target plan revision, recompute `ready` and `blocked`, and persist through the fenced generic write. The state tool rejects a repeated applied gap. Do not dispatch from a plan revision that has not been persisted.
9. Send `PLAN_REVISED` to the monitor and every affected active/returned/blocked worker. Include old/new revision, fingerprint, affected stages, each assignment disposition (`unaffected`, `remain_paused`, `refresh_assignment`, or `rework`), and `requiredAction=RELOAD_PLAN_AND_RECONCILE_ASSIGNMENT`.
10. Unaffected workers may continue. An affected worker remains paused until a refreshed `STAGE_ASSIGN` or `STAGE_REWORK` from the active foreman; `PLAN_REVISED` alone never reactivates it.
11. Dispatch the newly valid ready frontier under the new revision, emit `LOOP_STATE`, and finish.

If editing, validation, fingerprinting, or state persistence fails, leave `expectedNext=PLAN_RECONCILE`, do not partially dispatch the new DAG, and repair or revert only the incomplete plan edit using repository-safe recovery. A successor foreman must compare durable `planFingerprint` with current `planFiles` before review or dispatch; mismatch is a fail-closed reconciliation condition, not permission to guess.

## Foreman failover transaction

### Repair before replacement

A worker or monitor that receives the first explicit messaging-tool error must try one in-place repair before replacement:

1. Re-read leadership and atomically claim the repair lease:

```text
node <skill-dir>/scripts/state-store.mjs begin-repair <runId> <expectedRevision> '<repair-claim-json>'
```

2. Only the lease holder calls the native archive tool with `archived=true` for the exact active foreman, then calls it again with `archived=false` for the same task/host.
3. Record both tool outcomes:

```text
node <skill-dir>/scripts/state-store.mjs finish-repair <runId> <expectedRevision> <repairId> '<repair-result-json>'
```

4. Re-read leadership and retry the original delivery once with the same `reportId`, a new `eventId`, and type `DELIVERY_RETRY`.

The repair lease lasts three minutes and serializes concurrent detectors. Other workers must not archive/unarchive while a healthy repair lease exists. An expired lease may be reclaimed. Always attempt the post-repair delivery once, even when one archive operation reported failure, so takeover evidence describes the actual final route condition.

If the post-repair delivery succeeds, finish normally and do not change epoch. If it explicitly fails to the same foreman and epoch, takeover is permitted. A successful send followed by silence is handled by the monitor and is not delivery failure.

A monitor follows the same archive/unarchive repair sequence after its first explicit failed nudge. It may initiate takeover only when its post-repair nudge also explicitly fails, or when durable state already contains a failed worker takeover needing recovery.

### Claim and fence

Claim atomically:

```text
node <skill-dir>/scripts/state-store.mjs claim-takeover <runId> <expectedRevision> '<claim-json>'
```

The claim must name the old foreman/epoch, claimant task/role, reason, failed report when relevant, the matching completed repair ID, and two failed-delivery records surrounding that repair. The successful claim increments the epoch, sets leadership to `electing`, clears the active foreman, and creates a five-minute lease. That write is the fencing point. Concurrent claimants must accept revision conflict or the existing takeover and must not create another successor.

### Create, register, and activate

The claim winner creates one fresh task in the recorded saved project with `environment.type=local`. Do not fork the failed foreman by default. Register the returned task ID:

```text
node <skill-dir>/scripts/state-store.mjs register-candidate <runId> <expectedRevision> <takeoverId> '<candidate-json>'
```

Then send the candidate `FOREMAN_ACTIVATE`. The candidate verifies its exact ID and adopts:

```text
node <skill-dir>/scripts/state-store.mjs adopt-takeover <runId> <expectedRevision> <takeoverId> <candidateThreadId>
```

Only after adoption may it review, return, accept, or dispatch. It loads plan/checklists, durable state, repository facts, decision ledger, worker IDs, Outbox, and optionally a small readable tail of the old foreman. Old conversation history is supplementary, never required truth.

If create/register/activation fails, record it:

```text
node <skill-dir>/scripts/state-store.mjs record-takeover-failure <runId> <expectedRevision> <takeoverId> '<failure-json>'
```

The monitor may resume a failed or expired takeover without incrementing the epoch again:

```text
node <skill-dir>/scripts/state-store.mjs resume-takeover <runId> <expectedRevision> <takeoverId> '<resume-json>'
```

Do not replace a registered candidate until it is independently confirmed unrecoverable. If the entire Codex app/server is unavailable, recovery pauses and resumes after the host returns.

### Reconcile and broadcast

After adoption, the new foreman:

1. Reconciles stage state and `expectedNext` against repository and Outbox evidence.
2. Sends `FOREMAN_CHANGED` to the monitor and every exact active/returned/blocked worker ID.
3. Does not wait for every ACK; each worker must also refresh leadership immediately before its next handoff.
4. Processes the takeover's failed report first when it remains undecided.

The monitor automation stays attached to the monitor task and reads leadership dynamically. Never retarget it during takeover.

Every foreman activation begins with a fence check. A task whose ID/epoch is not active returns `FOREMAN_RETIRED` without writing state, reviewing, messaging workers, or dispatching.

## Foreman snapshot and terminal shutdown

End every active-foreman turn with one compact complete snapshot:

```text
LOOP_STATE {"v":3,"runId":"...","revision":8,"status":"running","leadership":{"epoch":2,"status":"active","activeForemanThreadId":"..."},"planRevision":2,"planFingerprint":"sha256:...","monitorThreadId":"...","automationId":"...","accepted":["G01"],"active":{},"returned":{},"blocked":{},"ready":["G02"],"awaitingUserGate":null,"lastEventId":"...","expectedNext":{"actorThreadId":"...","type":"STAGE_ASSIGN","since":"..."},"automationShutdown":null}
```

Completion is valid only when every manifest stage is accepted, active/returned/blocked/ready/pending are empty, every user gate is approved, and final evidence is recorded. Then exactly once:

1. Write `status=completed`, `expectedNext=null`, and `automationShutdown.status=pending`.
2. Send the monitor `RUN_COMPLETE`.
3. Set all recorded loop automations to `INACTIVE`; never delete them automatically.
4. Verify inactivity and write `automationShutdown.status=stopped` or exact partial failures.

## Idempotency and ready-frontier rules

- Resume an existing run instead of creating duplicate monitor, worker, or successor tasks.
- A duplicate report without a decision resumes review; a decided report returns the recorded decision.
- Ignore late messages from superseded workers and all control messages from fenced foremen.
- Re-read repository files before review; worker summaries and old task history are evidence only.
- Re-read the durable plan revision before every assignment and handoff. A stale `PLAN_GAP_FOUND` remains evidence but cannot roll back a newer plan.
- Treat `idle` and `notLoaded` as runtime states, not completion or failure proof.
- Dispatch ready stages only when every dependency is accepted, capacity remains, write sets and locks are compatible, active coordination has no conflicting owner, and no user gate blocks progress.
- When uncertain, serialize rather than create speculative parallel work.
