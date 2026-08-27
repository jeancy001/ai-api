import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as settingsController from "../controllers/settingsController.js";

const router = Router();

/* ============================================================
   TRADING SETTINGS
============================================================ */

/**
 * Get the authenticated user's trading settings.
 *
 * GET /api/v1/settings/trading
 */
router.get(
  "/trading",
  auth,
  asyncHandler(settingsController.get),
);

/**
 * Update allowed trading settings.
 *
 * PUT /api/v1/settings/trading
 *
 * The controller must whitelist editable fields and must never allow
 * sensitive server-side fields to be modified directly by the client,
 * such as realTradingAuthorized or emergencyStop.
 */
router.put(
  "/trading",
  auth,
  asyncHandler(settingsController.update),
);

export default router;