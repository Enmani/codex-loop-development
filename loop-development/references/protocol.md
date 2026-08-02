# Loop Development Protocol

## Contents

1. Truth ownership and plan contract
2. Durable state and leadership
3. Immutable report Outbox
4. Event envelope and stage state machine
5. Foreman failover transaction
6. Foreman snapshot and terminal shutdown
7. Idempotency and ready-frontier rules

## Truth ownership and plan contract

Keep one owner for each kind of truth:

- Repository plan and checklists: required scope, dependencies, acceptance, and user gates.
- Durable run state: execution state, active leadership epoch, participants, automation IDs, decisions, and expected transition.
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
- `WATCHDOG_NUDGE`, `RECOVERY_RECONCILE`, `RUN_COMPLETE`, `RUN_ABORTED`.
- `FOREMAN_REPAIR_STARTED`, `FOREMAN_REPAIR_FINISHED`, `FOREMAN_ACTIVATE`, `FOREMAN_CHANGED`, `FOREMAN_SWITCH_ACK`, `FAILOVER_HELP_REQUEST`.

The receiver must compare the event epoch and source identity with durable leadership. A report originally created under an older epoch may be recovered from Outbox, but its new wake event must target the current foreman and current epoch. Deduplicate wake events by `eventId`, reports by `reportId` plus recorded decision, and takeover by `takeoverId`.

Allow only these stage transitions:

```text
pending -> assigned -> report_ready -> reviewing -> accepted
                       |              |
                       |              -> returned -> report_ready
                       -> blocked
reviewing -> blocked
```

`partial` does not satisfy a dependency. Mark an unrecoverable worker `superseded` before replacing it.

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
LOOP_STATE {"v":3,"runId":"...","revision":8,"status":"running","leadership":{"epoch":2,"status":"active","activeForemanThreadId":"..."},"monitorThreadId":"...","automationId":"...","accepted":["G01"],"active":{},"returned":{},"blocked":{},"ready":["G02"],"awaitingUserGate":null,"lastEventId":"...","expectedNext":{"actorThreadId":"...","type":"STAGE_ASSIGN","since":"..."},"automationShutdown":null}
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
- Treat `idle` and `notLoaded` as runtime states, not completion or failure proof.
- Dispatch ready stages only when every dependency is accepted, capacity remains, write sets and locks are compatible, active coordination has no conflicting owner, and no user gate blocks progress.
- When uncertain, serialize rather than create speculative parallel work.
