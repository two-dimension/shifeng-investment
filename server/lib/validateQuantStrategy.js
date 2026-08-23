const REQUIRED_EXPORTS = [
  'getQuantExperiments',
  'getQuantOverview',
  'runQuantBacktest',
  'runQuantHistoryBackfill',
  'runQuantIteration',
];

export function isExactMissingOptionalModuleError(error, optionalModuleUrl) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' && error?.url === optionalModuleUrl;
}

export function validateQuantStrategyExports(quantStrategy) {
  for (const name of REQUIRED_EXPORTS) {
    if (typeof quantStrategy[name] !== 'function') {
      throw new TypeError(`Quant strategy module export ${name} must be a function`);
    }
  }
  return quantStrategy;
}
