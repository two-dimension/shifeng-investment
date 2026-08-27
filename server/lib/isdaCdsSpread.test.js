import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CdsModelValidationError,
  cleanPriceToParSpread,
  parSpreadToCleanPrice,
  validateDiscountCurve,
} from './isdaCdsSpread.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const curve = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/ice-cds/usd-sofr-curve-sample.json'), 'utf8'));

const contract = Object.freeze({
  couponBp: 100,
  clearingDate: '2026-08-24',
  maturityDate: '2031-06-20',
  recoveryRate: 0.4,
  discountCurve: curve,
});

test('validates a complete, strictly ascending continuous-zero discount curve', () => {
  assert.deepEqual(validateDiscountCurve(curve), curve);
  assert.throws(
    () => validateDiscountCurve({ ...curve, nodes: [curve.nodes[0], curve.nodes[0]] }),
    (error) => error instanceof CdsModelValidationError && /ascending|unique/i.test(error.message),
  );
  assert.throws(
    () => validateDiscountCurve({ ...curve, asOf: '2026-02-30' }),
    (error) => error instanceof CdsModelValidationError && /asOf/i.test(error.message),
  );
  assert.throws(
    () => validateDiscountCurve({ ...curve, nodes: [{ years: 1, zeroRate: Number.NaN }, { years: 2, zeroRate: 0.04 }] }),
    (error) => error instanceof CdsModelValidationError && /zero rate/i.test(error.message),
  );
});

test('par price returns the coupon as the model-derived par spread', () => {
  const result = cleanPriceToParSpread({ ...contract, cleanPrice: 100 });

  assert.ok(Math.abs(result.spreadBp - 100) <= 0.01);
  assert.ok(result.priceResidual <= 0.000001);
  assert.equal(result.curveId, curve.curveId);
  assert.equal(result.recoveryRate, 0.4);
  assert.equal(result.modelVersion, 'ice-isda-compatible-v1');
});

test('price direction is economically consistent around par', () => {
  const discount = cleanPriceToParSpread({ ...contract, cleanPrice: 98.5 });
  const premium = cleanPriceToParSpread({ ...contract, cleanPrice: 100.5 });

  assert.ok(discount.spreadBp > contract.couponBp);
  assert.ok(premium.spreadBp < contract.couponBp);
});

test('synthetic 207 bp spread round-trips through clean price within 0.01 bp', () => {
  const cleanPrice = parSpreadToCleanPrice({ ...contract, spreadBp: 207 });
  const result = cleanPriceToParSpread({ ...contract, cleanPrice });

  assert.ok(Math.abs(result.spreadBp - 207) <= 0.01, `${result.spreadBp} bp`);
  assert.ok(Math.abs(result.roundTripPrice - cleanPrice) <= 0.000001);
  assert.ok(result.priceResidual <= 0.000001);
});

test('rejects malformed contracts and non-convergent inputs with typed validation errors', () => {
  assert.throws(
    () => cleanPriceToParSpread({ ...contract, cleanPrice: -1 }),
    (error) => error instanceof CdsModelValidationError && /price/i.test(error.message),
  );
  assert.throws(
    () => cleanPriceToParSpread({ ...contract, cleanPrice: 100, maturityDate: '2026-06-20' }),
    (error) => error instanceof CdsModelValidationError && /maturity/i.test(error.message),
  );
  assert.throws(
    () => cleanPriceToParSpread({ ...contract, cleanPrice: 130 }),
    (error) => error instanceof CdsModelValidationError && /converge|bracket/i.test(error.message),
  );
});
