/**
 * S6 + S8 (issue #10): P0 regression matrix for issues #1–#7.
 *
 * This is a STRUCTURAL test. It never initialises the engine, the MCP gateway
 * or the simulation: it reads the source of the files that own each P0
 * regression and asserts that the pinned title is still there with the expected
 * coverage kind.
 *
 * - `green`   — a local fix is asserted by its owning file (remote closure is separate).
 * - `pending` — the issue is still open (assumption A1 of
 *               `odd/tasks/qa-test-suite.md`): the entry must stay skipped/todo
 *               and must name its issue, so coverage is never claimed green
 *               while the defect is unfixed.
 *
 * The matrix fails only when:
 *
 * 1. a pinned title disappears or is renamed out of its fragment,
 * 2. a `pending` entry loses its skip/todo marker (someone asserted it early),
 * 3. a `green` entry gains a skip/todo marker (a fixed regression got muted),
 * 4. a P0 issue loses every entry, or the README matrix drifts from this table.
 *
 * It cannot fail because of engine runtime behaviour, wall-clock, seed or
 * randomness. Everything it needs is on disk.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file so the cwd never matters. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const README_FILE = 'backend/tests/regressions/README.md';

type CoverageKind = 'green' | 'pending';

interface MatrixEntry {
  /** GitHub issue number, 1–7. */
  readonly issue: number;
  /** Repository-relative path of the file that owns the regression test. */
  readonly file: string;
  /** Distinctive substring of the pinned test title. */
  readonly titleFragment: string;
  readonly kind: CoverageKind;
  /** Why this entry is green or pending today. */
  readonly note: string;
}

/**
 * Issue state observed read-only (`gh issue view <n>`) when this matrix was
 * written: #1 and #6 are closed; #2, #3, #4, #5 and #7 are open P0 defects.
 *
 * When an issue closes: assert the owning test first (delete its skip marker),
 * then flip the entry to `green` here and in `MATRIX`, then update the README.
 * Never the other way around — that is green-by-claim.
 */
const EXPECTED_KIND: Readonly<Record<number, CoverageKind>> = {
  1: 'green',
  2: 'green',
  3: 'pending',
  4: 'pending',
  5: 'pending',
  6: 'green',
  7: 'pending',
};

const P0_ISSUES = [1, 2, 3, 4, 5, 6, 7] as const;

const MATRIX: readonly MatrixEntry[] = [
  // ------------------------------------------------------------------ issue #1
  {
    issue: 1,
    file: 'backend/tests/engine-material-shortage.test.ts',
    titleFragment: 'resuming after a material shortage never credits another batch',
    kind: 'green',
    note: 'issue #1 closed: RESUME_PRODUCTION_LINE no longer replays a batch whose inputs were never consumed',
  },
  {
    issue: 1,
    file: 'backend/tests/engine-material-shortage.test.ts',
    titleFragment: 'completing the only affordable batch pauses the line with exactly one credited batch',
    kind: 'green',
    note: 'issue #1 closed: the last affordable batch is credited exactly once and the line pauses',
  },

  // ------------------------------------------------------------------ issue #2
  {
    issue: 2,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'get_factory_overview rejects a company_id that is not the grant company',
    kind: 'green',
    note: 'issue #2 locally fixed: private reads and durable history are bound to the authorized tenant',
  },
  {
    issue: 2,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'get_inventory rejects a company_id that is not the grant company',
    kind: 'green',
    note: 'issue #2 locally fixed: private reads and durable history are bound to the authorized tenant',
  },
  {
    issue: 2,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'get_production_lines rejects a company_id that is not the grant company',
    kind: 'green',
    note: 'issue #2 locally fixed: private reads and durable history are bound to the authorized tenant',
  },
  {
    issue: 2,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'get_contracts rejects a company_id that is not the grant company',
    kind: 'green',
    note: 'issue #2 locally fixed: private reads and durable history are bound to the authorized tenant',
  },
  {
    issue: 2,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'get_action_history is scoped to the grant company',
    kind: 'green',
    note: 'issue #2 locally fixed: private reads and durable history are bound to the authorized tenant',
  },

  // ------------------------------------------------------------------ issue #3
  {
    issue: 3,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'drafts are not published to the market before an explicit publish step',
    kind: 'pending',
    note: 'issue #3 open: draft_supply_offer creates a PENDING market contract immediately, with no publish step',
  },

  // ------------------------------------------------------------------ issue #4
  {
    issue: 4,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 'an offer targeted at another buyer cannot be accepted by a third company',
    kind: 'pending',
    note: 'issue #4 open: target_buyer_id is not validated on acceptance through the MCP path',
  },
  {
    issue: 4,
    file: 'backend/tests/engine/contracts-lifecycle.test.ts',
    titleFragment: 'a targeted offer cannot be accepted by a non-targeted company',
    kind: 'pending',
    note: 'issue #4 open: ACCEPT_SUPPLY_OFFER overwrites buyerCompanyId without validating targetBuyerId',
  },
  {
    issue: 4,
    file: 'backend/tests/engine/contracts-lifecycle.test.ts',
    titleFragment: 'a seller cannot accept its own offer',
    kind: 'pending',
    note: 'issue #4 open: self-dealing is not policed, the seller can accept its own offer',
  },

  // ------------------------------------------------------------------ issue #5
  {
    issue: 5,
    file: 'backend/tests/engine/contracts-expiration.test.ts',
    titleFragment: 'a partial default pays the seller for the units it already delivered',
    kind: 'pending',
    note: 'issue #5 open: default settlement never pays the seller for the units already delivered',
  },
  {
    issue: 5,
    file: 'backend/tests/engine/contracts-expiration.test.ts',
    titleFragment: 'a partial default conserves total credits between both companies',
    kind: 'pending',
    note: 'issue #5 open: credit conservation breaks on partial delivery plus settlement',
  },
  {
    issue: 5,
    file: 'backend/tests/property/credits.test.ts',
    titleFragment: 'partial-delivery default pays the seller for delivered units and conserves total credits',
    kind: 'pending',
    note: 'issue #5 open: `test.todo` for the seeded credit ledger, flipped to an asserted test with the fix',
  },

  // ------------------------------------------------------------------ issue #6
  {
    issue: 6,
    file: 'backend/tests/commands.test.ts',
    titleFragment: 'one R1 batch consumes raw ore and produces ingots on server ticks',
    kind: 'green',
    note: 'issue #6 closed: the batch runs on the backend-owned clock, not in React',
  },
  {
    issue: 6,
    file: 'backend/tests/http-boundary.test.ts',
    titleFragment: 'the server-owned clock advances the match independently of requests',
    kind: 'green',
    note: 'issue #6 closed: SimulatorEngine ticks in the backend process, not in the client',
  },
  {
    issue: 6,
    file: 'backend/tests/http-boundary.test.ts',
    titleFragment: 'GET /v1/state exposes only the server-selected company',
    kind: 'green',
    note: 'issue #6 closed: the backend selects the company and projects the state; clients cannot',
  },

  // ------------------------------------------------------------------ issue #7
  {
    issue: 7,
    file: 'backend/tests/mcp/isolation.test.ts',
    titleFragment: 're-registering a grant invalidates its previous token',
    kind: 'pending',
    note: 'issue #7 open: fixed-token issuance, registerGrant keeps the stale token mapping alive',
  },
];

interface Declaration {
  /** 1-based line number of the declaration start. */
  readonly lineNumber: number;
  /** Declaration start plus the option lines that precede the callback. */
  readonly header: string;
  /** True when the declaration carries a `skip:` option or is a `test.todo`. */
  readonly pending: boolean;
}

const DECLARATION_START = /^\s*(?:test|it)(?:\.todo)?\s*\(/;
const CALLBACK_START = /=>|(?:^|[^.\w])function\b/;
const PENDING_MARKER = /skip\s*:|\.todo\s*\(/;
/** End of a declaration that has no callback, e.g. a multi-line `test.todo(...)` title. */
const STATEMENT_END = /\);\s*$/;

const sourceByFile = new Map<string, string>();
const declarationsByFile = new Map<string, readonly Declaration[]>();

function sourceOf(file: string): string {
  const cached = sourceByFile.get(file);
  if (cached !== undefined) return cached;

  const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  sourceByFile.set(file, source);
  return source;
}

/**
 * Minimal, dependency-free reader for `test(...)` / `test.todo(...)` /
 * `it(...)` declarations. It captures the title plus any options that sit
 * before the callback, which is exactly where `skip:` lives, and it never
 * walks into the test body.
 */
function declarationsOf(file: string): readonly Declaration[] {
  const cached = declarationsByFile.get(file);
  if (cached) return cached;

  const lines = sourceOf(file).split(/\r?\n/);
  const declarations: Declaration[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!DECLARATION_START.test(lines[index])) continue;

    const header: string[] = [];

    for (let cursor = index; cursor < lines.length && cursor <= index + 8; cursor += 1) {
      header.push(lines[cursor]);
      if (CALLBACK_START.test(lines[cursor]) || STATEMENT_END.test(lines[cursor])) break;
    }

    const headerText = header.join('\n');
    declarations.push({
      lineNumber: index + 1,
      header: headerText,
      pending: PENDING_MARKER.test(headerText),
    });
  }

  declarationsByFile.set(file, declarations);
  return declarations;
}

/** `#4 — backend/tests/engine/contracts-lifecycle.test.ts :: a seller cannot accept its own offer` */
function label(entry: MatrixEntry): string {
  return `#${entry.issue} — ${entry.file} :: ${entry.titleFragment}`;
}

/**
 * True when the declaration names the issue, either literally in the title or
 * skip reason, or through a constant such as `const issue2 = 'pending: ... #2'`.
 */
function namesIssue(file: string, header: string, issue: number): boolean {
  if (header.toLowerCase().includes(`issue #${issue}`)) return true;

  const referenced = /skip\s*:\s*([A-Za-z_$][\w$]*)/.exec(header);
  if (!referenced) return false;

  const value = constantString(file, referenced[1]);
  return value !== undefined && value.toLowerCase().includes(`issue #${issue}`);
}

/** Reads the first string literal assigned to `const <name>` in the file. */
function constantString(file: string, name: string): string | undefined {
  const text = sourceOf(file);
  const marker = `const ${name}`;

  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    const assignment = text.indexOf('=', at + marker.length);
    if (assignment === -1) return undefined;

    const value = text.slice(assignment + 1).trimStart();
    const quote = value[0];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;

    const end = value.indexOf(quote, 1);
    if (end !== -1) return value.slice(1, end);
  }

  return undefined;
}

describe('P0 regression matrix — #1–#7', () => {
  test('every P0 issue #1–#7 maps to at least one matrix entry', () => {
    for (const issue of P0_ISSUES) {
      const entries = MATRIX.filter((entry) => entry.issue === issue);
      assert.ok(
        entries.length > 0,
        `S8: P0 issue #${issue} lost every regression entry — add the owning test or restore the matrix row`,
      );
    }
  });

  test('entry kinds match the recorded issue state (no green-by-claim)', () => {
    for (const entry of MATRIX) {
      assert.equal(
        entry.kind,
        EXPECTED_KIND[entry.issue],
        `#${entry.issue} is recorded as ${EXPECTED_KIND[entry.issue]} for now; ` +
          `${entry.file} is marked ${entry.kind}. Assert the fix in the owning file first, ` +
          'then flip the entry here and in the README.',
      );
    }
  });

  test('pinned title fragments stay long and unique', () => {
    const seen = new Map<string, string>();

    for (const entry of MATRIX) {
      assert.ok(
        entry.titleFragment.length >= 20,
        `${label(entry)}: the fragment is too short to be distinctive`,
      );
      const previous = seen.get(entry.titleFragment);
      assert.equal(
        previous,
        undefined,
        `duplicate fragment "${entry.titleFragment}" in ${entry.file}; already used by ${previous}`,
      );
      seen.set(entry.titleFragment, label(entry));
    }
  });

  for (const entry of MATRIX) {
    test(`coverage is ${entry.kind}: ${label(entry)}`, () => {
      const absolute = resolve(REPO_ROOT, entry.file);
      assert.ok(existsSync(absolute), `${entry.file} must exist: it owns the regression for issue #${entry.issue}`);

      const matches = declarationsOf(entry.file).filter((declaration) =>
        declaration.header.includes(entry.titleFragment)
      );

      assert.equal(
        matches.length,
        1,
        `expected exactly one test title in ${entry.file} containing "${entry.titleFragment}"; ` +
          `found ${matches.length}. A renamed or removed title drops the regression for issue #${entry.issue}.`,
      );

      const match = matches[0];

      if (entry.kind === 'pending') {
        assert.equal(
          match.pending,
          true,
          `${entry.file}:${match.lineNumber} is still listed as pending for open issue #${entry.issue} ` +
            'but no longer carries a skip/todo marker. If the fix landed, assert the test and flip the ' +
            'matrix entry and README to green; never assert it silently.',
        );
        assert.equal(
          namesIssue(entry.file, match.header, entry.issue),
          true,
          `${entry.file}:${match.lineNumber} must name issue #${entry.issue} in its title or skip reason ` +
            'so the pending entry stays linked (S6/S8).',
        );
      } else {
        assert.equal(
          match.pending,
          false,
          `${entry.file}:${match.lineNumber} is pinned as green coverage for closed issue #${entry.issue} ` +
            'but now carries a skip/todo marker. A muted regression is not coverage.',
        );
      }
    });
  }

  test('the README matrix documents every issue, its status and its files', () => {
    const absolute = resolve(REPO_ROOT, README_FILE);
    assert.ok(existsSync(absolute), `${README_FILE} must exist: it is the human half of this matrix`);

    const readme = readFileSync(absolute, 'utf8');

    const rows = readme
      .split(/\r?\n/)
      .map((line) => line.split('|').map((cell) => cell.trim()));

    for (const issue of P0_ISSUES) {
      const row = rows.find((cells) => cells.length > 2 && cells[1] === `#${issue}`);
      assert.ok(
        row,
        `${README_FILE} needs a status row for issue #${issue}: | #${issue} | green|pending | ...`,
      );

      const status = row[2];
      assert.ok(
        status === 'green' || status === 'pending',
        `${README_FILE} row for issue #${issue} must state green or pending, found "${status}"`,
      );
      assert.equal(
        status,
        EXPECTED_KIND[issue],
        `${README_FILE} reports issue #${issue} as ${status}, but the matrix expects ${EXPECTED_KIND[issue]}`,
      );
    }

    for (const file of new Set(MATRIX.map((entry) => entry.file))) {
      assert.ok(
        readme.includes(`\`${file}\``),
        `${README_FILE} must name \`${file}\` so a reader can find the tests it documents`,
      );
    }
  });
});
