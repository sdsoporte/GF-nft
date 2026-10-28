import type { Migration } from '../migrations.ts';

/** Legacy results remain NULL: guessing ownership could disclose another tenant. */
export const COMMAND_RESULT_TENANT_MIGRATION: Migration = {
  version: 4,
  name: 'command_result_tenant',
  sql: 'ALTER TABLE match_command_results ADD COLUMN company_id TEXT;',
};
