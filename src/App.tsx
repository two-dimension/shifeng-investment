import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { MainLayout } from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { HomePanel, PortfolioPanel, PortfolioAnomalyPanel, NewsPanel, CalendarPanel, AIDashboardPanel, StockDetailPanel, MACDPanel, TMTMarginPanel, ResearchPanel } from './pages';

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<MainLayout />}>
              <Route index element={<Navigate to="/home" replace />} />
              <Route path="home" element={<HomePanel />} />
              <Route path="news" element={<NewsPanel />} />
              <Route path="calendar" element={<CalendarPanel />} />
              <Route path="ai-dashboard" element={<AIDashboardPanel />} />
              <Route path="portfolio" element={<PortfolioPanel />} />
              <Route path="portfolio/anomaly/:fundId" element={<PortfolioAnomalyPanel />} />
              <Route path="macd" element={<MACDPanel />} />
              <Route path="tmt-margin" element={<TMTMarginPanel />} />
              <Route path="research" element={<ResearchPanel />} />
              <Route path="stock/:code" element={<StockDetailPanel />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </ThemeProvider>
  );
};

export default App;
