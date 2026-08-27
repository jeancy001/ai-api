import { Router } from "express";

import { auth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as marketController from "../controllers/marketController.js";

const router = Router();

/* ============================================================
MARKET CATALOGUE
============================================================ */

router.get(
"/",
auth,
asyncHandler(marketController.list)
);

router.post(
"/refresh",
auth,
asyncHandler(marketController.refresh)
);

/* ============================================================
STATIC LIVE PRICE ROUTES
MUST BE BEFORE /:symbol
============================================================ */

router.get(
"/prices",
auth,
asyncHandler(marketController.prices)
);

/* ============================================================
SYMBOL-SPECIFIC ROUTES
============================================================ */

router.get(
"/:symbol/price",
auth,
asyncHandler(marketController.price)
);

router.get(
"/:symbol/candles",
auth,
asyncHandler(marketController.candles)
);

router.get(
"/:symbol/contracts",
auth,
asyncHandler(marketController.contracts)
);

/**

* Dynamic catch-all route must always remain last.
  */
  router.get(
  "/:symbol",
  auth,
  asyncHandler(marketController.one)
  );

export default router;
