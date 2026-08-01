#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [command, runId, revisionArg, jsonArg] = process.argv.slice(2);
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runStatuses = new Set(["initializing", "running", "awaiting_user", "completed", "aborted"]);

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function reportFailure(error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

function stateRoot() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "loop-development", "runs");
}

function requireRunId(value) {
  if (!runIdPattern.test(value ?? "")) fail("runId must use 1-128 letters, digits, dot, underscore, or hyphen");
}

function validateState(value, expectedRunId) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["state must be an object"];
  if (value.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (value.runId !== expectedRunId) errors.push("runId does not match the command argument");
  if (!runStatuses.has(value.status)) errors.push("status is invalid");
  if (typeof value.foremanThreadId !== "string" || !value.foremanThreadId) errors.push("foremanThreadId is required");
  if (value.status !== "initializing" && (typeof value.monitorThreadId !== "string" || !value.monitorThreadId)) errors.push("monitorThreadId is required after initialization");
  if (value.status !== "initializing" && (typeof value.automationId !== "string" || !value.automationId)) errors.push("automationId is required after initialization");
  if (!Array.isArray(value.auxiliaryAutomationIds) || value.auxiliaryAutomationIds.some((item) => typeof item !== "string" || !item)) errors.push("auxiliaryAutomationIds must be a string array");
  if (value.automationShutdown !== null && (typeof value.automationShutdown !== "object" || Array.isArray(value.automationShutdown))) errors.push("automationShutdown must be an object or null");
  if (!Array.isArray(value.planFiles) || value.planFiles.some((item) => typeof item !== "string" || !item)) errors.push("planFiles must be a string array");
  if (!Array.isArray(value.accepted) || value.accepted.some((item) => typeof item !== "string" || !item)) errors.push("accepted must be a string array");
  for (const key of ["active", "returned", "blocked"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) errors.push(`${key} must be an object`);
  }
  if (!Array.isArray(value.ready) || value.ready.some((item) => typeof item !== "string" || !item)) errors.push("ready must be a string array");
  if (value.expectedNext !== null && (typeof value.expectedNext !== "object" || Array.isArray(value.expectedNext))) errors.push("expectedNext must be an object or null");
  return errors;
}

async function parseState(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`invalid state JSON: ${error.message}`);
  }
}

async function readCurrent(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function replaceAtomically(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
requireRunId(runId);
const file = path.join(stateRoot(), `${runId}.json`);

if (command === "path") {
  process.stdout.write(`${file}\n`);
  process.exit(0);
}

if (command === "show") {
  const current = await readCurrent(file);
  if (!current) fail(`state not found: ${file}`, 2);
  const errors = validateState(current, runId);
  if (errors.length) fail(`invalid stored state: ${errors.join("; ")}`);
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  process.exit(0);
}

if (command !== "init" && command !== "write") fail("usage: state-store.mjs <path|show|init|write> <runId> [expectedRevision] [stateJson]");

const source = command === "init" ? revisionArg : jsonArg;
if (!source) fail("full state JSON is required");
const proposed = await parseState(source);
const errors = validateState(proposed, runId);
if (errors.length) fail(`invalid proposed state: ${errors.join("; ")}`);

const lock = `${file}.lock`;
await fs.mkdir(path.dirname(file), { recursive: true });
let lockHandle;
try {
  lockHandle = await fs.open(lock, "wx");
} catch (error) {
  if (error.code === "EEXIST") fail(`state is locked: ${lock}`);
  throw error;
}

try {
  const current = await readCurrent(file);
  if (command === "init" && current) fail(`state already exists: ${file}`);
  if (command === "write") {
    if (!current) fail(`state not found: ${file}`);
    const expectedRevision = Number(revisionArg);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail("expectedRevision must be a non-negative integer");
    if (current.revision !== expectedRevision) fail(`revision conflict: expected ${expectedRevision}, found ${current.revision}`);
  }

  const next = {
    ...proposed,
    schemaVersion: 1,
    runId,
    revision: current ? current.revision + 1 : 0,
    updatedAt: new Date().toISOString()
  };
  await replaceAtomically(file, next);
  process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
} finally {
  await lockHandle.close();
  await fs.rm(lock, { force: true });
}
}

main().catch(reportFailure);
