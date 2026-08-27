import express from 'express';
import {
  CalendarDataError,
  DEFAULT_CALENDAR_FILE,
  DEFAULT_FUNDS_FILE,
  readCalendarStore,
  selectCalendarEvents,
  validateCalendarRange,
} from '../lib/calendarStore.js';
import { refreshCalendar } from '../lib/calendarRefresh.js';

function sendCalendarError(res, error) {
  if (error instanceof CalendarDataError) {
    return res.status(error.status || 500).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  console.error('[calendar] unexpected error:', error);
  return res.status(500).json({
    success: false,
    error: {
      code: 'CALENDAR_INTERNAL_ERROR',
      message: 'Calendar data could not be loaded',
    },
  });
}

export function createCalendarRouter({
  dataFile = DEFAULT_CALENDAR_FILE,
  fundsFile = DEFAULT_FUNDS_FILE,
  now = () => new Date(),
  fetchImpl,
  refreshCalendar: refreshCalendarData = refreshCalendar,
} = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { start, end, days } = validateCalendarRange(req.query.start, req.query.end);
      const store = await readCalendarStore({ dataFile, fundsFile });
      const events = selectCalendarEvents(store.events, start, end);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        success: true,
        schemaVersion: store.schemaVersion,
        range: { start, end, days },
        updatedAt: store.updatedAt,
        generatedAt: now().toISOString(),
        sources: store.sources,
        count: events.length,
        events,
      });
    } catch (error) {
      return sendCalendarError(res, error);
    }
  });

  router.post('/refresh', async (req, res) => {
    try {
      const { start, end, days } = validateCalendarRange(req.query.start, req.query.end);
      const refreshed = await refreshCalendarData({
        dataFile,
        start,
        end,
        fetchImpl,
        now,
      });
      const store = await readCalendarStore({ dataFile, fundsFile });
      const events = selectCalendarEvents(store.events, start, end);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        success: true,
        refreshMode: 'manual',
        refreshed,
        range: { start, end, days },
        updatedAt: store.updatedAt,
        sources: store.sources,
        count: events.length,
        events,
      });
    } catch (error) {
      return sendCalendarError(res, error);
    }
  });

  return router;
}

export default createCalendarRouter();
