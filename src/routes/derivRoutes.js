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
 * Requires application authentication. The backend creates the
 * OAuth state and PKCE verifier and returns the Deriv authorization
 * URL. The frontend redirects the user to that URL.
 */
router.get(
  "/connect",
  auth,
  asyncHandler(derivAccountController.connect)
);

/**
 * Handle the Deriv OAuth callback.
 *
 * GET /api/v1/account/deriv/callback
 *
 * This route intentionally does NOT use the application's auth
 * middleware because Deriv redirects the user's browser here.
 *
 * The controller must validate and consume the OAuth state and PKCE
 * verifier before exchanging the authorization code.
 */
router.get(
  "/callback",
  asyncHandler(derivAccountController.callback)
);

/* ============================================================
   DERIV ACCOUNT CONNECTIONS
============================================================ */

/**
 * Get all Deriv accounts connected to the authenticated user.
 *
 * GET /api/v1/account/deriv/accounts
 *
 * MongoDB provides secure ownership and connection metadata.
 * Sensitive credentials are never returned to the client.
 */
router.get(
  "/accounts",
  auth,
  asyncHandler(derivAccountController.accounts)
);

/**
 * Select the REAL Deriv account to use for real-money trading.
 *
 * POST /api/v1/account/deriv/select-account
 *
 * The controller must verify ownership and should verify the account
 * against Deriv before making it the selected account.
 *
 * Selecting an account alone MUST NOT authorize or start
 * real-money automatic trading.
 */
router.post(
  "/select-account",
  auth,
  asyncHandler(derivAccountController.select)
);

/**
 * Get the currently selected Deriv account connection status.
 *
 * GET /api/v1/account/deriv/connection
 *
 * This endpoint returns connection metadata only and never exposes
 * encrypted credentials or access tokens.
 */
router.get(
  "/connection",
  auth,
  asyncHandler(derivAccountController.connection)
);

/* ============================================================
   LIVE DERIV BALANCE
============================================================ */

/**
 * Get the CURRENT LIVE balance of the selected REAL Deriv account.
 *
 * GET /api/v1/account/deriv/balance
 *
 * IMPORTANT:
 * The balance must be retrieved directly from Deriv.
 * MongoDB must NOT be used as a balance source or fallback.
 */
router.get(
  "/balance",
  auth,
  asyncHandler(balanceController.getBalance)
);

/**
 * Explicitly fetch the latest LIVE balance directly from Deriv.
 *
 * POST /api/v1/account/deriv/balance/refresh
 *
 * MongoDB may be used to retrieve the encrypted credentials and
 * selected account ID, but the returned balance itself must come
 * directly from Deriv.
 */
router.post(
  "/balance/refresh",
  auth,
  asyncHandler(balanceController.refreshBalance)
);

/* ============================================================
   DISCONNECT
============================================================ */

/**
 * Safely disconnect a Deriv account.
 *
 * POST /api/v1/account/deriv/disconnect
 *
 * The controller must verify ownership. If the disconnected account
 * is selected or is being used by the auto-trading engine, trading
 * must be stopped safely before the credentials are removed.
 */
router.post(
  "/disconnect",
  auth,
  asyncHandler(derivAccountController.disconnect)
);

export default router;