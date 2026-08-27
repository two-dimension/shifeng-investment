function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round(value) {
  return Number(value.toFixed(12));
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff.]+/g, '-').replace(/^-+|-+$/g, '');
}

export function calculateTaskCost({ inputTokens, cachedInputTokens, outputTokens, price } = {}) {
  const input = finiteNonNegative(inputTokens);
  const cached = finiteNonNegative(cachedInputTokens);
  const output = finiteNonNegative(outputTokens);
  const inputRate = finiteNonNegative(price?.input);
  const cachedRate = finiteNonNegative(price?.cachedInput);
  const outputRate = finiteNonNegative(price?.output);
  const perTokens = finiteNonNegative(price?.perTokens);
  const currency = String(price?.currency || '').trim().toUpperCase();
  if ([input, cached, output, inputRate, cachedRate, outputRate, perTokens].some((value) => value === null)
    || perTokens === 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  const inputCost = round((input / perTokens) * inputRate);
  const cachedInputCost = round((cached / perTokens) * cachedRate);
  const outputCost = round((output / perTokens) * outputRate);
  return {
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost: round(inputCost + cachedInputCost + outputCost),
    currency,
  };
}

function comparableTaskKey(run) {
  if (!run?.taskName || !run?.taskVersion || !run?.harness) return null;
  return [run.taskName, run.taskVersion, run.harness].map(slug).join('|');
}

function sameSku(run, price) {
  return run.vendor === price.vendor && run.model === price.model
    && (!run.contextTier || run.contextTier === (price.contextTier || 'standard'))
    && (!run.serviceTier || run.serviceTier === (price.serviceTier || 'standard'));
}

export function attachOfficialTaskCosts({ runs = [], prices = [] } = {}) {
  return runs.map((run) => {
    const key = comparableTaskKey(run);
    if ([run.inputTokens, run.cachedInputTokens, run.outputTokens].some((value) => finiteNonNegative(value) === null)) {
      return { ...run, comparableTaskKey: key, status: 'tokens_unavailable', totalCost: null };
    }
    const candidates = prices.filter((price) => sameSku(run, price)
      && price.priceUnit === 'per_million_tokens'
      && String(price.asOf || '') <= String(run.asOf || ''))
      .sort((left, right) => String(right.asOf).localeCompare(String(left.asOf)));
    const price = candidates[0];
    if (!price) return { ...run, comparableTaskKey: key, status: 'price_unavailable', totalCost: null };
    const cost = calculateTaskCost({
      inputTokens: run.inputTokens,
      cachedInputTokens: run.cachedInputTokens,
      outputTokens: run.outputTokens,
      price: {
        input: price.inputPrice,
        cachedInput: price.cacheReadPrice,
        output: price.outputPrice,
        currency: price.currency,
        perTokens: 1_000_000,
      },
    });
    if (!cost) return { ...run, comparableTaskKey: key, status: 'price_unavailable', totalCost: null };
    return {
      ...run,
      ...cost,
      comparableTaskKey: key,
      status: 'ready',
      priceAsOf: price.asOf,
      priceSourceLabel: price.sourceLabel,
      priceSourceUrl: price.sourceUrl,
    };
  });
}
