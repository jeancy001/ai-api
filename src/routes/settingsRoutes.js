import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as settingsController from "../controllers/settingsController.js";

const router = Router();

/* ============================================================
   TRADING SETTINGS
============================================================ */

/**
 * GET /api/v1/settings/trading
 *
 * Get the authenticated user's trading configuration.
 *
 * If settings do not exist yet, the controller may safely create
 * default settings with auto-trading disabled.
 */
router.get(
  "/trading",
  auth,
  asyncHandler(settingsController.get),
);

/**
 * PUT /api/v1/settings/trading
 *
 * Update user-configurable trading and risk settings.
 *
 * The controller MUST whitelist fields and validate all values.
 *
 * Security-sensitive fields must never be directly writable by
 * the frontend, including:
 * - autoTradingEnabled
 * - realTradingAuthorized
 * - emergencyStop
 * - stopReason
 * - authorization timestamps
 */
router.put(
  "/trading",
  auth,
  asyncHandler(settingsController.update),
);

export default router;