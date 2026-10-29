/** S4: SQL-free credit-account codec; moved verbatim from storage tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDIT_ACCOUNT_KINDS,
  CreditLedgerValidationError,
  decodeCreditAccountRef,
  encodeCreditAccountRef,
  type CreditAccountRef,
} from '../src/domain/creditLedger.ts';
import { COMPANY_METAL } from './persistence/repos-fixtures.ts';

function rejectsValidation(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.equal(
      error instanceof CreditLedgerValidationError,
      true,
      `expected a CreditLedgerValidationError for ${code}, received ${String(error)}`,
    );
    const rejection = error as CreditLedgerValidationError;
    assert.equal(rejection.code, code);
    assert.match(rejection.message, new RegExp(`^${code}: `));
    return true;
  };
}


test('the account-ref JSON codec rejects malformed, unknown and mis-shaped payloads', () => {
  const companyRef: CreditAccountRef = { kind: 'AVAILABLE', companyId: COMPANY_METAL };
  const sinkRef: CreditAccountRef = { kind: 'MARKET_FEE_SINK' };

  assert.deepEqual(decodeCreditAccountRef(encodeCreditAccountRef(companyRef)), companyRef);
  assert.deepEqual(decodeCreditAccountRef(encodeCreditAccountRef(sinkRef)), sinkRef);

  const cases: readonly (readonly [string, string])[] = [
    ['not json at all', 'INVALID_ACCOUNT_JSON'],
    ['null', 'INVALID_ACCOUNT_JSON'],
    ['[]', 'INVALID_ACCOUNT_JSON'],
    ['"AVAILABLE"', 'INVALID_ACCOUNT_JSON'],
    ['{"kind":"AVAILABLE"}', 'INVALID_ACCOUNT_COMPANY'],
    ['{"kind":"AVAILABLE","companyId":""}', 'INVALID_ACCOUNT_COMPANY'],
    ['{"kind":"AVAILABLE","companyId":7}', 'INVALID_ACCOUNT_COMPANY'],
    ['{"kind":"AVAILABLE","companyId":"comp_metal_01","note":"hi"}', 'INVALID_ACCOUNT_FIELD'],
    ['{"kind":"PENALTY_BURN","companyId":"comp_metal_01"}', 'INVALID_ACCOUNT_KIND'],
    ['{"kind":42}', 'INVALID_ACCOUNT_KIND'],
    ['{"kind":"MARKET_FEE_SINK","companyId":"comp_metal_01"}', 'SINK_ACCOUNT_HAS_COMPANY'],
  ];
  for (const [payload, code] of cases) {
    assert.throws(() => decodeCreditAccountRef(payload), rejectsValidation(code), payload);
  }

  assert.equal(CREDIT_ACCOUNT_KINDS.includes('AVAILABLE'), true);
  assert.equal(CREDIT_ACCOUNT_KINDS.includes('MAINTENANCE_SINK'), true);
});
