/**
 * Credit-ledger domain records and validation (S4/S14).
 *
 * This module is deliberately SQL-free: it names what a monetary movement *is*
 * and rejects an unsafe one before anything touches the database, so a future
 * settlement engine can import these types and validators without importing the
 * persistence layer (or `bun:sqlite`) at all.
 *
 * Two boundaries this file encodes:
 *
 * 1. **Evidence, not authority.** An opening is the immutable observation of
 *    spendable balances at a tick, and every movement is an append-only record
 *    of value leaving one typed account and arriving in another. None of it is
 *    a second mutable source of spendable credits: `companies.credits` stays
 *    authoritative (S4). The journal can therefore be used to audit or
 *    reconcile, never to "fix" a balance.
 *
 * 2. **Named accounts, named events.** A movement must join the accounts its
 *    kind actually connects. That is what distinguishes a buyer escrow deposit
 *    from seller collateral, a delivery payment from the market fee that
 *    accompanies it, an indemnity transfer from a refund, and the maintenance
 *    sink (paid by a company, owned by nobody, and therefore the one kind that
 *    carries **no** contract id). A penalty is a transfer of the seller's
 *    collateral to the buyer, never a burned movement: no kind destroys credits
 *    outside a declared sink.
 */

/**
 * Typed accounts. Company-backed accounts are owned by one company; the two
 * sinks are global and own no company, so they carry no `companyId` at all.
 */
export const CREDIT_ACCOUNT_KINDS = [
  'AVAILABLE',
  'BUYER_ESCROW',
  'SELLER_COLLATERAL',
  'MARKET_FEE_SINK',
  'MAINTENANCE_SINK',
] as const;

export type CreditAccountKind = (typeof CREDIT_ACCOUNT_KINDS)[number];
export type CreditCompanyAccountKind = 'AVAILABLE' | 'BUYER_ESCROW' | 'SELLER_COLLATERAL';
export type CreditSinkAccountKind = 'MARKET_FEE_SINK' | 'MAINTENANCE_SINK';

export interface CreditCompanyAccountRef {
  readonly kind: CreditCompanyAccountKind;
  readonly companyId: string;
}

export interface CreditSinkAccountRef {
  readonly kind: CreditSinkAccountKind;
}

export type CreditAccountRef = CreditCompanyAccountRef | CreditSinkAccountRef;

/**
 * Why a movement exists. Each kind has exactly one admissible account route
 * (see `MOVEMENT_ROUTES`), which is what makes a stored journal auditable
 * without re-deriving the settlement rules from the amount alone.
 */
export type CreditMovementKind =
  | 'BUYER_ESCROW_DEPOSIT'
  | 'SELLER_COLLATERAL_DEPOSIT'
  | 'DELIVERY_PAYMENT'
  | 'FEE_SINK'
  | 'INDEMNITY_TRANSFER'
  | 'REFUND'
  | 'MAINTENANCE_SINK';

export const CREDIT_MOVEMENT_KINDS: readonly CreditMovementKind[] = [
  'BUYER_ESCROW_DEPOSIT',
  'SELLER_COLLATERAL_DEPOSIT',
  'DELIVERY_PAYMENT',
  'FEE_SINK',
  'INDEMNITY_TRANSFER',
  'REFUND',
  'MAINTENANCE_SINK',
];

/**
 * COMPLETE = the journal covers the whole match from its genesis tick.
 * CUTOVER  = legacy state enters the journal at an observed tick; earlier
 *            history is preserved as balances and contracts, not certified.
 */
export type CreditCoverage = 'COMPLETE' | 'CUTOVER';

export const CREDIT_LEDGER_COVERAGES: readonly CreditCoverage[] = ['COMPLETE', 'CUTOVER'];

/** One observed, non-spendable balance at the opening tick. */
export interface CreditLedgerBalance {
  readonly account: CreditCompanyAccountRef;
  readonly balanceCredits: number;
}

/** The immutable opening of one match's journal. */
export interface CreditLedgerOpening {
  readonly matchId: string;
  readonly observedAtTick: number;
  readonly coverage: CreditCoverage;
  readonly balances: readonly CreditLedgerBalance[];
}

/**
 * One append-only monetary movement.
 *
 * `sequence` is the per-match position (1, 2, 3, ... with no gaps) and
 * `eventKey` is the caller's stable identity for the economic event (for
 * example `contract_1:fee:tick-40`). `eventKey` is unique per match, so
 * retrying a settlement cannot record the same movement twice; `contractId`
 * is optional because maintenance has no contract and must never take part in
 * that uniqueness rule.
 */
export interface CreditLedgerMovement {
  readonly matchId: string;
  readonly sequence: number;
  readonly eventKey: string;
  readonly tick: number;
  readonly contractId?: string;
  readonly kind: CreditMovementKind;
  readonly amountCredits: number;
  readonly source: CreditAccountRef;
  readonly destination: CreditAccountRef;
}

export type CreditLedgerValidationCode =
  | 'INVALID_MATCH_ID'
  | 'INVALID_EVENT_KEY'
  | 'INVALID_SEQUENCE'
  | 'INVALID_TICK'
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_MOVEMENT_KIND'
  | 'MISSING_CONTRACT_ID'
  | 'INVALID_CONTRACT_ID'
  | 'UNEXPECTED_CONTRACT_ID'
  | 'INVALID_ACCOUNT'
  | 'INVALID_ACCOUNT_KIND'
  | 'INVALID_ACCOUNT_COMPANY'
  | 'SINK_ACCOUNT_HAS_COMPANY'
  | 'INVALID_ACCOUNT_FIELD'
  | 'INVALID_ACCOUNT_JSON'
  | 'INVALID_MOVEMENT_ROUTE'
  | 'MOVEMENT_COMPANY_MISMATCH'
  | 'INVALID_COVERAGE'
  | 'INVALID_BALANCES'
  | 'INVALID_BALANCE'
  | 'DUPLICATE_OPENING_ACCOUNT'
  | 'OPENING_SINK_NOT_ALLOWED';

/** Rejected domain input. `message` is always `"<CODE>: <detail>"`. */
export class CreditLedgerValidationError extends Error {
  constructor(
    readonly code: CreditLedgerValidationCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CreditLedgerValidationError';
  }
}

const COMPANY_ACCOUNT_KINDS: readonly CreditCompanyAccountKind[] = [
  'AVAILABLE',
  'BUYER_ESCROW',
  'SELLER_COLLATERAL',
];

const SINK_ACCOUNT_KINDS: readonly CreditSinkAccountKind[] = [
  'MARKET_FEE_SINK',
  'MAINTENANCE_SINK',
];

export function isCreditSinkAccountKind(kind: CreditAccountKind): kind is CreditSinkAccountKind {
  return (SINK_ACCOUNT_KINDS as readonly CreditAccountKind[]).includes(kind);
}

function isCompanyAccountRef(ref: CreditAccountRef): ref is CreditCompanyAccountRef {
  return !isCreditSinkAccountKind(ref.kind);
}

function isCreditAccountKind(kind: unknown): kind is CreditAccountKind {
  return typeof kind === 'string' && (CREDIT_ACCOUNT_KINDS as readonly string[]).includes(kind);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown, code: CreditLedgerValidationCode, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CreditLedgerValidationError(code, `${label} must be an object, received ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  code: CreditLedgerValidationCode,
  detail: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CreditLedgerValidationError(
      code,
      `${field} must be ${detail}, received ${describe(value)}`,
    );
  }
  return value;
}

function readSafeInteger(
  record: Record<string, unknown>,
  field: string,
  code: CreditLedgerValidationCode,
  detail: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CreditLedgerValidationError(
      code,
      `${field} must be ${detail}, received ${describe(value)}`,
    );
  }
  return value;
}

function readAccountRef(value: unknown, label: string): CreditAccountRef {
  const record = asRecord(value, 'INVALID_ACCOUNT', label);
  if (!isCreditAccountKind(record.kind)) {
    throw new CreditLedgerValidationError(
      'INVALID_ACCOUNT_KIND',
      `${label}.kind must be one of ${CREDIT_ACCOUNT_KINDS.join(', ')}, received ${describe(record.kind)}`,
    );
  }
  const kind = record.kind;
  if (isCreditSinkAccountKind(kind)) {
    if (record.companyId !== undefined) {
      throw new CreditLedgerValidationError(
        'SINK_ACCOUNT_HAS_COMPANY',
        `${label} is the sink account ${kind} and must not carry a companyId`,
      );
    }
    return Object.freeze({ kind });
  }
  const companyId = record.companyId;
  if (typeof companyId !== 'string' || companyId.trim().length === 0) {
    throw new CreditLedgerValidationError(
      'INVALID_ACCOUNT_COMPANY',
      `${label}.companyId must be a non-empty string for account kind ${kind}, received ${describe(companyId)}`,
    );
  }
  return Object.freeze({ kind, companyId });
}

/**
 * Encode an account ref canonically (kind first, `companyId` only for a
 * company-backed account). The encoding is used as the stored form and as the
 * uniqueness key of opening balances, so it must be deterministic: the same
 * account always produces the same string.
 */
export function encodeCreditAccountRef(ref: CreditAccountRef): string {
  return JSON.stringify(readAccountRef(ref, 'account'));
}

/**
 * Decode a stored account ref strictly: valid JSON, a plain object, only
 * `kind`/`companyId`, a known kind, and a company id exactly when the kind
 * requires one. Corrupt stored payloads fail loudly instead of silently
 * becoming a different account.
 */
export function decodeCreditAccountRef(payload: string): CreditAccountRef {
  if (typeof payload !== 'string') {
    throw new CreditLedgerValidationError(
      'INVALID_ACCOUNT_JSON',
      `stored account payload must be a string, received ${describe(payload)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CreditLedgerValidationError(
      'INVALID_ACCOUNT_JSON',
      `stored account payload is not valid JSON: ${payload}`,
    );
  }
  const record = asRecord(parsed, 'INVALID_ACCOUNT_JSON', 'stored account payload');
  for (const key of Object.keys(record)) {
    if (key !== 'kind' && key !== 'companyId') {
      throw new CreditLedgerValidationError(
        'INVALID_ACCOUNT_FIELD',
        `stored account payload has unexpected field ${describe(key)}`,
      );
    }
  }
  return readAccountRef(record, 'stored account payload');
}

interface CreditMovementRoute {
  readonly sources: readonly CreditAccountKind[];
  readonly destinations: readonly CreditAccountKind[];
  readonly contract: 'REQUIRED' | 'FORBIDDEN';
  /** Source and destination must be the same company (money stays put). */
  readonly sameCompany: boolean;
}

/**
 * The one admissible route per movement kind. `sameCompany` is true where the
 * value moves between two accounts of the same owner (a deposit into your own
 * escrow, a refund back to whoever funded it). Delivery payment and indemnity
 * intentionally cross companies; fee and maintenance end in a sink that owns
 * no company.
 */
const MOVEMENT_ROUTES: Readonly<Record<CreditMovementKind, CreditMovementRoute>> = {
  BUYER_ESCROW_DEPOSIT: {
    sources: ['AVAILABLE'],
    destinations: ['BUYER_ESCROW'],
    contract: 'REQUIRED',
    sameCompany: true,
  },
  SELLER_COLLATERAL_DEPOSIT: {
    sources: ['AVAILABLE'],
    destinations: ['SELLER_COLLATERAL'],
    contract: 'REQUIRED',
    sameCompany: true,
  },
  DELIVERY_PAYMENT: {
    sources: ['BUYER_ESCROW'],
    destinations: ['AVAILABLE'],
    contract: 'REQUIRED',
    sameCompany: false,
  },
  FEE_SINK: {
    sources: ['BUYER_ESCROW'],
    destinations: ['MARKET_FEE_SINK'],
    contract: 'REQUIRED',
    sameCompany: false,
  },
  INDEMNITY_TRANSFER: {
    sources: ['SELLER_COLLATERAL'],
    destinations: ['AVAILABLE'],
    contract: 'REQUIRED',
    sameCompany: false,
  },
  REFUND: {
    sources: ['BUYER_ESCROW', 'SELLER_COLLATERAL'],
    destinations: ['AVAILABLE'],
    contract: 'REQUIRED',
    sameCompany: true,
  },
  MAINTENANCE_SINK: {
    sources: ['AVAILABLE'],
    destinations: ['MAINTENANCE_SINK'],
    contract: 'FORBIDDEN',
    sameCompany: false,
  },
};

function isMovementKind(kind: unknown): kind is CreditMovementKind {
  return typeof kind === 'string' && (CREDIT_MOVEMENT_KINDS as readonly string[]).includes(kind);
}

function assertRoute(
  kind: CreditMovementKind,
  source: CreditAccountRef,
  destination: CreditAccountRef,
): void {
  const route = MOVEMENT_ROUTES[kind];
  if (!route.sources.includes(source.kind) || !route.destinations.includes(destination.kind)) {
    throw new CreditLedgerValidationError(
      'INVALID_MOVEMENT_ROUTE',
      `${kind} moves ${route.sources.join('|')} -> ${route.destinations.join('|')}, ` +
        `received ${source.kind} -> ${destination.kind}`,
    );
  }
  if (route.sameCompany) {
    const sourceCompany = (source as CreditCompanyAccountRef).companyId;
    const destinationCompany = (destination as CreditCompanyAccountRef).companyId;
    if (sourceCompany !== destinationCompany) {
      throw new CreditLedgerValidationError(
        'MOVEMENT_COMPANY_MISMATCH',
        `${kind} must stay inside one company, received ${describe(sourceCompany)} -> ` +
          `${describe(destinationCompany)}`,
      );
    }
  }
}

/**
 * Validate and normalize one movement. Throws `CreditLedgerValidationError`
 * with a stable code for the first violated rule; returns a frozen record with
 * the contract id omitted (not `undefined`) when the kind has none.
 */
export function validateCreditMovement(input: unknown): CreditLedgerMovement {
  const record = asRecord(input, 'INVALID_ACCOUNT', 'movement');
  const matchId = readNonEmptyString(record, 'matchId', 'INVALID_MATCH_ID', 'a non-empty string');
  const eventKey = readNonEmptyString(record, 'eventKey', 'INVALID_EVENT_KEY', 'a non-empty string');
  const sequence = readSafeInteger(record, 'sequence', 'INVALID_SEQUENCE', 'a positive safe integer');
  if (sequence <= 0) {
    throw new CreditLedgerValidationError(
      'INVALID_SEQUENCE',
      `sequence must be a positive safe integer, received ${describe(record.sequence)}`,
    );
  }
  const tick = readSafeInteger(record, 'tick', 'INVALID_TICK', 'a non-negative safe integer');
  if (tick < 0) {
    throw new CreditLedgerValidationError(
      'INVALID_TICK',
      `tick must be a non-negative safe integer, received ${describe(record.tick)}`,
    );
  }
  const amountCredits = readSafeInteger(
    record,
    'amountCredits',
    'INVALID_AMOUNT',
    'a positive safe integer',
  );
  if (amountCredits <= 0) {
    throw new CreditLedgerValidationError(
      'INVALID_AMOUNT',
      `amountCredits must be a positive safe integer, received ${describe(record.amountCredits)}`,
    );
  }
  if (!isMovementKind(record.kind)) {
    throw new CreditLedgerValidationError(
      'UNKNOWN_MOVEMENT_KIND',
      `kind must be one of ${CREDIT_MOVEMENT_KINDS.join(', ')}, received ${describe(record.kind)}`,
    );
  }
  const kind = record.kind;
  const route = MOVEMENT_ROUTES[kind];

  let contractId: string | undefined;
  if (route.contract === 'REQUIRED') {
    if (record.contractId === undefined) {
      throw new CreditLedgerValidationError(
        'MISSING_CONTRACT_ID',
        `${kind} must reference a contract; only MAINTENANCE_SINK has no contract`,
      );
    }
    contractId = readNonEmptyString(
      record,
      'contractId',
      'INVALID_CONTRACT_ID',
      'a non-empty string',
    );
  } else if (record.contractId !== undefined) {
    throw new CreditLedgerValidationError(
      'UNEXPECTED_CONTRACT_ID',
      `${kind} is not part of a contract and must not carry a contractId`,
    );
  }

  const source = readAccountRef(record.source, 'source');
  const destination = readAccountRef(record.destination, 'destination');
  assertRoute(kind, source, destination);

  return Object.freeze({
    matchId,
    eventKey,
    sequence,
    tick,
    ...(contractId === undefined ? {} : { contractId }),
    kind,
    amountCredits,
    source,
    destination,
  });
}

function canonicalAccountOrder(a: CreditCompanyAccountRef, b: CreditCompanyAccountRef): number {
  const rank = CREDIT_ACCOUNT_KINDS.indexOf(a.kind) - CREDIT_ACCOUNT_KINDS.indexOf(b.kind);
  if (rank !== 0) return rank;
  if (a.companyId === b.companyId) return 0;
  return a.companyId < b.companyId ? -1 : 1;
}

/**
 * Validate and normalize an opening. Balances are returned in canonical account
 * order (account kind, then company id) so a read back is deterministic; a
 * repeated account and a sink balance are rejected, because sinks are derived
 * from movements and an observed opening cannot invent them.
 */
export function validateCreditLedgerOpening(input: unknown): CreditLedgerOpening {
  const record = asRecord(input, 'INVALID_BALANCES', 'opening');
  const matchId = readNonEmptyString(record, 'matchId', 'INVALID_MATCH_ID', 'a non-empty string');
  const observedAtTick = readSafeInteger(
    record,
    'observedAtTick',
    'INVALID_TICK',
    'a non-negative safe integer',
  );
  if (observedAtTick < 0) {
    throw new CreditLedgerValidationError(
      'INVALID_TICK',
      `observedAtTick must be a non-negative safe integer, received ${describe(record.observedAtTick)}`,
    );
  }
  if (!(CREDIT_LEDGER_COVERAGES as readonly string[]).includes(String(record.coverage))) {
    throw new CreditLedgerValidationError(
      'INVALID_COVERAGE',
      `coverage must be one of ${CREDIT_LEDGER_COVERAGES.join(', ')}, received ${describe(record.coverage)}`,
    );
  }
  const coverage = record.coverage as CreditCoverage;
  if (!Array.isArray(record.balances)) {
    throw new CreditLedgerValidationError(
      'INVALID_BALANCES',
      `balances must be a list, received ${describe(record.balances)}`,
    );
  }

  const seen = new Set<string>();
  const balances: CreditLedgerBalance[] = [];
  for (const candidate of record.balances as unknown[]) {
    const balance = asRecord(candidate, 'INVALID_BALANCE', 'opening balance');
    const account = readAccountRef(balance.account, 'balance.account');
    if (!isCompanyAccountRef(account)) {
      throw new CreditLedgerValidationError(
        'OPENING_SINK_NOT_ALLOWED',
        `an opening records spendable/held balances only; received sink account ${account.kind}`,
      );
    }
    const balanceCredits = readSafeInteger(
      balance,
      'balanceCredits',
      'INVALID_BALANCE',
      'a non-negative safe integer',
    );
    if (balanceCredits < 0) {
      throw new CreditLedgerValidationError(
        'INVALID_BALANCE',
        `balanceCredits must be a non-negative safe integer, received ${describe(balance.balanceCredits)}`,
      );
    }
    const accountKey = encodeCreditAccountRef(account);
    if (seen.has(accountKey)) {
      throw new CreditLedgerValidationError(
        'DUPLICATE_OPENING_ACCOUNT',
        `the opening repeats account ${accountKey}`,
      );
    }
    seen.add(accountKey);
    balances.push(Object.freeze({ account, balanceCredits }));
  }

  const sorted = balances
    .slice()
    .sort((left, right) => canonicalAccountOrder(left.account, right.account));

  return Object.freeze({
    matchId,
    observedAtTick,
    coverage,
    balances: Object.freeze(sorted),
  });
}
