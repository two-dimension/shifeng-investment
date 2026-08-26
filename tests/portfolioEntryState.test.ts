import assert from 'node:assert/strict';
import test from 'node:test';

type PortfolioEntryStateModule = {
  createPortfolioEntryState?: () => {
    market: 'a' | 'hk' | 'us' | 'jp' | 'kr';
    isViewingDashboard: boolean;
  };
};

let portfolioEntryState: PortfolioEntryStateModule = {};
try {
  portfolioEntryState = await import('../src/pages/Portfolio/portfolioEntryState.ts');
} catch {
  // The assertion below reports the missing entry-state behavior clearly.
}

test('opens the subset dashboard on the A-share market', () => {
  assert.equal(typeof portfolioEntryState.createPortfolioEntryState, 'function');
  assert.deepEqual(portfolioEntryState.createPortfolioEntryState!(), {
    market: 'a',
    isViewingDashboard: true,
  });
});
