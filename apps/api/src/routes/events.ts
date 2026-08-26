// Argo's event list, for the expense form's event picker.
//
// Read-only and best-effort: an unset TRADESHOW_DATABASE_URL or an unreachable
// Argo database returns an empty list with available:false, exactly as
// /accountant/upcoming-events does. The picker hides itself rather than
// showing an empty dropdown, and expense entry keeps working.

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { isTradeShowLinkEnabled, listSelectableEvents } from '../lib/tradeShowEvents';
import { localTodayIso } from '../lib/cashLedger';

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (_req, res) => {
  if (!isTradeShowLinkEnabled()) {
    res.json({ events: [], available: false });
    return;
  }

  try {
    const events = await listSelectableEvents(localTodayIso());
    res.json({ events, available: true });
  } catch (err) {
    console.error('[events] trade show lookup failed:', err);
    res.json({ events: [], available: false });
  }
}));

export default router;
