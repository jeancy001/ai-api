import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as tradingController from "../controllers/tradingController.js";

const router = Router();

/* ============================================================
   TRADING STATUS
============================================================ */

/**
 * Get the current trading engine status, trading settings,
 * selected Deriv account, and authorization state.
 *
 * GET /api/v1/trading/status
 */
router.get(
  "/status",
  auth,
  asyncHandler(tradingController.status),
);

/* ============================================================
   REAL-MONEY TRADING AUTHORIZATION
============================================================ */

/**
 * Explicitly authorize real-money automatic trading.
 *
 * This endpoint does NOT start the trading engine.
 * The user must provide the required explicit confirmation.
 *
 * POST /api/v1/trading/authorize-real
 */
router.post(
  "/authorize-real",
  auth,
  asyncHandler(tradingController.authorizeReal),
);

/* ============================================================
   AUTO-TRADING ENGINE
============================================================ */

/**
 * Start automatic trading.
 *
 * Backend validation includes:
 * - authenticated user
 * - explicit real-money authorization
 * - selected REAL Deriv account
 * - connected account
 * - emergency stop is not active
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
 * Existing positions are monitored according to backend policy,
 * but no new automated trades should be opened after this request.
 *
 * POST /api/v1/trading/stop
 */
router.post(
  "/stop",
  auth,
  asyncHandler(tradingController.stop),
);

/**
 * Activate the emergency stop immediately.
 *
 * This blocks new automatic trades until the emergency stop
 * is reset through a dedicated protected workflow.
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
 * Get authenticated user's trade history.
 *
 * GET /api/v1/trading/trades?limit=50
 */
router.get(
  "/trades",
  auth,
  asyncHandler(tradingController.trades),
);

/**
 * Get one trade belonging to the authenticated user.
 *
 * GET /api/v1/trading/trades/:id
 */
router.get(
  "/trades/:id",
  auth,
  asyncHandler(tradingController.trade),
);

export default router;