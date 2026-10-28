/**
 * Entrypoint: `bun backend/main.ts`.
 *
 * Configuration comes only from the documented environment variables; see
 * `--help` or backend/README.md.
 */

import process from 'node:process';

import { main } from './src/main.ts';

const exitCode = await main(process.argv.slice(2), process.env);
if (exitCode !== 0) {
  process.exit(exitCode);
}
