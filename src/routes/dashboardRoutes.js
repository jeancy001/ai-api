import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { dashboard } from "../controllers/dashboardController.js";

const router = Router();

/* ============================================================
   DASHBOARD
============================================================ */

/**
 * Get the authenticated user's dashboard data.
 *
 * Includes:
 * - Selected Deriv account
 * - Cached/latest account balance
 * - Trading settings and current automation status
 * - Recent trades
 * - Open positions (when available)
 * - Latest AI analysis (when available)
 *
 * GET /api/v1/dashboard
 */
router.get(
  "/",
  auth,
  asyncHandler(dashboard),
);

export default router;