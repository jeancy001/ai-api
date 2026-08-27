import { derivMarketService } from "../services/DerivMarketService.js";
import { AppError } from "../utils/AppError.js";

/**
 * Validate and normalize a market symbol received from the URL.
 */
function getSymbol(req) {
  const symbol =
    typeof req.params?.symbol === "string"
      ? req.params.symbol.trim().toUpperCase()
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
 * Parse and safely limit a numeric query parameter.
 */
function getLimit(value, fallback = 100, max = 1000) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(Math.floor(parsed), 1),
    max,
  );
}

/**
 * Normalize market data for the frontend.
 *
 * Keeps the original Deriv data while exposing commonly used fields
 * consistently.
 */
function serializeMarket(market) {
  if (!market) return null;

  return {
    symbol: market.symbol || null,

    displayName:
      market.display_name ||
      market.displayName ||
      market.symbol ||
      null,

    market:
      market.market ||
      market.market_display_name ||
      null,

    marketDisplayName:
      market.market_display_name ||
      market.market ||
      null,

    subgroup:
      market.subgroup ||
      market.subgroup_display_name ||
      null,

    subgroupDisplayName:
      market.subgroup_display_name ||
      market.subgroup ||
      null,

    exchangeIsOpen:
      market.exchange_is_open === 1 ||
      market.exchange_is_open === true,

    pip:
      market.pip ??
      null,

    /**
     * Price is populated when the market service provides a quote.
     * active_symbols itself does not necessarily contain live prices.
     */
    price:
      market.price ??
      market.quote ??
      null,

    /**
     * Keep the complete Deriv metadata available for future frontend use.
     */
    raw: market,
  };
}

/**
 * GET /markets
 *
 * Query parameters:
 *
 * ?limit=100
 * ?market=Forex
 * ?search=Volatility
 *
 * Returns currently available Deriv markets.
 */
export async function list(req, res) {
  const limit = getLimit(req.query.limit, 500);

  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().toLowerCase()
      : "";

  const marketFilter =
    typeof req.query.market === "string"
      ? req.query.market.trim().toLowerCase()
      : "";

  const markets =
    await derivMarketService.activeSymbols();

  let filtered = Array.isArray(markets)
    ? markets
    : [];

  /**
   * Optional category/market filtering.
   */
  if (marketFilter) {
    filtered = filtered.filter((item) => {
      const marketName = String(
        item.market ||
        item.market_display_name ||
        "",
      ).toLowerCase();

      return marketName.includes(marketFilter);
    });
  }

  /**
   * Search by symbol or display name.
   */
  if (search) {
    filtered = filtered.filter((item) => {
      const haystack = [
        item.symbol,
        item.display_name,
        item.market,
        item.market_display_name,
        item.subgroup,
        item.subgroup_display_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });
  }

  const total = filtered.length;

  const data = filtered
    .slice(0, limit)
    .map(serializeMarket);

  return res.status(200).json({
    success: true,

    data,

    meta: {
      total,
      returned: data.length,
      limit,
      search: search || null,
      market: marketFilter || null,
    },
  });
}

/**
 * GET /markets/:symbol
 *
 * Returns detailed information about one Deriv market.
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

  /**
   * If the service supports retrieving a current quote,
   * include it without making it mandatory.
   */
  let price = null;

  try {
    if (
      typeof derivMarketService.price === "function"
    ) {
      price =
        await derivMarketService.price(symbol);
    }
  } catch (error) {
    /**
     * Market details should still work if a live price is
     * temporarily unavailable.
     */
    console.warn(
      `Unable to retrieve price for ${symbol}:`,
      error?.message || error,
    );
  }

  const data = serializeMarket({
    ...market,
    price:
      price?.quote ??
      price?.price ??
      price ??
      null,
  });

  return res.status(200).json({
    success: true,
    data,
  });
}

/**
 * GET /markets/:symbol/contracts
 *
 * Returns available contract types for a specific market.
 *
 * IMPORTANT:
 * Contract availability is not the same thing as active symbols.
 * The DerivMarketService should query contract availability from
 * Deriv instead of filtering active_symbols.
 */
export async function contracts(req, res) {
  const symbol = getSymbol(req);

  /**
   * Verify the symbol exists first.
   */
  const market =
    await derivMarketService.symbol(symbol);

  if (!market) {
    throw new AppError(
      `Market "${symbol}" was not found`,
      404,
      "MARKET_NOT_FOUND",
    );
  }

  const contracts =
    await derivMarketService.contractsFor(symbol);

  return res.status(200).json({
    success: true,

    data: Array.isArray(contracts)
      ? contracts
      : [],

    meta: {
      symbol,
      total: Array.isArray(contracts)
        ? contracts.length
        : 0,
    },
  });
}

/**
 * POST /markets/refresh
 *
 * Refreshes cached Deriv market data.
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

  const data = Array.isArray(markets)
    ? markets.map(serializeMarket)
    : [];

  return res.status(200).json({
    success: true,
    message: "Markets refreshed successfully",

    data,

    meta: {
      total: data.length,
      refreshedAt: new Date().toISOString(),
    },
  });
}