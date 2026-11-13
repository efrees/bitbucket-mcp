/**
 * Tool: `bitbucket_get_pipeline_failures`
 *
 * Answers "why did this build fail?" for a Bitbucket Pipelines run. For
 * each failed step it returns:
 *   - the failing test cases with their failure output, when the step
 *     published test reports (JUnit XML picked up by Pipelines), and
 *   - the sanitized tail of the step log, which is where compiler errors
 *     and non-test failures show up.
 *
 * Only Bitbucket Pipelines is reachable this way. Statuses posted by
 * third-party CI (Jenkins, CircleCI, ...) carry a `url` into that system,
 * which a Bitbucket token cannot read.
 *
 * Everything returned is size-capped: step logs are routinely megabytes,
 * so we ask for the tail with an HTTP Range request rather than
 * downloading the whole file.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectAll } from "../bitbucket/pagination.js";
import type { Pipeline, PipelineStep } from "../bitbucket/types.js";
import { BitbucketApiError } from "../errors.js";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";
import { dropPartialFirstLine, sanitizeLog, tailText } from "./log-text.js";

const DEFAULT_LOG_BYTES = 30 * 1024;
const HARD_MAX_LOG_BYTES = 500 * 1024;
const DEFAULT_MAX_TEST_CASES = 20;
const MAX_FAILED_STEPS = 5;
/** Cap on any single string inside a test failure reason (stack traces can be huge). */
const MAX_REASON_STRING_BYTES = 8 * 1024;

const FAILED_RESULTS = new Set(["FAILED", "ERROR"]);
const FAILED_TEST_STATUSES = new Set(["FAILED", "ERROR"]);

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pipeline: z
    .union([z.number().int().positive(), z.string().min(1)])
    .describe(
      "Pipeline build number (the `pipeline_build_number` from bitbucket_list_pull_request_statuses, " +
        "or the number in the Pipelines URL) or pipeline UUID.",
    ),
  max_log_bytes: z
    .number()
    .int()
    .min(1024)
    .max(HARD_MAX_LOG_BYTES)
    .optional()
    .describe(
      `Bytes of log tail to return per failed step. Default ${DEFAULT_LOG_BYTES}, hard limit ${HARD_MAX_LOG_BYTES}.`,
    ),
  max_test_cases: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      `Maximum failing test cases to detail per failed step (default ${DEFAULT_MAX_TEST_CASES}). 0 skips test reports.`,
    ),
};

export function isFailedStep(step: PipelineStep): boolean {
  return FAILED_RESULTS.has(step.state?.result?.name ?? "");
}

type LooseRecord = Record<string, unknown>;

/** Test-report payloads are not in Bitbucket's published schema, so read them defensively. */
export function isFailedTestCase(testCase: LooseRecord): boolean {
  const status = testCase["status"];
  return typeof status === "string" && FAILED_TEST_STATUSES.has(status.toUpperCase());
}

/** Sanitize and cap every string in an arbitrary JSON value. */
export function sanitizeDeep(value: unknown, maxStringBytes: number): unknown {
  if (typeof value === "string") {
    const clean = sanitizeLog(value);
    const buf = Buffer.from(clean, "utf8");
    if (buf.length <= maxStringBytes) return clean;
    // Head, not tail: the assertion message and top stack frames come first.
    return `${buf.subarray(0, maxStringBytes).toString("utf8")}\n[TRUNCATED — ${buf.length} bytes total]`;
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, maxStringBytes));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "links")
        .map(([key, v]) => [key, sanitizeDeep(v, maxStringBytes)]),
    );
  }
  return value;
}

function isStatus(err: unknown, status: number): boolean {
  return err instanceof BitbucketApiError && err.status === status;
}

interface LogTail {
  readonly text: string;
  readonly truncated: boolean;
  /** Full size of the log in bytes, when the server told us. */
  readonly total_bytes: number | null;
}

/**
 * Fetch the last `maxBytes` of a step log. Returns null when the step
 * has no log (e.g. it errored before the build container started).
 */
async function fetchLogTail(ctx: ToolContext, path: string, maxBytes: number): Promise<LogTail | null> {
  const accept = "application/octet-stream";
  let response: Response;
  try {
    response = await ctx.http.request(path, { accept, headers: { Range: `bytes=-${maxBytes}` } });
  } catch (err) {
    if (isStatus(err, 404)) return null;
    // 416: the log is empty or the backing store won't serve this range.
    // Fall back to the whole file and tail it locally.
    if (!isStatus(err, 416)) throw err;
    try {
      response = await ctx.http.request(path, { accept });
    } catch (retryErr) {
      if (isStatus(retryErr, 404)) return null;
      throw retryErr;
    }
  }

  const body = await response.text();
  if (response.status === 206) {
    // Content-Range: bytes <start>-<end>/<total>
    const match = /bytes\s+(\d+)-\d+\/(\d+|\*)/.exec(response.headers.get("Content-Range") ?? "");
    const start = match ? Number(match[1]) : null;
    const total = match && match[2] !== "*" ? Number(match[2]) : null;
    const partial = start !== 0;
    return {
      text: sanitizeLog(partial ? dropPartialFirstLine(body) : body),
      truncated: partial,
      total_bytes: total,
    };
  }
  // 200: the server ignored the Range header and sent everything.
  const tail = tailText(body, maxBytes);
  return {
    text: sanitizeLog(tail.text),
    truncated: tail.truncated,
    total_bytes: Buffer.byteLength(body, "utf8"),
  };
}

async function fetchFailedTests(
  ctx: ToolContext,
  stepPath: string,
  maxTestCases: number,
): Promise<{ failed_test_count: number; failed_tests: unknown[] } | null> {
  const casesPath = `${stepPath}/test_reports/test_cases`;
  let cases: LooseRecord[];
  try {
    ({ values: cases } = await collectAll<LooseRecord>(
      ctx.http,
      casesPath,
      { pagelen: 100 },
      { maxPages: 10 },
    ));
  } catch (err) {
    // 404 = the step published no test reports.
    if (isStatus(err, 404)) return null;
    throw err;
  }

  const failed = cases.filter(isFailedTestCase);
  const detailed = await Promise.all(
    failed.slice(0, maxTestCases).map(async (testCase) => {
      const uuid = testCase["uuid"];
      let reasons: unknown = null;
      if (typeof uuid === "string") {
        try {
          reasons = await ctx.http.requestJson<unknown>(
            `${casesPath}/${encodePathSegment(uuid)}/test_case_reasons`,
          );
        } catch (err) {
          if (!isStatus(err, 404)) throw err;
        }
      }
      // A paged envelope carries nothing useful beyond its values.
      const values = (reasons as { values?: unknown } | null)?.values;
      return sanitizeDeep(
        { ...testCase, reasons: Array.isArray(values) ? values : reasons },
        MAX_REASON_STRING_BYTES,
      );
    }),
  );
  return { failed_test_count: failed.length, failed_tests: detailed };
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_get_pipeline_failures",
    {
      title: "Get pipeline failures",
      description:
        "Explain why a Bitbucket Pipelines build failed: for each failed step, the failing test cases " +
        "(when the step published test reports) and the sanitized tail of the step log. " +
        "Requires the `pipeline` scope on the OAuth consumer. Bitbucket Pipelines only — " +
        "builds from third-party CI cannot be read.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const maxLogBytes = args.max_log_bytes ?? DEFAULT_LOG_BYTES;
        const maxTestCases = args.max_test_cases ?? DEFAULT_MAX_TEST_CASES;
        const pipelinesPath = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pipelines`;

        // Braces in a UUID must be percent-encoded; encodePathSegment does that.
        const pipeline = await ctx.http.requestJson<Pipeline>(
          `${pipelinesPath}/${encodePathSegment(String(args.pipeline))}`,
        );
        const pipelinePath = `${pipelinesPath}/${encodePathSegment(pipeline.uuid)}`;

        const { values: steps } = await collectAll<PipelineStep>(
          ctx.http,
          `${pipelinePath}/steps`,
          { pagelen: 100 },
        );
        const failedSteps = steps.filter(isFailedStep);

        const details = [];
        for (const step of failedSteps.slice(0, MAX_FAILED_STEPS)) {
          const stepPath = `${pipelinePath}/steps/${encodePathSegment(step.uuid)}`;
          const [tests, log] = await Promise.all([
            maxTestCases > 0 ? fetchFailedTests(ctx, stepPath, maxTestCases) : null,
            fetchLogTail(ctx, `${stepPath}/log`, maxLogBytes),
          ]);
          details.push({
            step_uuid: step.uuid,
            name: step.name ?? null,
            result: step.state?.result?.name ?? null,
            error: step.state?.result?.error?.message ?? null,
            failed_test_count: tests?.failed_test_count ?? null,
            failed_tests: tests?.failed_tests ?? [],
            log_tail: log?.text ?? null,
            log_truncated: log?.truncated ?? false,
            log_total_bytes: log?.total_bytes ?? null,
          });
        }

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          pipeline_uuid: pipeline.uuid,
          build_number: pipeline.build_number,
          state: pipeline.state?.name ?? null,
          result: pipeline.state?.result?.name ?? null,
          // Set when the pipeline failed before any step ran (e.g. invalid YAML).
          error: pipeline.state?.result?.error?.message ?? null,
          step_count: steps.length,
          failed_step_count: failedSteps.length,
          failed_steps_omitted: Math.max(0, failedSteps.length - MAX_FAILED_STEPS),
          failed_steps: details,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
