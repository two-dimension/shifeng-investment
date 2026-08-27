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
    aliases: ['ORACLE COP', 'ORACLE CORP', 'ORACLE CORPORATION'],
    symbols: ['ORCLE', 'ORCL'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
  freezeDefinition({
    company: 'CoreWeave',
    aliases: ['COREWEAVE', 'COREWEAVE INC', 'COREWEAVE, INC.'],
    symbols: ['COREWEI', 'CRWV'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 500,
  }),
  freezeDefinition({
    company: 'NVIDIA',
    aliases: ['NVIDIA CORP', 'NVIDIA CORPORATION'],
    symbols: ['NVIDIA', 'NVDA'],
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
    symbols: ['ALPHINC', 'GOOG', 'GOOGL'],
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
    symbols: ['METAPL', 'META'],
    currency: 'USD',
    tier: 'SNRFOR',
    restructuring: 'XR14',
    couponBp: 100,
  }),
]);
