import { derivMarketService } from "../services/DerivMarketService.js";
import { AppError } from "../utils/AppError.js";

/**
 * Validate and normalize a market symbol received from the URL.
 */
function getSymbol(req) {
  const symbol =
    typeof req.params?.symbol === "string"
      ? req.params.symbol.trim()
      : "";

  if (!symbol) {
    throw new AppError(
      "A market symbol is required",
      400,
      "VALIDATION_ERROR",
    );
  }

  return symbol;
}

/**
 * GET /markets
 *
 * Returns all currently available markets from Deriv.
 */
export async function list(req, res) {
  const markets =
    await derivMarketService.activeSymbols();

  return res.json({
    success: true,
    data: Array.isArray(markets) ? markets : [],
  });
}

/**
 * GET /markets/:symbol
 *
 * Returns one specific market.
 */
export async function one(req, res) {
  const symbol = getSymbol(req);

  const market =
    await derivMarketService.symbol(symbol);

  if (!market) {
    throw new AppError(
      `Market "${symbol}" was not found`,
      404,
      "MARKET_NOT_FOUND",
    );
  }

  return res.json({
    success: true,
    data: market,
  });
}

/**
 * GET /markets/:symbol/contracts
 *
 * Returns the contracts available for a specific symbol.
 */
export async function contracts(req, res) {
  const symbol = getSymbol(req);

  const contracts =
    await derivMarketService.contractsFor(symbol);

  return res.json({
    success: true,
    data: contracts,
  });
}

/**
 * POST /markets/refresh
 *
 * Refreshes cached market data when the service supports caching.
 * Falls back to fetching the latest symbols directly.
 */
export async function refresh(req, res) {
  let markets;

  if (
    typeof derivMarketService.refresh ===
    "function"
  ) {
    markets =
      await derivMarketService.refresh();
  } else {
    markets =
      await derivMarketService.activeSymbols();
  }

  return res.json({
    success: true,
    message: "Markets refreshed successfully",
    data: Array.isArray(markets) ? markets : [],
  });
}