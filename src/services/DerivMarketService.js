import WebSocket from "ws";
import { AppError } from "../utils/AppError.js";

/**
 * Public Deriv WebSocket.
 *
 * Public market data does not require a user's trading token.
 */
const PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const REQUEST_TIMEOUT_MS = 15_000;
const MARKET_CACHE_TTL_MS = 60_000;
const PRICE_CACHE_TTL_MS = 3_000;

/**
 * Send one request through a temporary public WebSocket connection.
 *
 * The connection is always cleaned up after a response, timeout, or error.
 */
function requestOnce(payload, timeout = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;

    const cleanup = () => {
      if (ws) {
        ws.removeAllListeners();

        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      }
    };

    const finish = (error, data) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      cleanup();

      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    };

    const timer = setTimeout(() => {
      finish(
        new AppError(
          "Deriv market request timed out",
          504,
          "DERIV_MARKET_TIMEOUT"
        )
      );
    }, timeout);

    try {
      ws = new WebSocket(PUBLIC_WS);

      ws.once("open", () => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (error) {
          finish(error);
        }
      });

      ws.on("message", (raw) => {
        let message;

        try {
          message = JSON.parse(raw.toString());
        } catch {
          return finish(
            new AppError(
              "Invalid response received from Deriv",
              502,
              "DERIV_INVALID_RESPONSE"
            )
          );
        }

        if (message.error) {
          return finish(
            new AppError(
              message.error.message ||
                "Deriv market request failed",
              400,
              message.error.code || "DERIV_MARKET_ERROR"
            )
          );
        }

        finish(null, message);
      });

      ws.once("error", (error) => {
        finish(
          new AppError(
            error.message || "Deriv market connection failed",
            502,
            "DERIV_MARKET_CONNECTION_ERROR"
          )
        );
      });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Normalize a symbol for safe comparisons.
 */
function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}

/**
 * Create a frontend-friendly market representation.
 *
 * We keep the original Deriv fields while exposing normalized fields
 * that the frontend can use consistently.
 */
function formatMarket(symbol) {
  return {
    symbol: symbol.symbol,
    displayName:
      symbol.display_name ||
      symbol.displayName ||
      symbol.symbol,

    market:
      symbol.market ||
      null,

    marketDisplayName:
      symbol.market_display_name ||
      symbol.marketDisplayName ||
      symbol.market ||
      null,

    submarket:
      symbol.submarket ||
      null,

    submarketDisplayName:
      symbol.submarket_display_name ||
      symbol.submarketDisplayName ||
      symbol.submarket ||
      null,

    exchangeIsOpen:
      symbol.exchange_is_open === 1 ||
      symbol.exchange_is_open === true,

    isTradingSuspended:
      symbol.is_trading_suspended === 1 ||
      symbol.is_trading_suspended === true,

    pip: symbol.pip ?? null,
    pipSize: symbol.pip_size ?? null,
    delayAmount: symbol.delay_amount ?? null,

    raw: symbol,
  };
}

export class DerivMarketService {
  constructor() {
    this.marketCache = {
      data: null,
      expiresAt: 0,
    };

    this.priceCache = new Map();

    /**
     * Prevent multiple simultaneous requests for the same market list.
     */
    this.marketRequest = null;
  }

  /**
   * Get all active Deriv symbols.
   *
   * Cached briefly because the active symbol list is relatively stable.
   */
  async activeSymbols({ forceRefresh = false } = {}) {
    const now = Date.now();

    if (
      !forceRefresh &&
      this.marketCache.data &&
      this.marketCache.expiresAt > now
    ) {
      return this.marketCache.data;
    }

    if (this.marketRequest && !forceRefresh) {
      return this.marketRequest;
    }

    this.marketRequest = (async () => {
      const response = await requestOnce({
        active_symbols: "full",
      });

      const symbols = Array.isArray(
        response.active_symbols
      )
        ? response.active_symbols
        : [];

      this.marketCache = {
        data: symbols,
        expiresAt: Date.now() + MARKET_CACHE_TTL_MS,
      };

      return symbols;
    })();

    try {
      return await this.marketRequest;
    } finally {
      this.marketRequest = null;
    }
  }

  /**
   * Get all markets formatted for the frontend.
   */
  async markets(options = {}) {
    const symbols = await this.activeSymbols(options);

    return symbols
      .map(formatMarket)
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName)
      );
  }

  /**
   * Get one symbol.
   */
  async symbol(symbol, options = {}) {
    const normalized = normalizeSymbol(symbol);

    if (!normalized) {
      throw new AppError(
        "Market symbol is required",
        400,
        "MARKET_SYMBOL_REQUIRED"
      );
    }

    const symbols = await this.activeSymbols(options);

    return (
      symbols.find(
        (item) =>
          normalizeSymbol(item.symbol) === normalized
      ) || null
    );
  }

  /**
   * Get current price for one symbol.
   *
   * A short cache protects the public API from unnecessary duplicate
   * requests while still keeping prices fresh for UI display.
   */
  async price(symbol, { forceRefresh = false } = {}) {
    const normalized = normalizeSymbol(symbol);

    if (!normalized) {
      throw new AppError(
        "Market symbol is required",
        400,
        "MARKET_SYMBOL_REQUIRED"
      );
    }

    const cached = this.priceCache.get(normalized);

    if (
      !forceRefresh &&
      cached &&
      cached.expiresAt > Date.now()
    ) {
      return cached.data;
    }

    /**
     * Validate the symbol first so arbitrary values are not blindly
     * sent to the trading API.
     */
    const market = await this.symbol(normalized);

    if (!market) {
      throw new AppError(
        `Market ${normalized} is not available`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    if (
      market.is_trading_suspended === 1 ||
      market.is_trading_suspended === true
    ) {
      throw new AppError(
        `Market ${normalized} is currently suspended`,
        409,
        "MARKET_SUSPENDED"
      );
    }

    const response = await requestOnce({
      ticks: market.symbol,
      subscribe: 0,
    });

    const tick = response.tick;

    if (!tick || tick.quote === undefined) {
      throw new AppError(
        `No price is currently available for ${market.symbol}`,
        502,
        "PRICE_UNAVAILABLE"
      );
    }

    const data = {
      symbol: tick.symbol || market.symbol,
      quote: Number(tick.quote),
      epoch: tick.epoch || null,
      pipSize:
        tick.pip_size ??
        market.pip_size ??
        null,
      displayName:
        market.display_name ||
        market.symbol,
      receivedAt: new Date(),
    };

    this.priceCache.set(normalized, {
      data,
      expiresAt:
        Date.now() + PRICE_CACHE_TTL_MS,
    });

    return data;
  }

  /**
   * Get prices for multiple symbols.
   *
   * Failed symbols are returned with an error instead of causing the
   * entire market screen to fail.
   */
  async prices(symbols = [], options = {}) {
    if (!Array.isArray(symbols)) {
      throw new AppError(
        "symbols must be an array",
        400,
        "INVALID_SYMBOLS"
      );
    }

    const uniqueSymbols = [
      ...new Set(
        symbols
          .map(normalizeSymbol)
          .filter(Boolean)
      ),
    ];

    const results = await Promise.allSettled(
      uniqueSymbols.map((symbol) =>
        this.price(symbol, options)
      )
    );

    return results.map((result, index) => {
      const symbol = uniqueSymbols[index];

      if (result.status === "fulfilled") {
        return {
          success: true,
          ...result.value,
        };
      }

      return {
        success: false,
        symbol,
        error:
          result.reason?.message ||
          "Price unavailable",
      };
    });
  }

  /**
   * Get all contract categories/types available for a symbol.
   *
   * Unlike filtering active_symbols, this asks Deriv directly which
   * contracts can actually be used for the market.
   */
  async contractsFor(symbol) {
    const normalized = normalizeSymbol(symbol);

    if (!normalized) {
      throw new AppError(
        "Market symbol is required",
        400,
        "MARKET_SYMBOL_REQUIRED"
      );
    }

    const market = await this.symbol(normalized);

    if (!market) {
      throw new AppError(
        `Market ${normalized} was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    const response = await requestOnce({
      contracts_for: market.symbol,
    });

    const contracts =
      response.contracts_for?.available ||
      response.contracts_for ||
      [];

    return {
      symbol: market.symbol,
      displayName:
        market.display_name ||
        market.symbol,
      contracts: Array.isArray(contracts)
        ? contracts
        : [],
    };
  }

  /**
   * Group all markets for a market-selection UI.
   */
  async groupedMarkets(options = {}) {
    const markets = await this.markets(options);

    const groups = new Map();

    for (const market of markets) {
      const marketName =
        market.marketDisplayName ||
        market.market ||
        "Other";

      const submarketName =
        market.submarketDisplayName ||
        market.submarket ||
        "Other";

      if (!groups.has(marketName)) {
        groups.set(marketName, {
          name: marketName,
          submarkets: new Map(),
        });
      }

      const group = groups.get(marketName);

      if (!group.submarkets.has(submarketName)) {
        group.submarkets.set(submarketName, {
          name: submarketName,
          symbols: [],
        });
      }

      group.submarkets
        .get(submarketName)
        .symbols.push(market);
    }

    return Array.from(groups.values()).map(
      (group) => ({
        name: group.name,
        submarkets: Array.from(
          group.submarkets.values()
        ),
      })
    );
  }

  /**
   * Explicitly clear cached market metadata.
   */
  clearCache() {
    this.marketCache = {
      data: null,
      expiresAt: 0,
    };

    this.priceCache.clear();
  }
}

export const derivMarketService =
  new DerivMarketService();