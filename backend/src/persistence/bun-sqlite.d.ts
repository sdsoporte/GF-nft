/**
 * Minimal ambient types for the `bun:sqlite` built-in module.
 *
 * The project does not install `@types/bun` and this feature must not add a
 * dependency (A1), so the small surface actually used by the persistence layer
 * is declared here. Keep this file in sync with the calls made by
 * `database.ts` / repository modules; it is intentionally not a full port of
 * Bun's declarations.
 */

declare module 'bun:sqlite' {
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readonly readwrite?: boolean;
    readonly strict?: boolean;
    readonly safeIntegers?: boolean;
  }

  export interface Statement<Row = unknown> {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | null;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    values(...params: unknown[]): unknown[][];
    finalize(): void;
  }

  export interface Database {
    query<Row = unknown>(sql: string): Statement<Row>;
    prepare<Row = unknown>(sql: string): Statement<Row>;
    exec(sql: string): void;
    run(sql: string, ...params: unknown[]): void;
    transaction<T>(work: (...args: never[]) => T): (...args: never[]) => T;
    close(throwOnError?: boolean): void;
    readonly inTransaction: boolean;
    readonly filename: string;
  }

  export const Database: {
    new (path?: string, options?: DatabaseOptions): Database;
  };
}
