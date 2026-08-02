#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [command, runId, reportId, jsonArg] = process.argv.slice(2);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function reportFailure(error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

function requireId(value, label) {
  if (!idPattern.test(value ?? "")) fail(`${label} must use 1-128 letters, digits, dot, underscore, or hyphen`);
}

function outboxRoot() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "loop-development", "runs", runId, "outbox");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateReport(value, expectedReportId) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["report must be an object"];
  if (value.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (value.runId !== runId) errors.push("runId does not match the command argument");
  if (value.reportId !== expectedReportId) errors.push("reportId does not match the command argument");
  if (!nonEmptyString(value.eventId)) errors.push("eventId is required");
  if (!nonEmptyString(value.stageId)) errors.push("stageId is required");
  if (!Number.isInteger(value.attempt) || value.attempt < 1) errors.push("attempt must be a positive integer");
  if (!nonEmptyString(value.sourceThreadId)) errors.push("sourceThreadId is required");
  if (!nonEmptyString(value.targetForemanThreadIdAtCreation)) errors.push("targetForemanThreadIdAtCreation is required");
  if (!Number.isInteger(value.foremanEpochAtCreation) || value.foremanEpochAtCreation < 1) errors.push("foremanEpochAtCreation must be a positive integer");
  if (!value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)) errors.push("evidence must be an object");
  if (!nonEmptyString(value.createdAt)) errors.push("createdAt is required");
  return errors;
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
}

function equalJson(left, right) {
  return JSON.stringify(sortDeep(left)) === JSON.stringify(sortDeep(right));
}

async function parseJson(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`invalid report JSON: ${error.message}`);
  }
}

async function readReport(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  requireId(runId, "runId");
  const root = outboxRoot();

  if (command === "path") {
    if (reportId) requireId(reportId, "reportId");
    process.stdout.write(`${reportId ? path.join(root, `${reportId}.json`) : root}\n`);
    return;
  }

  if (command === "list") {
    const names = await fs.readdir(root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const reports = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const value = await readReport(path.join(root, name));
      if (!value) continue;
      const expectedReportId = name.slice(0, -5);
      const errors = validateReport(value, expectedReportId);
      if (errors.length) fail(`invalid stored report ${name}: ${errors.join("; ")}`);
      reports.push(value);
    }
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    return;
  }

  requireId(reportId, "reportId");
  const file = path.join(root, `${reportId}.json`);

  if (command === "show") {
    const report = await readReport(file);
    if (!report) fail(`report not found: ${file}`, 2);
    const errors = validateReport(report, reportId);
    if (errors.length) fail(`invalid stored report: ${errors.join("; ")}`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (command !== "enqueue") fail("usage: report-outbox.mjs <path|list|show|enqueue> <runId> [reportId] [reportJson]");
  if (!jsonArg) fail("report JSON is required");

  const proposed = await parseJson(jsonArg);
  proposed.schemaVersion = 1;
  proposed.runId = runId;
  proposed.reportId = reportId;
  proposed.createdAt = proposed.createdAt ?? new Date().toISOString();
  const errors = validateReport(proposed, reportId);
  if (errors.length) fail(`invalid proposed report: ${errors.join("; ")}`);

  await fs.mkdir(root, { recursive: true });
  try {
    await fs.writeFile(file, `${JSON.stringify(proposed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify(proposed, null, 2)}\n`);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = await readReport(file);
  const comparable = { ...proposed, createdAt: existing?.createdAt ?? proposed.createdAt };
  if (!existing || !equalJson(existing, comparable)) fail(`immutable report conflict: ${file}`);
  process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
}

main().catch(reportFailure);
