#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateStore = path.join(root, "loop-development", "scripts", "state-store.mjs");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "loop-development-race-"));
const env = { ...process.env, CODEX_HOME: codexHome };
const runId = "failover-race";

function runSync(args) {
  const result = spawnSync(process.execPath, [stateStore, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `command failed: ${args.join(" ")}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [stateStore, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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
    active: {
      G01: { threadId: "worker-a", attempt: 1, status: "assigned" },
      G02: { threadId: "worker-b", attempt: 1, status: "assigned" }
    },
    returned: {},
    blocked: {},
    ready: [],
    expectedNext: null,
    automationShutdown: null
  };
  runSync(["init", runId, JSON.stringify(initial)]);

  const firstFailureAt = new Date().toISOString();
  const repairRequests = ["worker-a", "worker-b"].map((worker, index) => ({
    claimantThreadId: worker,
    claimantRole: "worker",
    targetForemanThreadId: "foreman-old",
    foremanEpoch: 1,
    triggerFailure: {
      eventId: `repair-race-${index + 1}`,
      targetThreadId: "foreman-old",
      foremanEpoch: 1,
      attemptedAt: firstFailureAt,
      error: "transport failed"
    }
  }));
  const repairResults = await Promise.all(repairRequests.map((request) => runAsync(["begin-repair", runId, "0", JSON.stringify(request)])));
  assert.equal(repairResults.filter((result) => result.status === 0).length, 1, "exactly one concurrent repair claimant must win");

  const repairing = runSync(["show", runId]);
  const repair = repairing.leadership.repair;
  assert.ok(repair);
  const finished = runSync(["finish-repair", runId, "1", repair.repairId, JSON.stringify({ actorThreadId: repair.claimantThreadId, status: "completed", archiveSucceeded: true, unarchiveSucceeded: true })]);

  const secondFailure = {
    eventId: "post-repair-failure",
    targetThreadId: "foreman-old",
    foremanEpoch: 1,
    attemptedAt: new Date(Date.parse(finished.leadership.lastRepair.finishedAt) + 1).toISOString(),
    error: "transport still failed"
  };
  const takeoverClaims = ["worker-a", "worker-b"].map((worker) => ({
    claimantThreadId: worker,
    claimantRole: "worker",
    reason: "two-explicit-delivery-failures",
    oldForemanThreadId: "foreman-old",
    oldEpoch: 1,
    repairId: repair.repairId,
    failedReportId: worker === "worker-a" ? "G01-A1" : "G02-A1",
    failedDeliveries: [repair.triggerFailure, secondFailure]
  }));
  const takeoverResults = await Promise.all(takeoverClaims.map((claim) => runAsync(["claim-takeover", runId, "2", JSON.stringify(claim)])));
  assert.equal(takeoverResults.filter((result) => result.status === 0).length, 1, "exactly one concurrent takeover claimant must win");

  const elected = runSync(["show", runId]);
  assert.equal(elected.leadership.status, "electing");
  assert.equal(elected.leadership.epoch, 2);
  assert.equal(elected.foremanThreadId, null);
  process.stdout.write("Failover concurrency test passed.\n");
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
