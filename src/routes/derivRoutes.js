import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

import * as derivAccountController from "../controllers/derivAccountController.js";
import * as balanceController from "../controllers/balanceController.js";

const router = Router();

/* ============================================================
   DERIV CONNECTION
============================================================ */

/**
 * Start the secure Deriv OAuth authorization flow.
 *
 * The frontend calls this endpoint and receives the authorization URL.
 *
 * GET is used here to remain compatible with the current frontend:
 * GET /api/v1/account/deriv/connect
 */
router.get(
  "/connect",
  auth,
  asyncHandler(derivAccountController.connect),
);

/**
 * OAuth callback from Deriv.
 *
 * This route must NOT require the application's JWT because the
 * browser is redirected here directly by Deriv.
 *
 * Make sure this exact URL is registered as your OAuth redirect URI:
 * /api/v1/account/deriv/callback
 */
router.get(
  "/callback",
  asyncHandler(derivAccountController.callback),
);

/**
 * Get all Deriv accounts connected by the authenticated user.
 */
router.get(
  "/accounts",
  auth,
  asyncHandler(derivAccountController.accounts),
);

/**
 * Select one REAL Deriv account for live auto-trading.
 */
router.post(
  "/select-account",
  auth,
  asyncHandler(derivAccountController.select),
);

/**
 * Get the selected Deriv account and connection status.
 */
router.get(
  "/connection",
  auth,
  asyncHandler(derivAccountController.connection),
);

/* ============================================================
   BALANCE
============================================================ */

/**
 * Get the current/cached balance for the selected account.
 */
router.get(
  "/balance",
  auth,
  asyncHandler(balanceController.getBalance),
);

/**
 * Explicitly refresh the selected account balance from Deriv.
 */
router.post(
  "/balance/refresh",
  auth,
  asyncHandler(balanceController.refreshBalance),
);

/* ============================================================
   DISCONNECT
============================================================ */

/**
 * Safely disconnect the user's Deriv account.
 */
router.post(
  "/disconnect",
  auth,
  asyncHandler(derivAccountController.disconnect),
);

export default router;