import { Router } from "express";

import * as marketController from "../controllers/marketController.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { auth } from "../middleware/auth.js";

const router = Router();

/* ============================================================
   DERIV MARKETS
============================================================ */

/**
 * Get all available/active Deriv markets.
 *
 * GET /markets
 */
router.get(
  "/",
  auth,
  asyncHandler(marketController.list),
);

/**
 * Refresh the market list.
 *
 * This currently retrieves fresh data using the same logic as list.
 * POST /markets/refresh
 */
router.post(
  "/refresh",
  auth,
  asyncHandler(marketController.refresh),
);

/**
 * Get available contracts for a specific market.
 *
 * GET /markets/:symbol/contracts
 *
 * This route must be registered before /:symbol for clarity.
 */
router.get(
  "/:symbol/contracts",
  auth,
  asyncHandler(marketController.contracts),
);

/**
 * Get details for a single market.
 *
 * GET /markets/:symbol
 */
router.get(
  "/:symbol",
  auth,
  asyncHandler(marketController.one),
);

export default router;