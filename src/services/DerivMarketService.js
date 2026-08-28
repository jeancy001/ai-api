import WebSocket from "ws";
import { AppError } from "../utils/AppError.js";

/**
 * ============================================================
 * DERIV REAL-TIME MARKET DATA SERVICE
 * ============================================================
 *
 * Real Deriv market data only.
 *
 * Sources:
 * - active_symbols: market catalogue and metadata
 * - ticks: current real/live prices
 * - ticks_history: historical candles
 * - contracts_for: available contract types
 *
 * IMPORTANT:
 * - No mock prices are generated.
 * - No artificial fallback prices are generated.
 * - If Deriv does not provide a price, price fields remain null.
 * - One-time tick requests OMIT `subscribe`.
 * - Persistent streaming requests use `subscribe: 1`.
 * ============================================================
 */

const DERIV_WS_URL =
  process.env.DERIV_PUBLIC_WS_URL ||
  "wss://api.derivws.com/trading/v1/options/ws/public";

const REQUEST_TIMEOUT_MS = 20_000;
const CONNECTION_TIMEOUT_MS = 20_000;

const MARKET_CACHE_TTL_MS = 60_000;
const PRICE_CACHE_TTL_MS = 15_000;
const MAX_LIVE_PRICE_AGE_MS = 30_000;

const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const PRICE_REQUEST_CONCURRENCY = 10;
const SUBSCRIPTION_CONCURRENCY = 10;

const MAX_PRICE_SYMBOLS = 5_000;
const MAX_CANDLE_COUNT = 5_000;

let NEXT_REQUEST_ID = 1;

/* ============================================================
 * HELPERS
 * ============================================================
 */

function createRequestId() {
  const id = NEXT_REQUEST_ID;

  NEXT_REQUEST_ID =
    NEXT_REQUEST_ID >= 2_147_483_647
      ? 1
      : NEXT_REQUEST_ID + 1;

  return id;
}

function cleanString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

/**
 * Used ONLY for internal Map lookups.
 *
 * Never send this normalized value to Deriv. Deriv symbols are
 * preserved exactly as returned by active_symbols.
 */
function symbolKey(value) {
  return cleanString(value).toUpperCase();
}

function toNumber(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function isTrue(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1"
  );
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error?.message === "string") {
    return error.message;
  }

  return fallback;
}

function isSocketOpen(socket) {
  return Boolean(
    socket &&
    socket.readyState === WebSocket.OPEN
  );
}

function isLivePriceValid(price) {
  return Boolean(
    price &&
    Number.isFinite(price.quote)
  );
}

function getPriceAge(price) {
  if (!price?.updatedAt) {
    return Number.POSITIVE_INFINITY;
  }

  const timestamp = new Date(
    price.updatedAt
  ).getTime();

  if (!Number.isFinite(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(
    0,
    Date.now() - timestamp
  );
}

function isPriceFresh(
  price,
  maxAge = PRICE_CACHE_TTL_MS
) {
  return (
    isLivePriceValid(price) &&
    getPriceAge(price) <= maxAge
  );
}

function calculateReconnectDelay(attempt) {
  const delay =
    RECONNECT_DELAY_MS *
    2 ** Math.max(0, attempt);

  const jitter =
    Math.floor(Math.random() * 500);

  return Math.min(
    delay + jitter,
    MAX_RECONNECT_DELAY_MS
  );
}

async function mapWithConcurrency(
  items,
  concurrency,
  mapper
) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  const workerCount = Math.min(
    Math.max(1, Number(concurrency) || 1),
    items.length
  );

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] =
          await mapper(items[index], index);
      } catch (error) {
        results[index] = {
          success: false,
          error,
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );

  return results;
}

/* ============================================================
 * MARKET NORMALIZATION
 * ============================================================
 */

function extractSymbol(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const candidates = [
    item.underlying_symbol,
    item.symbol,
  ];

  for (const candidate of candidates) {
    const symbol = cleanString(candidate);

    if (symbol) {
      return symbol;
    }
  }

  return null;
}

function extractDisplayName(item, symbol) {
  return (
    cleanString(item.underlying_symbol_name) ||
    cleanString(item.display_name) ||
    cleanString(item.name) ||
    symbol
  );
}

function formatMarket(item) {
  const symbol = extractSymbol(item);

  if (!symbol) {
    return null;
  }

  const displayName =
    extractDisplayName(item, symbol);

  const exchangeIsOpen =
    item.exchange_is_open === undefined
      ? true
      : isTrue(item.exchange_is_open);

  const isTradingSuspended =
    isTrue(item.is_trading_suspended) ||
    isTrue(item.isTradingSuspended);

  const isTradingAvailable =
    exchangeIsOpen &&
    !isTradingSuspended;

  const market =
    cleanString(item.market) || null;

  const submarket =
    cleanString(item.submarket) || null;

  const subgroup =
    cleanString(item.subgroup) || null;

  const pipSize =
    toNumber(
      item.pip_size ??
      item.pipSize ??
      item.pip
    );

  return {
    id: symbol,
    symbol,

    underlyingSymbol: symbol,
    underlying_symbol: symbol,

    displayName,
    display_name: displayName,

    underlyingSymbolName: displayName,
    underlying_symbol_name: displayName,

    market,
    marketDisplayName: market,
    market_display_name: market,

    submarket,
    submarketDisplayName: submarket,
    submarket_display_name: submarket,

    subgroup,
    subgroupDisplayName: subgroup,
    subgroup_display_name: subgroup,

    exchangeIsOpen,
    exchange_is_open: exchangeIsOpen,

    isTradingSuspended,
    is_trading_suspended: isTradingSuspended,

    isTradingAvailable,

    pip: toNumber(item.pip),

    pipSize,
    pip_size: pipSize,

    underlyingSymbolType:
      cleanString(item.underlying_symbol_type) ||
      null,

    underlying_symbol_type:
      cleanString(item.underlying_symbol_type) ||
      null,

    // Prices are populated only from a real Deriv tick.
    price: null,
    latestPrice: null,
    lastPrice: null,
    quote: null,
    bid: null,
    ask: null,

    epoch: null,
    updatedAt: null,

    priceStatus: "not_requested",
  };
}

/* ============================================================
 * SERVICE
 * ============================================================
 */

export class DerivMarketService {
  constructor() {
    this.ws = null;
    this.connectionPromise = null;

    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.destroyed = false;

    this.pendingRequests = new Map();

    // SYMBOL KEY -> real verified tick
    this.priceCache = new Map();

    // SYMBOL KEY -> active subscription
    this.subscriptions = new Map();

    // Symbols that should survive reconnection.
    this.desiredSubscriptions = new Set();

    this.pendingSubscriptions = new Map();
    this.priceWaiters = new Map();

    this.marketCache = {
      data: null,
      expiresAt: 0,
    };

    this.marketRequest = null;
  }

  /* ==========================================================
   * CONNECTION
   * ==========================================================
   */

  async connect() {
    if (isSocketOpen(this.ws)) {
      return this.ws;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.destroyed = false;

    this.connectionPromise = new Promise(
      (resolve, reject) => {
        let settled = false;

        const socket = new WebSocket(
          DERIV_WS_URL
        );

        const timer = setTimeout(() => {
          if (settled) return;

          settled = true;

          try {
            socket.terminate();
          } catch {
            // Ignore.
          }

          reject(
            new AppError(
              "Timed out connecting to Deriv market data",
              504,
              "DERIV_CONNECTION_TIMEOUT"
            )
          );
        }, CONNECTION_TIMEOUT_MS);

        socket.once("open", () => {
          if (settled) return;

          settled = true;
          clearTimeout(timer);

          this.ws = socket;
          this.reconnectAttempts = 0;

          resolve(socket);
        });

        socket.on("message", (raw) => {
          this.handleMessage(raw);
        });

        socket.once("error", (error) => {
          if (settled) return;

          settled = true;
          clearTimeout(timer);

          reject(
            new AppError(
              getErrorMessage(
                error,
                "Deriv WebSocket connection failed"
              ),
              502,
              "DERIV_CONNECTION_ERROR"
            )
          );
        });

        socket.on("close", () => {
          clearTimeout(timer);

          if (this.ws === socket) {
            this.ws = null;
          }

          this.connectionPromise = null;

          this.rejectPendingRequests(
            new AppError(
              "Deriv connection closed before receiving a response",
              502,
              "DERIV_CONNECTION_CLOSED"
            )
          );

          this.subscriptions.clear();

          if (!this.destroyed) {
            this.scheduleReconnect();
          }
        });
      }
    );

    try {
      return await this.connectionPromise;
    } finally {
      if (!isSocketOpen(this.ws)) {
        this.connectionPromise = null;
      }
    }
  }

  rejectPendingRequests(error) {
    for (const [reqId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(reqId);
    }
  }

  scheduleReconnect() {
    if (
      this.destroyed ||
      this.reconnectTimer ||
      this.desiredSubscriptions.size === 0
    ) {
      return;
    }

    const delay =
      calculateReconnectDelay(
        this.reconnectAttempts
      );

    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(
      async () => {
        this.reconnectTimer = null;

        if (
          this.destroyed ||
          this.desiredSubscriptions.size === 0
        ) {
          return;
        }

        try {
          await this.connect();

          const symbols = [
            ...this.desiredSubscriptions,
          ];

          await mapWithConcurrency(
            symbols,
            SUBSCRIPTION_CONCURRENCY,
            async (key) => {
              const market =
                await this.findMarketByKey(key);

              if (market) {
                await this.subscribeToTicks(
                  market.symbol,
                  {
                    preserveIntent: true,
                  }
                );
              }

              return true;
            }
          );
        } catch {
          this.scheduleReconnect();
        }
      },
      delay
    );
  }

  /* ==========================================================
   * MESSAGE HANDLING
   * ==========================================================
   */

  handleMessage(raw) {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      message.msg_type === "tick" &&
      message.tick
    ) {
      this.handleTick(
        message.tick,
        message.subscription
      );
    }

    const reqId = message.req_id;

    if (
      !Number.isInteger(reqId) ||
      !this.pendingRequests.has(reqId)
    ) {
      return;
    }

    const pending =
      this.pendingRequests.get(reqId);

    clearTimeout(pending.timer);
    this.pendingRequests.delete(reqId);

    if (message.error) {
      pending.reject(
        new AppError(
          message.error.message ||
            "Deriv API request failed",
          502,
          message.error.code ||
            "DERIV_API_ERROR"
        )
      );

      return;
    }

    pending.resolve(message);
  }

  /* ==========================================================
   * TICK HANDLING
   * ==========================================================
   */

  handleTick(tick, subscription = null) {
    const symbol = cleanString(
      tick?.symbol ||
      tick?.underlying_symbol
    );

    if (!symbol) {
      return null;
    }

    const quote = toNumber(tick.quote);

    if (quote === null) {
      return null;
    }

    const key = symbolKey(symbol);

    const previous =
      this.priceCache.get(key);

    const updatedAt =
      new Date().toISOString();

    const data = {
      success: true,

      symbol,

      price: quote,
      latestPrice: quote,
      lastPrice:
        previous?.quote ?? quote,
      quote,

      bid: toNumber(tick.bid),
      ask: toNumber(tick.ask),

      epoch: toNumber(tick.epoch),

      pipSize:
        toNumber(tick.pip_size),

      pip_size:
        toNumber(tick.pip_size),

      receivedAt: updatedAt,
      updatedAt,

      priceStatus: "live",
    };

    this.priceCache.set(key, data);

    if (
      subscription?.id &&
      this.desiredSubscriptions.has(key)
    ) {
      this.subscriptions.set(key, {
        symbol,
        subscriptionId: subscription.id,
      });
    }

    const waiters =
      this.priceWaiters.get(key);

    if (waiters?.size) {
      for (const waiter of [...waiters]) {
        waiter(data);
      }
    }

    return data;
  }

  /* ==========================================================
   * REQUEST
   * ==========================================================
   */

  async request(
    payload,
    timeout = REQUEST_TIMEOUT_MS
  ) {
    const socket = await this.connect();

    if (!isSocketOpen(socket)) {
      throw new AppError(
        "Deriv WebSocket is not connected",
        503,
        "DERIV_CONNECTION_UNAVAILABLE"
      );
    }

    const reqId = createRequestId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);

        reject(
          new AppError(
            "Deriv API request timed out",
            504,
            "DERIV_REQUEST_TIMEOUT"
          )
        );
      }, timeout);

      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        timer,
      });

      try {
        socket.send(
          JSON.stringify({
            ...payload,
            req_id: reqId,
          })
        );
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);

        reject(
          new AppError(
            getErrorMessage(
              error,
              "Unable to send request to Deriv"
            ),
            502,
            "DERIV_REQUEST_SEND_ERROR"
          )
        );
      }
    });
  }

  /* ==========================================================
   * ACTIVE SYMBOLS
   * ==========================================================
   */

  async activeSymbols({
    forceRefresh = false,
  } = {}) {
    const now = Date.now();

    if (
      !forceRefresh &&
      Array.isArray(this.marketCache.data) &&
      this.marketCache.expiresAt > now
    ) {
      return this.marketCache.data;
    }

    if (this.marketRequest) {
      return this.marketRequest;
    }

    this.marketRequest = (async () => {
      const response =
        await this.request({
          active_symbols: "full",
        });

      const rawSymbols =
        Array.isArray(response.active_symbols)
          ? response.active_symbols
          : [];

      const marketsBySymbol = new Map();

      for (const item of rawSymbols) {
        const market = formatMarket(item);

        if (!market?.symbol) continue;

        const key = symbolKey(market.symbol);

        if (!marketsBySymbol.has(key)) {
          marketsBySymbol.set(key, market);
        }
      }

      const markets =
        [...marketsBySymbol.values()];

      if (
        rawSymbols.length > 0 &&
        markets.length === 0
      ) {
        throw new AppError(
          "Deriv returned markets but no valid symbols could be extracted",
          502,
          "DERIV_INVALID_MARKET_DATA"
        );
      }

      this.marketCache = {
        data: markets,
        expiresAt:
          Date.now() + MARKET_CACHE_TTL_MS,
      };

      return markets;
    })();

    try {
      return await this.marketRequest;
    } finally {
      this.marketRequest = null;
    }
  }

  async findMarketByKey(key) {
    const markets =
      await this.activeSymbols();

    return (
      markets.find(
        (market) =>
          symbolKey(market.symbol) === key
      ) || null
    );
  }

  /* ==========================================================
   * SINGLE MARKET
   * ==========================================================
   */

  async symbol(symbol, options = {}) {
    const requested = cleanString(symbol);

    if (!requested) {
      throw new AppError(
        "Market symbol is required",
        400,
        "MARKET_SYMBOL_REQUIRED"
      );
    }

    const markets =
      await this.activeSymbols(options);

    const key = symbolKey(requested);

    return (
      markets.find(
        (market) =>
          symbolKey(market.symbol) === key
      ) || null
    );
  }

  /* ==========================================================
   * ONE-TIME REAL TICK
   * ==========================================================
   */

  async fetchLatestTick(
    symbol,
    {
      forceRefresh = false,
    } = {}
  ) {
    const market =
      await this.symbol(symbol);

    if (!market) {
      throw new AppError(
        `Market "${symbol}" was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    const key =
      symbolKey(market.symbol);

    const cached =
      this.priceCache.get(key);

    if (
      !forceRefresh &&
      isPriceFresh(cached)
    ) {
      return this.decoratePrice(
        cached,
        market
      );
    }

    /**
     * IMPORTANT:
     * Do NOT send subscribe: 0.
     *
     * Omitting subscribe requests a normal one-time tick.
     */
    const response =
      await this.request({
        ticks: market.symbol,
      });

    if (!response.tick) {
      throw new AppError(
        `Deriv did not return a valid tick for "${market.symbol}"`,
        502,
        "DERIV_INVALID_TICK_RESPONSE"
      );
    }

    const livePrice =
      this.handleTick(response.tick);

    if (!isLivePriceValid(livePrice)) {
      throw new AppError(
        `Deriv returned an invalid quote for "${market.symbol}"`,
        502,
        "DERIV_INVALID_LIVE_PRICE"
      );
    }

    return this.decoratePrice(
      livePrice,
      market
    );
  }

  decoratePrice(price, market) {
    return {
      ...price,

      success: true,

      symbol:
        price.symbol ||
        market.symbol,

      displayName:
        market.displayName,

      pipSize:
        price.pipSize ??
        market.pipSize ??
        null,

      pip_size:
        price.pip_size ??
        market.pip_size ??
        null,

      priceStatus: "live",
    };
  }

  createUnavailablePrice(
    symbol,
    market = null,
    error = null
  ) {
    return {
      success: false,

      symbol:
        market?.symbol ||
        cleanString(symbol) ||
        null,

      displayName:
        market?.displayName ||
        null,

      price: null,
      latestPrice: null,
      lastPrice: null,
      quote: null,

      bid: null,
      ask: null,

      epoch: null,

      pipSize:
        market?.pipSize ??
        null,

      pip_size:
        market?.pip_size ??
        null,

      updatedAt: null,

      priceStatus: "unavailable",

      ...(error
        ? { error }
        : {}),
    };
  }

  /* ==========================================================
   * STREAMING SUBSCRIPTIONS
   * ==========================================================
   */

  async subscribeToTicks(
    symbol,
    {
      preserveIntent = true,
    } = {}
  ) {
    const requested = cleanString(symbol);

    if (!requested) {
      throw new AppError(
        "Market symbol is required",
        400,
        "MARKET_SYMBOL_REQUIRED"
      );
    }

    const key = symbolKey(requested);

    if (preserveIntent) {
      this.desiredSubscriptions.add(key);
    }

    if (this.subscriptions.has(key)) {
      return true;
    }

    if (this.pendingSubscriptions.has(key)) {
      return this.pendingSubscriptions.get(key);
    }

    const subscription = (async () => {
      const market =
        await this.symbol(requested);

      if (!market) {
        throw new AppError(
          `Market "${requested}" was not found`,
          404,
          "MARKET_NOT_FOUND"
        );
      }

      const response =
        await this.request({
          ticks: market.symbol,
          subscribe: 1,
        });

      if (!response.tick) {
        throw new AppError(
          `Deriv did not return an initial tick for "${market.symbol}"`,
          502,
          "DERIV_SUBSCRIPTION_INVALID_RESPONSE"
        );
      }

      const livePrice =
        this.handleTick(
          response.tick,
          response.subscription
        );

      if (!isLivePriceValid(livePrice)) {
        throw new AppError(
          `Deriv returned an invalid live price for "${market.symbol}"`,
          502,
          "DERIV_INVALID_LIVE_PRICE"
        );
      }

      this.subscriptions.set(key, {
        symbol: market.symbol,
        subscriptionId:
          response.subscription?.id || null,
      });

      return true;
    })();

    this.pendingSubscriptions.set(
      key,
      subscription
    );

    try {
      return await subscription;
    } finally {
      this.pendingSubscriptions.delete(key);
    }
  }

  async unsubscribeFromTicks(symbol) {
    const key = symbolKey(symbol);

    if (!key) return false;

    this.desiredSubscriptions.delete(key);

    const subscription =
      this.subscriptions.get(key);

    if (!subscription) {
      return true;
    }

    this.subscriptions.delete(key);

    if (
      !subscription.subscriptionId ||
      !isSocketOpen(this.ws)
    ) {
      return true;
    }

    try {
      await this.request({
        forget: subscription.subscriptionId,
      });

      return true;
    } catch {
      return false;
    }
  }

  /* ==========================================================
   * SINGLE LIVE PRICE
   * ==========================================================
   */

  async price(
    symbol,
    {
      forceRefresh = false,
    } = {}
  ) {
    const market =
      await this.symbol(symbol);

    if (!market) {
      throw new AppError(
        `Market "${symbol}" was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    try {
      const livePrice =
        await this.fetchLatestTick(
          market.symbol,
          { forceRefresh }
        );

      return livePrice;
    } catch (error) {
      return this.createUnavailablePrice(
        market.symbol,
        market,
        getErrorMessage(
          error,
          "Live Deriv price unavailable"
        )
      );
    }
  }

  /* ==========================================================
   * MULTIPLE REAL PRICES
   *
   * Supports BOTH:
   *   prices(["frxEURUSD"])
   *
   * and:
   *   prices({
   *     symbols: ["frxEURUSD"],
   *     limit: 100
   *   })
   *
   * This makes it compatible with your controller.
   * ==========================================================
   */

  async prices(
    input = [],
    {
      forceRefresh = false,
    } = {}
  ) {
    let symbols;
    let limit;

    if (Array.isArray(input)) {
      symbols = input;
      limit = undefined;
    } else if (
      input &&
      typeof input === "object"
    ) {
      symbols = Array.isArray(input.symbols)
        ? input.symbols
        : [];

      limit = input.limit;

      if (
        typeof input.forceRefresh === "boolean"
      ) {
        forceRefresh = input.forceRefresh;
      }
    } else {
      throw new AppError(
        "symbols must be an array",
        400,
        "INVALID_SYMBOLS_INPUT"
      );
    }

    /**
     * If no symbols were explicitly supplied, load markets and
     * request prices for the first requested number of tradable
     * markets.
     */
    if (symbols.length === 0) {
      const markets =
        await this.activeSymbols();

      const maximum =
        Math.min(
          Number.isFinite(Number(limit))
            ? Math.max(
                1,
                Math.floor(Number(limit))
              )
            : 100,
          MAX_PRICE_SYMBOLS
        );

      symbols = markets
        .filter(
          (market) =>
            market.symbol &&
            market.isTradingAvailable !== false
        )
        .slice(0, maximum)
        .map(
          (market) => market.symbol
        );
    }

    /**
     * Preserve original symbol values for Deriv requests.
     * Deduplicate using normalized keys.
     */
    const uniqueMap = new Map();

    for (const value of symbols) {
      const symbol = cleanString(value);

      if (!symbol) continue;

      const key = symbolKey(symbol);

      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, symbol);
      }
    }

    const uniqueSymbols =
      [...uniqueMap.values()];

    if (
      uniqueSymbols.length >
      MAX_PRICE_SYMBOLS
    ) {
      throw new AppError(
        `Too many symbols requested. Maximum is ${MAX_PRICE_SYMBOLS}`,
        400,
        "PRICE_SYMBOL_LIMIT_EXCEEDED"
      );
    }

    if (uniqueSymbols.length === 0) {
      return [];
    }

    const results =
      await mapWithConcurrency(
        uniqueSymbols,
        PRICE_REQUEST_CONCURRENCY,
        async (symbol) => {
          const market =
            await this.symbol(symbol);

          if (!market) {
            return this.createUnavailablePrice(
              symbol,
              null,
              "Market not found"
            );
          }

          try {
            return await this.fetchLatestTick(
              market.symbol,
              { forceRefresh }
            );
          } catch (error) {
            return this.createUnavailablePrice(
              market.symbol,
              market,
              getErrorMessage(
                error,
                "Live Deriv price unavailable"
              )
            );
          }
        }
      );

    return results.map(
      (result, index) => {
        if (result?.success === false) {
          return result;
        }

        if (!result) {
          return this.createUnavailablePrice(
            uniqueSymbols[index],
            null,
            "Live Deriv price unavailable"
          );
        }

        return result;
      }
    );
  }

  /* ==========================================================
   * ALL MARKETS WITH REAL PRICES
   * ==========================================================
   */

  async markets({
    forceRefresh = false,
    includePrices = true,
  } = {}) {
    const markets =
      await this.activeSymbols({
        forceRefresh,
      });

    const sorted = [...markets].sort(
      (a, b) =>
        String(a.displayName).localeCompare(
          String(b.displayName)
        )
    );

    if (!includePrices) {
      return sorted;
    }

    const tradableSymbols =
      sorted
        .filter(
          (market) =>
            market.symbol &&
            market.isTradingAvailable !== false
        )
        .map(
          (market) => market.symbol
        );

    const priceResults =
      await this.prices(
        tradableSymbols,
        { forceRefresh }
      );

    const pricesBySymbol = new Map(
      priceResults
        .filter((price) => price?.symbol)
        .map((price) => [
          symbolKey(price.symbol),
          price,
        ])
    );

    return sorted.map((market) => {
      const livePrice =
        pricesBySymbol.get(
          symbolKey(market.symbol)
        );

      if (
        !livePrice ||
        !livePrice.success ||
        !Number.isFinite(livePrice.quote)
      ) {
        return {
          ...market,

          price: null,
          latestPrice: null,
          lastPrice: null,
          quote: null,
          bid: null,
          ask: null,

          epoch: null,
          updatedAt: null,

          priceStatus:
            market.isTradingAvailable === false
              ? "not_tradable"
              : "unavailable",

          ...(livePrice?.error
            ? {
                priceError:
                  livePrice.error,
              }
            : {}),
        };
      }

      return {
        ...market,

        price: livePrice.quote,
        latestPrice: livePrice.quote,
        lastPrice:
          livePrice.lastPrice ??
          livePrice.quote,
        quote: livePrice.quote,

        bid: livePrice.bid,
        ask: livePrice.ask,

        epoch: livePrice.epoch,

        updatedAt:
          livePrice.updatedAt,

        pipSize:
          livePrice.pipSize ??
          market.pipSize ??
          null,

        pip_size:
          livePrice.pip_size ??
          market.pip_size ??
          null,

        priceStatus: "live",
      };
    });
  }

  /* ==========================================================
   * HISTORICAL CANDLES
   * ==========================================================
   */

  async candles(
    symbol,
    {
      granularity = 60,
      count = 100,
      start,
      end,
    } = {}
  ) {
    const normalizedGranularity =
      Number(granularity);

    const normalizedCount =
      Number(count);

    if (
      !Number.isFinite(normalizedGranularity) ||
      normalizedGranularity <= 0
    ) {
      throw new AppError(
        "granularity must be a positive number",
        400,
        "INVALID_CANDLE_GRANULARITY"
      );
    }

    if (
      !Number.isInteger(normalizedCount) ||
      normalizedCount <= 0 ||
      normalizedCount > MAX_CANDLE_COUNT
    ) {
      throw new AppError(
        `count must be between 1 and ${MAX_CANDLE_COUNT}`,
        400,
        "INVALID_CANDLE_COUNT"
      );
    }

    const market =
      await this.symbol(symbol);

    if (!market) {
      throw new AppError(
        `Market "${symbol}" was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    const payload = {
      ticks_history: market.symbol,
      style: "candles",
      granularity: normalizedGranularity,
      count: normalizedCount,
      end: end ?? "latest",
    };

    if (
      start !== undefined &&
      start !== null
    ) {
      payload.start = start;
    }

    const response =
      await this.request(payload);

    const candles =
      Array.isArray(response.candles)
        ? response.candles
        : [];

    return {
      success: true,
      symbol: market.symbol,
      displayName: market.displayName,
      granularity: normalizedGranularity,
      count: candles.length,
      candles,
    };
  }

  /* ==========================================================
   * AVAILABLE CONTRACTS
   * ==========================================================
   */

  async contractsFor(symbol) {
    const market =
      await this.symbol(symbol);

    if (!market) {
      throw new AppError(
        `Market "${symbol}" was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    const response =
      await this.request({
        contracts_for: market.symbol,
      });

    return {
      success: true,

      symbol: market.symbol,

      displayName:
        market.displayName,

      contracts:
        Array.isArray(
          response.contracts_for?.available
        )
          ? response.contracts_for.available
          : [],
    };
  }

  /* ==========================================================
   * GROUPED MARKETS
   * ==========================================================
   */

  async groupedMarkets(options = {}) {
    const markets =
      await this.markets(options);

    const groups = new Map();

    for (const market of markets) {
      const marketName =
        market.marketDisplayName ||
        market.market ||
        "Other";

      const submarketName =
        market.submarketDisplayName ||
        market.submarket ||
        market.subgroupDisplayName ||
        market.subgroup ||
        "Other";

      if (!groups.has(marketName)) {
        groups.set(marketName, {
          name: marketName,
          submarkets: new Map(),
        });
      }

      const group =
        groups.get(marketName);

      if (
        !group.submarkets.has(
          submarketName
        )
      ) {
        group.submarkets.set(
          submarketName,
          {
            name: submarketName,
            symbols: [],
          }
        );
      }

      group.submarkets
        .get(submarketName)
        .symbols
        .push(market);
    }

    return [
      ...groups.values(),
    ].map((group) => ({
      name: group.name,
      submarkets: [
        ...group.submarkets.values(),
      ],
    }));
  }

  /* ==========================================================
   * VERIFIED MARKET FOR AUTO TRADING
   * ==========================================================
   */

  async getVerifiedTradableMarket(symbol) {
    const market =
      await this.symbol(symbol);

    if (!market) {
      throw new AppError(
        `Market "${symbol}" was not found`,
        404,
        "MARKET_NOT_FOUND"
      );
    }

    if (
      !market.isTradingAvailable ||
      market.isTradingSuspended
    ) {
      throw new AppError(
        `Market "${market.symbol}" is not currently tradable`,
        409,
        "MARKET_NOT_TRADABLE"
      );
    }

    let livePrice;

    try {
      livePrice =
        await this.fetchLatestTick(
          market.symbol,
          {
            forceRefresh: true,
          }
        );
    } catch (error) {
      throw new AppError(
        `Cannot trade "${market.symbol}" because a verified live Deriv price could not be obtained`,
        503,
        "VERIFIED_LIVE_PRICE_REQUIRED"
      );
    }

    if (
      !livePrice.success ||
      !Number.isFinite(livePrice.quote)
    ) {
      throw new AppError(
        `Cannot trade "${market.symbol}" because Deriv did not provide a verified live price`,
        503,
        "VERIFIED_LIVE_PRICE_REQUIRED"
      );
    }

    return {
      market,
      livePrice,
    };
  }

  /* ==========================================================
   * CACHE / REFRESH
   * ==========================================================
   */

  clearCache() {
    this.marketCache = {
      data: null,
      expiresAt: 0,
    };

    this.priceCache.clear();
  }

  async refresh() {
    this.clearCache();

    return this.activeSymbols({
      forceRefresh: true,
    });
  }

  /* ==========================================================
   * STATUS
   * ==========================================================
   */

  getStatus() {
    return {
      connected:
        isSocketOpen(this.ws),

      reconnecting:
        Boolean(this.reconnectTimer),

      pendingRequests:
        this.pendingRequests.size,

      cachedPrices:
        this.priceCache.size,

      activeSubscriptions:
        this.subscriptions.size,

      desiredSubscriptions:
        this.desiredSubscriptions.size,

      destroyed:
        this.destroyed,
    };
  }

  /* ==========================================================
   * SHUTDOWN
   * ==========================================================
   */

  destroy() {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.rejectPendingRequests(
      new AppError(
        "Deriv market service was stopped",
        503,
        "DERIV_SERVICE_STOPPED"
      )
    );

    this.desiredSubscriptions.clear();
    this.subscriptions.clear();
    this.pendingSubscriptions.clear();
    this.priceWaiters.clear();
    this.priceCache.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore.
      }
    }

    this.ws = null;
    this.connectionPromise = null;

    this.marketCache = {
      data: null,
      expiresAt: 0,
    };
  }
}

/**
 * Shared singleton.
 */
export const derivMarketService =
  new DerivMarketService();