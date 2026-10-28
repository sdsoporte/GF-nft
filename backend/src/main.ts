/**
 * Command-line surface for the authoritative factory backend.
 *
 * `runCli` keeps the process wiring testable: the entrypoint file supplies
 * `process` values and the real server starter, tests supply fakes. The bearer
 * token is passed to the server only and is never printed.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import {
  HOST_ENV_VAR,
  MIN_TOKEN_LENGTH,
  OWNER_ID_ENV_VAR,
  PORT_ENV_VAR,
  SQLITE_PATH_ENV_VAR,
  TOKEN_ENV_VAR,
  readFactoryConfig,
} from './config.ts';
import type { FactoryConfig } from './config.ts';
import { createFactoryServer } from './http.ts';
import type { FactoryServerAddress } from './http.ts';
import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { createMatchStore, type MatchStore } from '../../src/persistence/matchStore.ts';
import { migrate } from '../../src/persistence/migrations.ts';

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
  ${OWNER_ID_ENV_VAR}   Optional single-owner identity (1-64 ASCII letters, digits,
                underscores or dashes). Empty/unset disables owner/MCP routes.
  ${SQLITE_PATH_ENV_VAR}  Optional SQLite file that stores the match identity, the
                command queue, idempotency keys, acknowledgements and command
                results. Its parent directory is created on boot and the schema
                is migrated before the server listens. Unset keeps the match
                in memory only.

Game endpoints require "Authorization: Bearer <${TOKEN_ENV_VAR}>":
  GET  /health              Liveness and protocol version; no credentials.
  GET  /v1/state            Own-company snapshot, tick and the R1 recipe.
  POST /v1/production       Queue one R1 batch on an owned production line.
  GET  /v1/commands/<id>    Command status: queued, executed or rejected.

Owner endpoints (only when ${OWNER_ID_ENV_VAR} is configured):
  POST   /v1/owner/sessions          Root bearer -> expiring owner session.
  DELETE /v1/owner/sessions/current  Session bearer -> logout.
  GET    /v1/owner/grants            Session bearer -> safe metadata only.
  POST   /v1/owner/grants            Session bearer -> one-time token delivery.
  GET    /v1/owner/grants/<id>       Session bearer -> safe metadata only.
  DELETE /v1/owner/grants/<id>       Session bearer -> immediate revocation.

External MCP transport/catalog remains separate (#9); embedding callers use the
server-owned gateway, whose commands are persisted before acknowledgement.
Migration 5 retires all legacy grants: plan reissuance before any deployment.

The server owns the clock and advances one tick per second. With
${SQLITE_PATH_ENV_VAR} set, acknowledged requests and command results survive a
restart with identical results; without it, a restart creates a new in-memory
match. Docker usage and the pricing of this development slice are documented in
backend/README.md.
`;

export interface StartedServer {
  readonly address: FactoryServerAddress;
  readonly matchId: string;
  close(): Promise<void>;
}

/** Booted persistence: the store the server injects plus its close hook. */
export interface MatchPersistence {
  readonly store: MatchStore;
  close(): void;
}

/**
 * Boot one persistent match store (S3/S6): create the parent directory of the
 * configured file, open the database, apply the versioned migrations, and hand
 * back the store the server injects into `FactoryMatch`. Every failure throws,
 * so a bad path stops startup instead of silently disabling persistence.
 */
export function openMatchPersistence(sqlitePath: string): MatchPersistence {
  const resolved = resolve(sqlitePath);
  mkdirSync(dirname(resolved), { recursive: true });
  const database = openDatabase(resolved);
  try {
    migrate(database);
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
  return { store: createMatchStore(database), close: () => closeDatabase(database) };
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
  const persistence =
    config.sqlitePath === undefined ? null : openMatchPersistence(config.sqlitePath);
  const handle = createFactoryServer({
    token: config.token,
    host: config.host,
    port: config.port,
    ...(config.ownerId === undefined ? {} : { ownerId: config.ownerId }),
    ...(persistence === null ? {} : { store: persistence.store }),
  });
  const address = await handle.listen({ host: config.host, port: config.port });
  return {
    address,
    matchId: handle.match.matchId,
    close: async () => {
      await handle.close();
      // The database outlives the HTTP server, so closing it is the last step
      // of a clean shutdown; a process kill simply leaves the committed rows.
      persistence?.close();
    },
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
