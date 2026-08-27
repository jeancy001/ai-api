import { derivConnectionManager } from "./DerivConnectionManager.js";
import { AppError } from "../utils/AppError.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_AGE_MS = 10_000;

/**
 * Market Data Service
 *
 * Responsibilities:
 * - Retrieve the latest market price from Deriv.
 * - Maintain an in-memory cache of recent ticks.
 * - Prevent duplicate simultaneous requests for the same market.
 * - Validate that returned market data is fresh enough for trading.
 *
 * IMPORTANT:
 * This cache is an optimization only. It is NOT the source of truth
 * for trade authorization. Risk and trading checks must still happen
 * immediately before execution.
 */
export class MarketDataService {
  constructor() {
    this.ticks = new Map();
    this.pendingRequests = new Map();

    /**
     * Support the generic tick event if emitted by the connection manager.
     */
    derivConnectionManager.on(
      "tick",
      (accountId, tick) => {
        this.storeTick(accountId, tick);
      }
    );
  }

  /**
   * Create a stable cache key.
   */
  getKey(accountId, symbol) {
    return `${String(accountId)}:${String(symbol)}`;
  }

  /**
   * Store a tick with the time at which this server received it.
   */
  storeTick(accountId, tick) {
    if (!accountId || !tick?.symbol) {
      return null;
    }

    const entry = {
      ...tick,
      receivedAt: new Date().toISOString(),
    };

    this.ticks.set(
      this.getKey(accountId, tick.symbol),
      entry
    );

    return entry;
  }

  /**
   * Get cached market data.
   */
  getCached(accountId, symbol) {
    return (
      this.ticks.get(
        this.getKey(accountId, symbol)
      ) || null
    );
  }

  /**
   * Check whether a tick is recent enough for automated trading.
   */
  isFresh(tick, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    if (!tick?.quote) {
      return false;
    }

    const receivedAt = new Date(
      tick.receivedAt || 0
    ).getTime();

    if (!Number.isFinite(receivedAt) || receivedAt <= 0) {
      return false;
    }

    return Date.now() - receivedAt <= maxAgeMs;
  }

  /**
   * Subscribe to ticks for a market.
   *
   * This should normally be called once when a market is selected,
   * rather than repeatedly for every trading cycle.
   */
  async subscribe(accountId, token, symbol) {
    if (!accountId || !token || !symbol) {
      throw new AppError(
        "Account, access token, and market symbol are required",
        400,
        "MARKET_DATA_CONTEXT_INVALID"
      );
    }

    const message =
      await derivConnectionManager.request(
        accountId,
        token,
        {
          ticks: symbol,
          subscribe: 1,
        },
        DEFAULT_TIMEOUT_MS
      );

    if (!message?.tick) {
      throw new AppError(
        "Deriv did not return market tick data",
        502,
        "MARKET_TICK_MISSING"
      );
    }

    return this.storeTick(
      accountId,
      message.tick
    );
  }

  /**
   * Retrieve the latest tick.
   *
   * By default this uses the recent cache first. If the cached tick
   * is stale or missing, a fresh non-subscription request is made.
   */
  async latest(
    accountId,
    token,
    symbol,
    {
      maxAgeMs = DEFAULT_MAX_AGE_MS,
      forceRefresh = false,
    } = {}
  ) {
    if (!accountId || !token || !symbol) {
      throw new AppError(
        "Account, access token, and market symbol are required",
        400,
        "MARKET_DATA_CONTEXT_INVALID"
      );
    }

    const cached = this.getCached(
      accountId,
      symbol
    );

    if (
      !forceRefresh &&
      cached &&
      this.isFresh(cached, maxAgeMs)
    ) {
      return cached;
    }

    const key = this.getKey(
      accountId,
      symbol
    );

    /**
     * Prevent multiple trading cycles from requesting the same tick
     * simultaneously.
     */
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key);
    }

    const request = this.fetchLatest(
      accountId,
      token,
      symbol
    ).finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, request);

    return request;
  }

  /**
   * Request one fresh tick without creating another subscription.
   */
  async fetchLatest(accountId, token, symbol) {
    const message =
      await derivConnectionManager.request(
        accountId,
        token,
        {
          ticks: symbol,
        },
        DEFAULT_TIMEOUT_MS
      );

    if (!message?.tick) {
      throw new AppError(
        `No market data returned for ${symbol}`,
        502,
        "MARKET_DATA_UNAVAILABLE"
      );
    }

    const tick = this.storeTick(
      accountId,
      message.tick
    );

    if (!tick?.quote) {
      throw new AppError(
        `Invalid market quote returned for ${symbol}`,
        502,
        "INVALID_MARKET_QUOTE"
      );
    }

    return tick;
  }

  /**
   * Get market data that is explicitly fresh enough for execution.
   *
   * Use this method immediately before strategy/risk evaluation.
   */
  async getFreshTick(
    accountId,
    token,
    symbol,
    maxAgeMs = DEFAULT_MAX_AGE_MS
  ) {
    const tick = await this.latest(
      accountId,
      token,
      symbol,
      {
        maxAgeMs,
        forceRefresh: false,
      }
    );

    if (!this.isFresh(tick, maxAgeMs)) {
      throw new AppError(
        `Market data for ${symbol} is stale`,
        409,
        "STALE_MARKET_DATA"
      );
    }

    return tick;
  }

  /**
   * Remove cached data for one market.
   */
  clear(accountId, symbol) {
    this.ticks.delete(
      this.getKey(accountId, symbol)
    );
  }

  /**
   * Clear all cached market data.
   */
  clearAll() {
    this.ticks.clear();
    this.pendingRequests.clear();
  }
}

export const marketDataService =
  new MarketDataService();