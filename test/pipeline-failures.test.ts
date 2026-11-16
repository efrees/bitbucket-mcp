import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFailedStep,
  isFailedTestCase,
  sanitizeDeep,
} from "../src/tools/get-pipeline-failures.js";
import { pipelineBuildNumber } from "../src/tools/list-pull-request-statuses.js";
import { REDACTED, redactSecrets, sanitizeLog, stripAnsi, tailText } from "../src/tools/log-text.js";

test("stripAnsi removes colour codes and OSC sequences", () => {
  assert.equal(stripAnsi("\u001b[31mFAIL\u001b[0m src/a.test.ts"), "FAIL src/a.test.ts");
  assert.equal(stripAnsi("\u001b]0;title\u0007done"), "done");
});

test("redactSecrets masks credentials but keeps the surrounding context", () => {
  assert.equal(redactSecrets("Authorization: Bearer abc123def456ghi"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(
    redactSecrets("cloning https://bot:hunter2secret@bitbucket.org/ws/repo.git"),
    `cloning https://bot:${REDACTED}@bitbucket.org/ws/repo.git`,
  );
  assert.equal(redactSecrets("DB_PASSWORD=sup3rs3cret"), `DB_PASSWORD=${REDACTED}`);
  assert.equal(redactSecrets('"client_secret": "abcd1234"'), `"client_secret": "${REDACTED}"`);
  assert.equal(redactSecrets("key AKIAIOSFODNN7EXAMPLE used"), `key ${REDACTED} used`);
  assert.equal(
    redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nnext"),
    `${REDACTED}\nnext`,
  );
});

test("redactSecrets leaves ordinary failure output alone", () => {
  const line = "AssertionError: expected 3 to equal 4 at tokenizer.test.ts:12:5";
  assert.equal(redactSecrets(line), line);
});

test("sanitizeLog normalizes line endings", () => {
  assert.equal(sanitizeLog("a\r\nb\rc"), "a\nb\nc");
});

test("tailText returns short text untouched", () => {
  assert.deepEqual(tailText("one\ntwo\n", 100), { text: "one\ntwo\n", truncated: false });
});

test("tailText keeps the end and starts on a line boundary", () => {
  const result = tailText("first line\nsecond line\nthird line\n", 20);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "third line\n");
});

test("isFailedStep matches FAILED and ERROR results only", () => {
  const step = (result?: string) => ({
    uuid: "{u}",
    state: { name: "COMPLETED", ...(result ? { result: { name: result } } : {}) },
  });
  assert.equal(isFailedStep(step("FAILED")), true);
  assert.equal(isFailedStep(step("ERROR")), true);
  assert.equal(isFailedStep(step("SUCCESSFUL")), false);
  assert.equal(isFailedStep(step("NOT_RUN")), false);
  assert.equal(isFailedStep(step()), false);
});

test("isFailedTestCase is case-insensitive and ignores passing or malformed cases", () => {
  assert.equal(isFailedTestCase({ status: "FAILED" }), true);
  assert.equal(isFailedTestCase({ status: "error" }), true);
  assert.equal(isFailedTestCase({ status: "SUCCESSFUL" }), false);
  assert.equal(isFailedTestCase({ status: "SKIPPED" }), false);
  assert.equal(isFailedTestCase({}), false);
});

test("sanitizeDeep sanitizes nested strings, drops links, and caps length", () => {
  const out = sanitizeDeep(
    {
      name: "adds",
      links: { self: { href: "https://example.test" } },
      reasons: [{ message: "\u001b[31mtoken=abcd1234\u001b[0m", output: "x".repeat(50) }],
      duration: 3,
    },
    20,
  ) as { links?: unknown; duration: number; reasons: { message: string; output: string }[] };
  assert.equal(out.links, undefined);
  assert.equal(out.duration, 3);
  assert.equal(out.reasons[0]?.message, `token=${REDACTED}`);
  assert.match(out.reasons[0]?.output ?? "", /^x{20}\n\[TRUNCATED — 50 bytes total\]$/);
});

test("pipelineBuildNumber reads both Pipelines result URL forms", () => {
  assert.equal(pipelineBuildNumber("https://bitbucket.org/ws/repo/pipelines/results/42"), 42);
  assert.equal(
    pipelineBuildNumber("https://bitbucket.org/ws/repo/addon/pipelines/home#!/results/7"),
    7,
  );
  assert.equal(pipelineBuildNumber("https://jenkins.example.test/job/x/42/"), null);
  assert.equal(pipelineBuildNumber(undefined), null);
});
