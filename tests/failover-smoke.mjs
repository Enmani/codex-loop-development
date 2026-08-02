#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateStore = path.join(root, "loop-development", "scripts", "state-store.mjs");
const outbox = path.join(root, "loop-development", "scripts", "report-outbox.mjs");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "loop-development-test-"));
const env = { ...process.env, CODEX_HOME: codexHome };
const runId = "failover-smoke";

function run(script, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `command failed: ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function state() {
  return run(stateStore, ["show", runId]);
}

try {
  const initial = {
    schemaVersion: 2,
    runId,
    status: "running",
    foremanThreadId: "foreman-old",
    leadership: {
      epoch: 1,
      status: "active",
      activeForemanThreadId: "foreman-old",
      previousForemanThreadIds: [],
      repair: null,
      lastRepair: null,
      takeover: null,
      lastTakeover: null
    },
    project: { projectId: "project-1", cwd: "C:/repo", environmentType: "local" },
    workerProfile: { model: "gpt-5.6-luna", thinking: "max" },
    monitorThreadId: "monitor-1",
    automationId: "automation-1",
    auxiliaryAutomationIds: [],
    planFiles: ["C:/repo/plan.md"],
    decisionLedger: [],
    reportDecisions: {},
    accepted: [],
    active: { G01: { threadId: "worker-1", attempt: 1, status: "assigned" } },
    returned: {},
    blocked: {},
    ready: [],
    expectedNext: { actorThreadId: "worker-1", type: "STAGE_REPORT_READY", stageId: "G01", attempt: 1, since: "2026-08-02T00:00:00.000Z" },
    automationShutdown: null
  };

  const created = run(stateStore, ["init", runId, JSON.stringify(initial)]);
  assert.equal(created.revision, 0);

  const report = {
    schemaVersion: 1,
    runId,
    reportId: "G01-A1",
    eventId: "failover-smoke/G01/1/report",
    stageId: "G01",
    attempt: 1,
    sourceThreadId: "worker-1",
    targetForemanThreadIdAtCreation: "foreman-old",
    foremanEpochAtCreation: 1,
    evidence: { changedFiles: ["src/a.js"], verification: ["tests passed"] }
  };
  const queued = run(outbox, ["enqueue", runId, report.reportId, JSON.stringify(report)]);
  const queuedAgain = run(outbox, ["enqueue", runId, report.reportId, JSON.stringify(report)]);
  assert.equal(queuedAgain.createdAt, queued.createdAt);
  assert.equal(run(outbox, ["list", runId]).length, 1);
  run(outbox, ["enqueue", runId, report.reportId, JSON.stringify({ ...report, evidence: { changedFiles: ["src/other.js"] } })], 1);
  run(outbox, ["path", runId, "../escape"], 1);

  const firstFailure = { eventId: "send-1", targetThreadId: "foreman-old", foremanEpoch: 1, attemptedAt: new Date().toISOString(), error: "transport failed" };
  const repairRequest = {
    claimantThreadId: "worker-1",
    claimantRole: "worker",
    targetForemanThreadId: "foreman-old",
    foremanEpoch: 1,
    triggerFailure: firstFailure
  };
  const repairClaimed = run(stateStore, ["begin-repair", runId, "0", JSON.stringify(repairRequest)]);
  assert.equal(repairClaimed.leadership.repair.status, "claimed");
  run(stateStore, ["begin-repair", runId, "1", JSON.stringify(repairRequest)], 1);
  const repairId = repairClaimed.leadership.repair.repairId;
  const repairFinished = run(stateStore, ["finish-repair", runId, "1", repairId, JSON.stringify({ actorThreadId: "worker-1", status: "completed", archiveSucceeded: true, unarchiveSucceeded: true })]);
  assert.equal(repairFinished.leadership.lastRepair.status, "completed");

  const secondFailure = { eventId: "send-2", targetThreadId: "foreman-old", foremanEpoch: 1, attemptedAt: new Date(Date.parse(repairFinished.leadership.lastRepair.finishedAt) + 1).toISOString(), error: "transport failed again" };
  const claim = {
    claimantThreadId: "worker-1",
    claimantRole: "worker",
    reason: "two-explicit-delivery-failures",
    oldForemanThreadId: "foreman-old",
    oldEpoch: 1,
    repairId,
    failedReportId: "G01-A1",
    failedDeliveries: [firstFailure, secondFailure]
  };
  const claimed = run(stateStore, ["claim-takeover", runId, "2", JSON.stringify(claim)]);
  assert.equal(claimed.leadership.status, "electing");
  assert.equal(claimed.leadership.epoch, 2);
  assert.equal(claimed.foremanThreadId, null);

  run(stateStore, ["claim-takeover", runId, "2", JSON.stringify(claim)], 1);
  const takeoverId = claimed.leadership.takeover.takeoverId;
  const registered = run(stateStore, ["register-candidate", runId, "3", takeoverId, JSON.stringify({ threadId: "foreman-new", hostId: "host-1" })]);
  assert.equal(registered.leadership.takeover.candidateThreadId, "foreman-new");

  const adopted = run(stateStore, ["adopt-takeover", runId, "4", takeoverId, "foreman-new"]);
  assert.equal(adopted.leadership.status, "active");
  assert.equal(adopted.foremanThreadId, "foreman-new");
  assert.deepEqual(adopted.leadership.previousForemanThreadIds, ["foreman-old"]);

  const proposed = { ...adopted, expectedNext: { actorThreadId: "foreman-new", type: "STAGE_DECISION", stageId: "G01", attempt: 1, since: "2026-08-02T00:03:00.000Z" } };
  run(stateStore, ["write", runId, "5", "foreman-old", "1", JSON.stringify(proposed)], 1);
  const written = run(stateStore, ["write", runId, "5", "foreman-new", "2", JSON.stringify(proposed)]);
  assert.equal(written.revision, 6);
  assert.equal(state().expectedNext.type, "STAGE_DECISION");

  const resumeRunId = "failover-resume";
  const resumeInitial = {
    ...initial,
    runId: resumeRunId,
    active: { G02: { threadId: "worker-2", attempt: 1, status: "assigned" } },
    expectedNext: { actorThreadId: "worker-2", type: "STAGE_REPORT_READY", stageId: "G02", attempt: 1, since: "2026-08-02T00:00:00.000Z" }
  };
  run(stateStore, ["init", resumeRunId, JSON.stringify(resumeInitial)]);
  const resumeFirstFailure = { ...firstFailure, eventId: "resume-send-1" };
  const resumeRepairRequest = { ...repairRequest, claimantThreadId: "worker-2", triggerFailure: resumeFirstFailure };
  const resumeRepairClaimed = run(stateStore, ["begin-repair", resumeRunId, "0", JSON.stringify(resumeRepairRequest)]);
  const resumeRepairId = resumeRepairClaimed.leadership.repair.repairId;
  const resumeRepairFinished = run(stateStore, ["finish-repair", resumeRunId, "1", resumeRepairId, JSON.stringify({ actorThreadId: "worker-2", status: "completed", archiveSucceeded: true, unarchiveSucceeded: true })]);
  const resumeSecondFailure = { ...secondFailure, eventId: "resume-send-2", attemptedAt: new Date(Date.parse(resumeRepairFinished.leadership.lastRepair.finishedAt) + 1).toISOString() };
  const resumeClaim = {
    ...claim,
    claimantThreadId: "worker-2",
    repairId: resumeRepairId,
    failedReportId: "G02-A1",
    failedDeliveries: [resumeFirstFailure, resumeSecondFailure]
  };
  const resumeClaimed = run(stateStore, ["claim-takeover", resumeRunId, "2", JSON.stringify(resumeClaim)]);
  const resumeTakeoverId = resumeClaimed.leadership.takeover.takeoverId;
  const failed = run(stateStore, ["record-takeover-failure", resumeRunId, "3", resumeTakeoverId, JSON.stringify({ phase: "create", error: "thread creation unavailable" })]);
  assert.equal(failed.leadership.takeover.status, "needs_recovery");
  const resumed = run(stateStore, ["resume-takeover", resumeRunId, "4", resumeTakeoverId, JSON.stringify({ claimantThreadId: "monitor-1", claimantRole: "monitor" })]);
  assert.equal(resumed.leadership.epoch, 2);
  assert.equal(resumed.leadership.takeover.claimantRole, "monitor");
  assert.equal(resumed.leadership.takeover.lastFailure, null);

  const legacyRunId = "legacy-migration";
  const legacy = {
    ...initial,
    schemaVersion: 1,
    runId: legacyRunId
  };
  delete legacy.leadership;
  delete legacy.project;
  delete legacy.decisionLedger;
  delete legacy.reportDecisions;
  const migrated = run(stateStore, ["init", legacyRunId, JSON.stringify(legacy)]);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.leadership.epoch, 1);
  assert.equal(migrated.leadership.activeForemanThreadId, "foreman-old");
  assert.deepEqual(migrated.workerProfile, { model: "gpt-5.6-luna", thinking: "max" });

  process.stdout.write("Failover smoke test passed.\n");
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
