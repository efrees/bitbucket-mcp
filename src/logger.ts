/**
 * Stderr-only structured logger.
 *
 * stdout is reserved for MCP protocol framing when running as an MCP server,
 * so every log line must go to stderr. This module is the single entry point
 * for logging — no `console.log` elsewhere in the codebase.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentThreshold(): number {
  const raw = process.env["BITBUCKET_MCP_LOG_LEVEL"]?.toLowerCase();
  if (raw && raw in LEVEL_ORDER) {
    return LEVEL_ORDER[raw as LogLevel];
  }
  return LEVEL_ORDER.info;
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < currentThreshold()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {}),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
