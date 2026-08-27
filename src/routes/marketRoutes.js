import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as marketController from "../controllers/marketController.js";

const router = Router();

/* ============================================================
   DERIV MARKETS
============================================================ */

/**
 * GET /api/v1/markets
 *
 * Returns all active markets currently available from Deriv.
 *
 * Optional query parameters can be added later for:
 * - marketType
 * - underlyingType
 * - search
 */
router.get(
  "/",
  auth,
  asyncHandler(marketController.list),
);

/**
 * POST /api/v1/markets/refresh
 *
 * Explicitly refreshes market data from Deriv.
 *
 * The backend remains responsible for caching and rate limiting
 * external API requests.
 */
router.post(
  "/refresh",
  auth,
  asyncHandler(marketController.refresh),
);

/**
 * GET /api/v1/markets/:symbol/contracts
 *
 * Returns the contract types or contract metadata available for
 * the requested Deriv market symbol.
 *
 * IMPORTANT: This route must appear before "/:symbol".
 */
router.get(
  "/:symbol/contracts",
  auth,
  asyncHandler(marketController.contracts),
);

/**
 * GET /api/v1/markets/:symbol
 *
 * Returns details for one active Deriv market.
 *
 * Examples:
 * - R_100
 * - frxEURUSD
 */
router.get(
  "/:symbol",
  auth,
  asyncHandler(marketController.one),
);

export default router;