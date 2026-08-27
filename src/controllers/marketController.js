import { derivMarketService } from "../services/DerivMarketService.js";
import { AppError } from "../utils/AppError.js";

/* ============================================================
   VALIDATION & NORMALIZATION
============================================================ */

/**
 * Validate and normalize a market symbol received from the URL.
 *
 * Do not force uppercase here. Some Deriv symbols can contain
 * lowercase characters (for example, frxEURUSD), and changing
 * the symbol can cause provider lookup failures.
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
 * Parse an optional positive integer.
 */
function getOptionalNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(
    Math.max(Math.floor(parsed), min),
    max,
  );
}

/**
 * Normalize a value that may be a number or numeric string.
 * We deliberately preserve numeric strings because the frontend
 * supports both numbers and strings from the provider.
 */
function getNumericValue(value) {
  if (
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  return undefined;
}

/* ============================================================
   MARKET SERIALIZATION
============================================================ */

/**
 * Normalize market data for the frontend.
 */
function serializeMarket(market) {
  if (!market) return null;

  return {
    id: market.id || market.symbol || null,

    symbol: market.symbol || null,

    display_name:
      market.display_name ||
      market.displayName ||
      market.symbol ||
      null,

    displayName:
      market.displayName ||
      market.display_name ||
      market.symbol ||
      null,

    market: market.market || null,

    submarket:
      market.submarket ||
      market.subgroup ||
      market.submarket_display_name ||
      market.subgroup_display_name ||
      null,

    market_display_name:
      market.market_display_name ||
      market.market ||
      null,

    submarket_display_name:
      market.submarket_display_name ||
      market.subgroup_display_name ||
      market.submarket ||
      market.subgroup ||
      null,

    symbol_type: market.symbol_type || null,

    exchange_is_open:
      market.exchange_is_open === 1 ||
      market.exchange_is_open === true,

    isTradingAvailable:
      market.exchange_is_open === 1 ||
      market.exchange_is_open === true,

    currency: market.currency || null,

    price:
      getNumericValue(
        market.price ??
        market.quote ??
        market.latestPrice ??
        market.lastPrice,
      ) ?? null,

    latestPrice:
      getNumericValue(
        market.latestPrice ??
        market.price ??
        market.quote,
      ) ?? null,

    lastPrice:
      getNumericValue(
        market.lastPrice ??
        market.price ??
        market.quote,
      ) ?? null,

    quote:
      getNumericValue(
        market.quote ??
        market.price,
      ) ?? null,

    bid: getNumericValue(market.bid) ?? null,
    ask: getNumericValue(market.ask) ?? null,

    change: getNumericValue(market.change) ?? null,

    changePercent:
      getNumericValue(
        market.changePercent ??
        market.change_percent,
      ) ?? null,

    previousClose:
      getNumericValue(
        market.previousClose ??
        market.previous_close,
      ) ?? null,

    open: getNumericValue(market.open) ?? null,

    updatedAt:
      market.updatedAt ||
      market.updated_at ||
      null,
  };
}

/**
 * Normalize a real Deriv quote for the frontend.
 */
function serializePrice(price, fallbackSymbol = null) {
  if (!price) return null;

  /**
   * Some service implementations may return the quote directly.
   */
  if (
    typeof price === "number" ||
    typeof price === "string"
  ) {
    return {
      symbol: fallbackSymbol,
      price,
      quote: price,
      latestPrice: price,
    };
  }

  return {
    symbol:
      price.symbol ||
      price.underlying_symbol ||
      fallbackSymbol ||
      null,

    price:
      getNumericValue(
        price.price ??
        price.quote ??
        price.lastPrice ??
        price.last_price,
      ) ?? null,

    latestPrice:
      getNumericValue(
        price.latestPrice ??
        price.price ??
        price.quote ??
        price.last_price,
      ) ?? null,

    lastPrice:
      getNumericValue(
        price.lastPrice ??
        price.last_price ??
        price.price ??
        price.quote,
      ) ?? null,

    quote:
      getNumericValue(
        price.quote ??
        price.price ??
        price.last_price,
      ) ?? null,

    bid: getNumericValue(price.bid) ?? null,
    ask: getNumericValue(price.ask) ?? null,

    change: getNumericValue(price.change) ?? null,

    changePercent:
      getNumericValue(
        price.changePercent ??
        price.change_percent,
      ) ?? null,

    previousClose:
      getNumericValue(
        price.previousClose ??
        price.previous_close,
      ) ?? null,

    currency: price.currency || null,

    epoch:
      price.epoch ??
      price.timestamp ??
      null,

    updatedAt:
      price.updatedAt ||
      price.updated_at ||
      new Date().toISOString(),
  };
}

/**
 * Normalize one OHLC candle.
 */
function serializeCandle(candle) {
  if (!candle) return null;

  return {
    epoch:
      candle.epoch ??
      candle.open_time ??
      candle.time ??
      candle.timestamp ??
      null,

    time:
      candle.time ??
      candle.open_time ??
      candle.epoch ??
      null,

    timestamp:
      candle.timestamp ??
      candle.time ??
      candle.epoch ??
      null,

    open:
      getNumericValue(candle.open) ?? 0,

    high:
      getNumericValue(candle.high) ?? 0,

    low:
      getNumericValue(candle.low) ?? 0,

    close:
      getNumericValue(candle.close) ?? 0,

    volume:
      getNumericValue(
        candle.volume ??
        candle.tick_count,
      ) ?? undefined,
  };
}

/* ============================================================
   MARKET LIST
============================================================ */

/**
 * GET /api/v1/markets
 *
 * Query parameters:
 * ?limit=100
 * ?market=Forex
 * ?search=Volatility
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

  if (search) {
    filtered = filtered.filter((item) => {
      const haystack = [
        item.symbol,
        item.display_name,
        item.market,
        item.market_display_name,
        item.submarket,
        item.submarket_display_name,
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
    .map(serializeMarket)
    .filter(Boolean);

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

/* ============================================================
   ALL LIVE PRICES
============================================================ */

/**
 * GET /api/v1/markets/prices
 *
 * Returns real latest prices from Deriv.
 *
 * This controller intentionally does not manufacture prices.
 * DerivMarketService is responsible for obtaining and caching
 * real provider data.
 *
 * Optional query parameter:
 * ?limit=100
 */
export async function prices(req, res) {
  if (
    typeof derivMarketService.prices !== "function"
  ) {
    throw new AppError(
      "Live market prices are not configured on the backend",
      503,
      "MARKET_PRICES_UNAVAILABLE",
    );
  }

  const limit = getLimit(req.query.limit, 100, 1000);

  const result =
    await derivMarketService.prices({ limit });

  /**
   * Support service responses such as:
   * - MarketPrice[]
   * - { prices: MarketPrice[] }
   * - { data: MarketPrice[] }
   */
  const rawPrices = Array.isArray(result)
    ? result
    : Array.isArray(result?.prices)
      ? result.prices
      : Array.isArray(result?.data)
        ? result.data
        : [];

  const data = rawPrices
    .map((item) => serializePrice(item))
    .filter((item) => item?.symbol);

  return res.status(200).json({
    success: true,
    data,
    meta: {
      total: data.length,
      source: "Deriv",
      updatedAt: new Date().toISOString(),
    },
  });
}

/* ============================================================
   SINGLE MARKET
============================================================ */

/**
 * GET /api/v1/markets/:symbol
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

  let price = null;

  try {
    if (
      typeof derivMarketService.price === "function"
    ) {
      price =
        await derivMarketService.price(symbol);
    }
  } catch (error) {
    console.warn(
      `Unable to retrieve price for ${symbol}:`,
      error?.message || error,
    );
  }

  const normalizedPrice =
    serializePrice(price, symbol);

  const data = serializeMarket({
    ...market,

    price:
      normalizedPrice?.price ??
      market.price ??
      null,

    quote:
      normalizedPrice?.quote ??
      market.quote ??
      null,

    latestPrice:
      normalizedPrice?.latestPrice ??
      null,

    lastPrice:
      normalizedPrice?.lastPrice ??
      null,

    updatedAt:
      normalizedPrice?.updatedAt ??
      market.updatedAt ??
      null,
  });

  return res.status(200).json({
    success: true,
    data,
  });
}

/* ============================================================
   SINGLE LIVE PRICE
============================================================ */

/**
 * GET /api/v1/markets/:symbol/price
 *
 * Returns a real current quote for one market.
 */
export async function price(req, res) {
  const symbol = getSymbol(req);

  if (
    typeof derivMarketService.price !== "function"
  ) {
    throw new AppError(
      "Live market prices are not configured on the backend",
      503,
      "MARKET_PRICE_UNAVAILABLE",
    );
  }

  /**
   * Verify the symbol against the real market catalogue first.
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

  const result =
    await derivMarketService.price(symbol);

  const data =
    serializePrice(result, symbol);

  if (
    !data ||
    (
      data.price === null &&
      data.quote === null
    )
  ) {
    throw new AppError(
      `A live price is currently unavailable for "${symbol}"`,
      503,
      "PRICE_UNAVAILABLE",
    );
  }

  return res.status(200).json({
    success: true,
    data,
  });
}

/* ============================================================
   REAL OHLC CANDLES
============================================================ */

/**
 * GET /api/v1/markets/:symbol/candles
 *
 * Query parameters:
 * - granularity
 * - count
 * - start
 * - end
 */
export async function candles(req, res) {
  const symbol = getSymbol(req);

  if (
    typeof derivMarketService.candles !== "function"
  ) {
    throw new AppError(
      "Historical market candles are not configured on the backend",
      503,
      "MARKET_CANDLES_UNAVAILABLE",
    );
  }

  const market =
    await derivMarketService.symbol(symbol);

  if (!market) {
    throw new AppError(
      `Market "${symbol}" was not found`,
      404,
      "MARKET_NOT_FOUND",
    );
  }

  const granularity = getLimit(
    req.query.granularity,
    60,
    86_400,
  );

  const count = getLimit(
    req.query.count,
    100,
    5_000,
  );

  const start = getOptionalNumber(
    req.query.start,
    0,
  );

  const end = getOptionalNumber(
    req.query.end,
    0,
  );

  if (
    start !== undefined &&
    end !== undefined &&
    start >= end
  ) {
    throw new AppError(
      "The candle start time must be earlier than the end time",
      400,
      "VALIDATION_ERROR",
    );
  }

  const result =
    await derivMarketService.candles(symbol, {
      granularity,
      count,
      start,
      end,
    });

  /**
   * Support different service response shapes.
   */
  const rawCandles = Array.isArray(result)
    ? result
    : Array.isArray(result?.candles)
      ? result.candles
      : Array.isArray(result?.data)
        ? result.data
        : [];

  const data = rawCandles
    .map(serializeCandle)
    .filter(Boolean)
    .filter((candle) =>
      candle.open !== null &&
      candle.high !== null &&
      candle.low !== null &&
      candle.close !== null
    );

  return res.status(200).json({
    success: true,
    data: {
      symbol,
      granularity,
      count: data.length,
      candles: data,
    },
  });
}

/* ============================================================
   CONTRACTS
============================================================ */

/**
 * GET /api/v1/markets/:symbol/contracts
 */
export async function contracts(req, res) {
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

/* ============================================================
   REFRESH MARKETS
============================================================ */

/**
 * POST /api/v1/markets/refresh
 *
 * Refreshes cached real Deriv market data.
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
    ? markets.map(serializeMarket).filter(Boolean)
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