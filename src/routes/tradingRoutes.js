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
* * authenticated user
* * explicit real-money authorization
* * selected REAL Deriv account
* * connected account
* * emergency stop is not active
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
* No new automated trades should be opened after this request.
* Emergency Stop is NOT activated by a normal stop.
*
* POST /api/v1/trading/stop
  */
  router.post(
  "/stop",
  auth,
  asyncHandler(tradingController.stop),
  );

/* ============================================================
EMERGENCY STOP CONTROLS
============================================================ */

/**

* Activate the emergency stop immediately.
*
* This immediately blocks new automatic trades and stops the
* local trading scheduler. Trading remains blocked until the
* authenticated user explicitly releases Emergency Stop.
*
* POST /api/v1/trading/emergency-stop
  */
  router.post(
  "/emergency-stop",
  auth,
  asyncHandler(tradingController.emergency),
  );

/**

* Release Emergency Stop.
*
* IMPORTANT:
* * Removes ONLY the emergency execution block.
* * Does NOT automatically start auto-trading.
* * Auto-trading remains disabled until the user explicitly
* sends POST /api/v1/trading/start.
* * The backend validates the selected REAL Deriv account before
* releasing the emergency state.
*
* POST /api/v1/trading/release-emergency-stop
  */
  router.post(
  "/release-emergency-stop",
  auth,
  asyncHandler(tradingController.releaseEmergencyStop),
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
