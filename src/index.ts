#!/usr/bin/env node
/**
 * bitbucket-mcp — CLI entry point.
 *
 * Default behavior (no args) starts the MCP stdio server. Named
 * subcommands are user-facing setup and diagnostic tools; see
 * `bitbucket-mcp help`.
 */

import { runHelp, runLogin, runLogout, runWhoami, reportError } from "./cli/commands.js";
import { startStdioServer } from "./server.js";

async function main(): Promise<number> {
  const [, , subcommand, ...rest] = process.argv;

  try {
    switch (subcommand) {
      case undefined:
        await startStdioServer();
        return 0;
      case "login":
        return await runLogin();
      case "logout":
        return await runLogout();
      case "whoami":
        return await runWhoami();
      case "help":
      case "--help":
      case "-h":
        return await runHelp();
      default:
        process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
        await runHelp();
        return 64;
    }
  } catch (err) {
    return reportError(err);
  } finally {
    // Reserved for future use (e.g. flushing buffered logs).
    void rest;
  }
}

main().then((code) => process.exit(code));
