import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

import * as derivAccountController from "../controllers/derivAccountController.js";
import * as balanceController from "../controllers/balanceController.js";

const router = Router();

/* ============================================================
   DERIV OAUTH CONNECTION
============================================================ */

/**
 * Start the secure Deriv OAuth authorization flow.
 *
 * GET /api/v1/account/deriv/connect
 *
 * The authenticated user receives the Deriv authorization URL.
 * The frontend should redirect the user to that URL.
 */
router.get(
  "/connect",
  auth,
  asyncHandler(derivAccountController.connect),
);

/**
 * Deriv OAuth callback.
 *
 * GET /api/v1/account/deriv/callback
 *
 * This endpoint intentionally does NOT use the application's auth
 * middleware because the browser is redirected here by Deriv.
 *
 * The controller MUST validate the OAuth state and PKCE verifier
 * before exchanging the authorization code.
 */
router.get(
  "/callback",
  asyncHandler(derivAccountController.callback),
);

/* ============================================================
   DERIV ACCOUNTS
============================================================ */

/**
 * Get all Deriv accounts connected to the authenticated user.
 *
 * GET /api/v1/account/deriv/accounts
 */
router.get(
  "/accounts",
  auth,
  asyncHandler(derivAccountController.accounts),
);

/**
 * Select the active Deriv account.
 *
 * POST /api/v1/account/deriv/select-account
 *
 * The request body and account ownership must be validated by
 * the controller. Selecting an account does NOT authorize
 * real-money automatic trading.
 */
router.post(
  "/select-account",
  auth,
  asyncHandler(derivAccountController.select),
);

/**
 * Get the currently selected Deriv account and connection status.
 *
 * GET /api/v1/account/deriv/connection
 */
router.get(
  "/connection",
  auth,
  asyncHandler(derivAccountController.connection),
);

/* ============================================================
   ACCOUNT BALANCE
============================================================ */

/**
 * Get the balance of the currently selected account.
 *
 * GET /api/v1/account/deriv/balance
 *
 * The controller/service may return a recently cached balance or
 * retrieve the current balance according to backend policy.
 */
router.get(
  "/balance",
  auth,
  asyncHandler(balanceController.getBalance),
);

/**
 * Explicitly request a fresh balance from Deriv.
 *
 * POST /api/v1/account/deriv/balance/refresh
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
 * Safely disconnect the user's selected Deriv connection.
 *
 * POST /api/v1/account/deriv/disconnect
 *
 * The controller should ensure that disconnecting an account cannot
 * leave an active auto-trading worker running.
 */
router.post(
  "/disconnect",
  auth,
  asyncHandler(derivAccountController.disconnect),
);

export default router;