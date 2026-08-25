function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    aliases: Object.freeze([...definition.aliases]),
    symbols: Object.freeze([...definition.symbols]),
  });
}

export const ICE_CDS_CONTRACT_REGISTRY = Object.freeze([
  freezeDefinition({
    company: 'Oracle',
    aliases: ['ORACLE CORP', 'ORACLE CORPORATION'],
    symbols: ['ORCL'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'CoreWeave',
    aliases: ['COREWEAVE', 'COREWEAVE INC', 'COREWEAVE, INC.'],
    symbols: ['CRWV'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 500,
  }),
  freezeDefinition({
    company: 'NVIDIA',
    aliases: ['NVIDIA CORP', 'NVIDIA CORPORATION'],
    symbols: ['NVDA'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'Amazon',
    aliases: ['AMAZON COM INC', 'AMAZON.COM INC', 'AMAZON INC'],
    symbols: ['AMZN'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'Google',
    aliases: ['ALPHABET INC', 'ALPHABET, INC.', 'GOOGLE INC', 'GOOGLE LLC'],
    symbols: ['GOOG', 'GOOGL'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'Microsoft',
    aliases: ['MICROSOFT CORP', 'MICROSOFT CORPORATION'],
    symbols: ['MSFT'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'Meta',
    aliases: ['META PLATFORMS INC', 'META PLATFORMS, INC.', 'META PLATFORMS'],
    symbols: ['META'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
]);
