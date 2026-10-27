/**
 * Command-line surface for the authoritative factory backend.
 *
 * `runCli` keeps the process wiring testable: the entrypoint file supplies
 * `process` values and the real server starter, tests supply fakes. The bearer
 * token is passed to the server only and is never printed.
 */

import process from 'node:process';

import {
  HOST_ENV_VAR,
  MIN_TOKEN_LENGTH,
  PORT_ENV_VAR,
  TOKEN_ENV_VAR,
  readFactoryConfig,
} from './config.ts';
import type { FactoryConfig } from './config.ts';
import { createFactoryServer } from './http.ts';
import type { FactoryServerAddress } from './http.ts';

export const USAGE = `GF authoritative factory backend - development slice

Usage:
  bun backend/main.ts            Start the HTTP server
  bun backend/main.ts --help     Show this help and exit

Environment:
  ${TOKEN_ENV_VAR}  Required. Bearer token shared with clients; at least ${MIN_TOKEN_LENGTH}
                printable characters. It is never logged, committed or baked
                into an image.
  ${HOST_ENV_VAR}       Bind address. Default 127.0.0.1; use 0.0.0.0 inside a
                container so the published port can reach it.
  ${PORT_ENV_VAR}       TCP listen port. Default 8787.

Endpoints (all /v1/ routes require "Authorization: Bearer <${TOKEN_ENV_VAR}>"):
  GET  /health              Liveness and protocol version; no credentials.
  GET  /v1/state            Own-company snapshot, tick and the R1 recipe.
  POST /v1/production       Queue one R1 batch on an owned production line.
  GET  /v1/commands/<id>    Command status: queued, executed or rejected.

The server owns the clock and advances one tick per second. Restarting the
process creates a new in-memory match; nothing is persisted. Docker usage and
the pricing of this development slice are documented in backend/README.md.
`;

export interface StartedServer {
  readonly address: FactoryServerAddress;
  readonly matchId: string;
  close(): Promise<void>;
}

export type ServerStarter = (config: FactoryConfig) => Promise<StartedServer>;

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly startServer?: ServerStarter;
}

export function formatUsage(): string {
  return USAGE;
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function startRealServer(config: FactoryConfig): Promise<StartedServer> {
  const handle = createFactoryServer({
    token: config.token,
    host: config.host,
    port: config.port,
  });
  const address = await handle.listen({ host: config.host, port: config.port });
  return {
    address,
    matchId: handle.match.matchId,
    close: () => handle.close(),
  };
}

/**
 * Run one CLI invocation and return the process exit code.
 * Flags are intentionally limited to `--help`: every runtime value comes from
 * the documented environment variables.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const argv = options.argv.filter((argument) => argument.length > 0);

  if (argv.includes('--help') || argv.includes('-h')) {
    options.stdout(USAGE.trimEnd());
    return 0;
  }

  if (argv.length > 0) {
    options.stderr(`Unknown argument: ${argv[0]}`);
    options.stderr(USAGE.trimEnd());
    return 2;
  }

  const configResult = readFactoryConfig(options.env);
  if (!configResult.ok) {
    for (const error of configResult.errors) {
      options.stderr(error);
    }
    options.stderr(
      `Set ${TOKEN_ENV_VAR}, ${HOST_ENV_VAR} and ${PORT_ENV_VAR} as documented by --help, then run again.`,
    );
    return 1;
  }

  const startServer = options.startServer ?? startRealServer;
  const started = await startServer(configResult.config);
  options.stdout(
    `factory backend listening on http://${formatHost(started.address.host)}:${started.address.port} (match ${started.matchId}, protocol v1)`,
  );
  return 0;
}

/** Process-level entry used by `bun backend/main.ts`. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const exitCode = await runCli({
    argv,
    env,
    stdout: (line: string) => process.stdout.write(`${line}\n`),
    stderr: (line: string) => process.stderr.write(`${line}\n`),
  });
  return exitCode;
}
