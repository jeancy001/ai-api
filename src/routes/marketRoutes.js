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
 */
router.post(
  "/refresh",
  auth,
  asyncHandler(marketController.refresh),
);

/* ============================================================
   LIVE MARKET PRICES
   IMPORTANT: Static routes must be before "/:symbol".
============================================================ */

/**
 * GET /api/v1/markets/prices
 *
 * Returns the latest available prices for active markets.
 *
 * The backend is responsible for communicating with Deriv,
 * caching, rate limiting, and normalizing provider responses.
 */
router.get(
  "/prices",
  auth,
  asyncHandler(marketController.prices),
);

/**
 * GET /api/v1/markets/:symbol/price
 *
 * Returns the latest real price for one Deriv symbol.
 *
 * Example:
 * GET /api/v1/markets/R_100/price
 */
router.get(
  "/:symbol/price",
  auth,
  asyncHandler(marketController.price),
);

/* ============================================================
   HISTORICAL OHLC CANDLES
============================================================ */

/**
 * GET /api/v1/markets/:symbol/candles
 *
 * Returns real historical OHLC candles from Deriv.
 *
 * Query parameters:
 * - granularity: candle duration in seconds
 * - count: number of candles
 * - start: optional Unix timestamp
 * - end: optional Unix timestamp
 *
 * Example:
 * /api/v1/markets/R_100/candles?granularity=60&count=100
 */
router.get(
  "/:symbol/candles",
  auth,
  asyncHandler(marketController.candles),
);

/* ============================================================
   CONTRACTS
============================================================ */

/**
 * GET /api/v1/markets/:symbol/contracts
 *
 * Returns contract metadata available for the requested
 * Deriv market symbol.
 */
router.get(
  "/:symbol/contracts",
  auth,
  asyncHandler(marketController.contracts),
);

/* ============================================================
   SINGLE MARKET
   IMPORTANT: Keep this dynamic catch-all route LAST.
============================================================ */

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