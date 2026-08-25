const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MODEL_VERSION = 'ice-isda-compatible-v1';

export class CdsModelValidationError extends Error {
  constructor(message, code = 'invalid-model-input') {
    super(message);
    this.name = 'CdsModelValidationError';
    this.code = code;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function toDate(value, label) {
  if (!validDate(value)) throw new CdsModelValidationError(`${label} must be a real YYYY-MM-DD date`);
  return new Date(`${value}T00:00:00.000Z`);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return (end.getTime() - start.getTime()) / MS_PER_DAY;
}

function isWeekend(date) {
  return date.getUTCDay() === 0 || date.getUTCDay() === 6;
}

function addBusinessDays(date, days) {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekend(result)) remaining -= 1;
  }
  return result;
}

function modifiedFollowing(date) {
  if (!isWeekend(date)) return new Date(date);
  const month = date.getUTCMonth();
  const following = new Date(date);
  while (isWeekend(following)) following.setUTCDate(following.getUTCDate() + 1);
  if (following.getUTCMonth() === month) return following;
  const preceding = new Date(date);
  while (isWeekend(preceding)) preceding.setUTCDate(preceding.getUTCDate() - 1);
  return preceding;
}

export function validateDiscountCurve(curve) {
  if (!curve || typeof curve !== 'object' || Array.isArray(curve)) {
    throw new CdsModelValidationError('Discount curve must be an object');
  }
  if (!String(curve.curveId || '').trim()) throw new CdsModelValidationError('Discount curve curveId is required');
  toDate(curve.asOf, 'Discount curve asOf');
  if (String(curve.currency || '').toUpperCase() !== 'USD') {
    throw new CdsModelValidationError('Discount curve currency must be USD');
  }
  if (!Array.isArray(curve.nodes) || curve.nodes.length < 2) {
    throw new CdsModelValidationError('Discount curve must contain at least two nodes');
  }
  let priorYears = 0;
  for (const node of curve.nodes) {
    if (!Number.isFinite(node?.years) || node.years <= 0) {
      throw new CdsModelValidationError('Discount curve node years must be positive and finite');
    }
    if (node.years <= priorYears) {
      throw new CdsModelValidationError('Discount curve node years must be unique and strictly ascending');
    }
    if (!Number.isFinite(node.zeroRate)) {
      throw new CdsModelValidationError('Discount curve zero rate must be finite');
    }
    priorYears = node.years;
  }
  return curve;
}

function zeroRateAt(curve, years) {
  if (years <= curve.nodes[0].years) return curve.nodes[0].zeroRate;
  const last = curve.nodes[curve.nodes.length - 1];
  if (years >= last.years) return last.zeroRate;
  for (let index = 1; index < curve.nodes.length; index += 1) {
    const right = curve.nodes[index];
    if (years <= right.years) {
      const left = curve.nodes[index - 1];
      const weight = (years - left.years) / (right.years - left.years);
      return left.zeroRate + weight * (right.zeroRate - left.zeroRate);
    }
  }
  return last.zeroRate;
}

function discountFactor(curve, curveDate, paymentDate) {
  const years = Math.max(0, daysBetween(curveDate, paymentDate) / 365);
  return Math.exp(-zeroRateAt(curve, years) * years);
}

function quarterlyImmDates(stepInDate, maturityDate) {
  const dates = [];
  for (let year = stepInDate.getUTCFullYear(); year <= maturityDate.getUTCFullYear(); year += 1) {
    for (const month of [2, 5, 8, 11]) {
      const date = new Date(Date.UTC(year, month, 20));
      if (date > stepInDate && date < maturityDate) dates.push(date);
      if (date.getTime() === maturityDate.getTime()) dates.push(date);
    }
  }
  if (dates.length === 0 || dates[dates.length - 1].getTime() !== maturityDate.getTime()) {
    dates.push(new Date(maturityDate));
  }
  return dates;
}

function normalizeContract(input) {
  const cleanPrice = input.cleanPrice;
  const spreadBp = input.spreadBp;
  if (cleanPrice !== undefined && (!Number.isFinite(cleanPrice) || cleanPrice < 0 || cleanPrice > 200)) {
    throw new CdsModelValidationError('Clean EOD price must be between 0 and 200');
  }
  if (spreadBp !== undefined && (!Number.isFinite(spreadBp) || spreadBp < 0 || spreadBp > 100_000)) {
    throw new CdsModelValidationError('Par spread must be a finite non-negative bp value');
  }
  if (!Number.isFinite(input.couponBp) || input.couponBp <= 0 || input.couponBp > 100_000) {
    throw new CdsModelValidationError('Coupon must be a positive bp value');
  }
  if (!Number.isFinite(input.recoveryRate) || input.recoveryRate < 0 || input.recoveryRate >= 1) {
    throw new CdsModelValidationError('Recovery rate must be in [0, 1)');
  }
  const clearingDate = toDate(input.clearingDate, 'Clearing date');
  const maturityDate = toDate(input.maturityDate, 'Maturity date');
  const discountCurve = validateDiscountCurve(input.discountCurve);
  const curveDate = toDate(discountCurve.asOf, 'Discount curve asOf');
  const stepInDate = addBusinessDays(clearingDate, 1);
  const cashSettlementDate = addBusinessDays(clearingDate, 3);
  if (maturityDate <= stepInDate) throw new CdsModelValidationError('Maturity date must be after the step-in date');
  if (curveDate > cashSettlementDate) {
    throw new CdsModelValidationError('Discount curve asOf cannot be after cash settlement');
  }
  return {
    ...input,
    clearingDate,
    maturityDate,
    discountCurve,
    curveDate,
    stepInDate,
    cashSettlementDate,
    couponRate: input.couponBp / 10_000,
    paymentDates: quarterlyImmDates(stepInDate, maturityDate),
  };
}

function legValues(hazardRate, contract) {
  let protectionLegPv = 0;
  let riskyAnnuity = 0;
  let periodStart = contract.stepInDate;
  for (const unadjustedEnd of contract.paymentDates) {
    const paymentDate = modifiedFollowing(unadjustedEnd);
    const periodDays = daysBetween(periodStart, unadjustedEnd);
    if (periodDays <= 0) continue;
    const accrualFraction = periodDays / 360;
    const startYears = Math.max(0, daysBetween(contract.stepInDate, periodStart) / 365);
    const endYears = Math.max(0, daysBetween(contract.stepInDate, unadjustedEnd) / 365);
    const midpoint = new Date((periodStart.getTime() + unadjustedEnd.getTime()) / 2);
    const survivalStart = Math.exp(-hazardRate * startYears);
    const survivalEnd = Math.exp(-hazardRate * endYears);
    const defaultProbability = Math.max(0, survivalStart - survivalEnd);
    const paymentDiscount = discountFactor(contract.discountCurve, contract.curveDate, paymentDate);
    const defaultDiscount = discountFactor(contract.discountCurve, contract.curveDate, midpoint);
    protectionLegPv += (1 - contract.recoveryRate) * defaultProbability * defaultDiscount;
    riskyAnnuity += accrualFraction * survivalEnd * paymentDiscount;
    riskyAnnuity += 0.5 * accrualFraction * defaultProbability * defaultDiscount;
    periodStart = unadjustedEnd;
  }
  if (!(riskyAnnuity > 0)) throw new CdsModelValidationError('Risky annuity is not positive');
  return { protectionLegPv, riskyAnnuity };
}

function bisectRoot(fn, label) {
  let low = 0;
  let high = 5;
  let lowValue = fn(low);
  let highValue = fn(high);
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) {
    throw new CdsModelValidationError(`${label} solver returned a non-finite value`, 'solver-failed');
  }
  if (Math.abs(lowValue) <= 1e-14) return low;
  if (Math.abs(highValue) <= 1e-14) return high;
  if (lowValue * highValue > 0) {
    throw new CdsModelValidationError(`${label} solver could not bracket a non-negative hazard rate`, 'solver-non-convergence');
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const midpoint = (low + high) / 2;
    const value = fn(midpoint);
    if (!Number.isFinite(value)) {
      throw new CdsModelValidationError(`${label} solver returned a non-finite value`, 'solver-failed');
    }
    if (Math.abs(value) <= 1e-13 || high - low <= 1e-12) return midpoint;
    if (lowValue * value <= 0) {
      high = midpoint;
      highValue = value;
    } else {
      low = midpoint;
      lowValue = value;
    }
  }
  throw new CdsModelValidationError(`${label} solver did not converge`, 'solver-non-convergence');
}

/**
 * Converts an ICE clean EOD price into a model-derived par spread. This is an
 * ISDA-compatible deterministic estimator, not the licensed ICE/ISDA Standard
 * Model and not an official ICE spread quotation.
 */
export function cleanPriceToParSpread(input) {
  const contract = normalizeContract(input);
  if (contract.cleanPrice === undefined) throw new CdsModelValidationError('Clean EOD price is required');
  const upfrontFraction = (100 - contract.cleanPrice) / 100;
  const hazardRate = bisectRoot((hazard) => {
    const legs = legValues(hazard, contract);
    return legs.protectionLegPv - contract.couponRate * legs.riskyAnnuity - upfrontFraction;
  }, 'Price-to-spread');
  const legs = legValues(hazardRate, contract);
  const spreadBp = (legs.protectionLegPv / legs.riskyAnnuity) * 10_000;
  const modelUpfront = legs.protectionLegPv - contract.couponRate * legs.riskyAnnuity;
  const roundTripPrice = 100 * (1 - modelUpfront);
  return {
    spreadBp,
    roundTripPrice,
    priceResidual: Math.abs(roundTripPrice - contract.cleanPrice),
    hazardRate,
    curveId: contract.discountCurve.curveId,
    recoveryRate: contract.recoveryRate,
    stepInDate: isoDate(contract.stepInDate),
    cashSettlementDate: isoDate(contract.cashSettlementDate),
    modelVersion: MODEL_VERSION,
  };
}

/** Reverse-prices a coupon CDS from a target par spread using the same estimator. */
export function parSpreadToCleanPrice(input) {
  const contract = normalizeContract(input);
  if (contract.spreadBp === undefined) throw new CdsModelValidationError('Par spread is required');
  const targetSpread = contract.spreadBp / 10_000;
  const hazardRate = bisectRoot((hazard) => {
    const legs = legValues(hazard, contract);
    return legs.protectionLegPv / legs.riskyAnnuity - targetSpread;
  }, 'Spread-to-price');
  const legs = legValues(hazardRate, contract);
  const upfrontFraction = legs.protectionLegPv - contract.couponRate * legs.riskyAnnuity;
  return 100 * (1 - upfrontFraction);
}

