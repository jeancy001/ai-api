import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as tradingController from "../controllers/tradingController.js";

const router = Router();

/* ============================================================
   TRADING STATUS
============================================================ */

/**
 * Get the current trading status, settings, and selected account.
 *
 * GET /api/v1/trading/status
 */
router.get(
  "/status",
  auth,
  asyncHandler(tradingController.status),
);

/* ============================================================
   REAL MONEY TRADING AUTHORIZATION
============================================================ */

/**
 * Explicitly authorize real-money auto-trading.
 *
 * POST /api/v1/trading/authorize-real
 *
 * Requires explicit confirmation in the request body.
 * This does NOT start trading.
 */
router.post(
  "/authorize-real",
  auth,
  asyncHandler(tradingController.authorizeReal),
);

/* ============================================================
   AUTO-TRADING CONTROL
============================================================ */

/**
 * Start automatic trading.
 *
 * The controller must verify:
 * - Explicit real-trading authorization exists.
 * - A selected Deriv account exists.
 * - The selected account is REAL.
 * - Emergency stop is not active.
 *
 * POST /api/v1/trading/start
 */
router.post(
  "/start",
  auth,
  asyncHandler(tradingController.start),
);

/**
 * Stop automatic trading normally.
 *
 * POST /api/v1/trading/stop
 */
router.post(
  "/stop",
  auth,
  asyncHandler(tradingController.stop),
);

/**
 * Immediately activate the emergency stop.
 *
 * POST /api/v1/trading/emergency-stop
 */
router.post(
  "/emergency-stop",
  auth,
  asyncHandler(tradingController.emergency),
);

/* ============================================================
   TRADE HISTORY
============================================================ */

/**
 * Get the authenticated user's trade history.
 *
 * GET /api/v1/trading/trades?limit=50
 */
router.get(
  "/trades",
  auth,
  asyncHandler(tradingController.trades),
);

/**
 * Get one specific trade belonging to the authenticated user.
 *
 * GET /api/v1/trading/trades/:id
 */
router.get(
  "/trades/:id",
  auth,
  asyncHandler(tradingController.trade),
);

export default router;