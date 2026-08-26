import type { Fund } from '../../types/fund';

export interface PortfolioEntryState {
  market: Fund['market'];
  isViewingDashboard: boolean;
}

export function createPortfolioEntryState(): PortfolioEntryState {
  return {
    market: 'a',
    isViewingDashboard: true,
  };
}
