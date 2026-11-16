import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitStatusState } from "../src/bitbucket/types.js";
import { summarizeStatuses } from "../src/tools/list-pull-request-statuses.js";

const of = (...states: CommitStatusState[]) => states.map((state) => ({ state }));

test("summarizeStatuses: no statuses rolls up to NONE", () => {
  const summary = summarizeStatuses([]);
  assert.equal(summary.overall_state, "NONE");
  assert.deepEqual(summary.counts, { SUCCESSFUL: 0, FAILED: 0, INPROGRESS: 0, STOPPED: 0 });
});

test("summarizeStatuses: all successful rolls up to SUCCESSFUL", () => {
  const summary = summarizeStatuses(of("SUCCESSFUL", "SUCCESSFUL"));
  assert.equal(summary.overall_state, "SUCCESSFUL");
  assert.equal(summary.counts.SUCCESSFUL, 2);
});

test("summarizeStatuses: a single failure outranks everything else", () => {
  const summary = summarizeStatuses(of("SUCCESSFUL", "INPROGRESS", "STOPPED", "FAILED"));
  assert.equal(summary.overall_state, "FAILED");
  assert.deepEqual(summary.counts, { SUCCESSFUL: 1, FAILED: 1, INPROGRESS: 1, STOPPED: 1 });
});

test("summarizeStatuses: stopped outranks in-progress, which outranks successful", () => {
  assert.equal(summarizeStatuses(of("SUCCESSFUL", "INPROGRESS", "STOPPED")).overall_state, "STOPPED");
  assert.equal(summarizeStatuses(of("SUCCESSFUL", "INPROGRESS")).overall_state, "INPROGRESS");
});

test("summarizeStatuses: unknown states are not counted as green", () => {
  const summary = summarizeStatuses([{ state: "PENDING" as CommitStatusState }]);
  assert.equal(summary.overall_state, "NONE");
  assert.deepEqual(summary.counts, { SUCCESSFUL: 0, FAILED: 0, INPROGRESS: 0, STOPPED: 0 });
});
