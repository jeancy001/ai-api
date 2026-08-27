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
  let ws = null;

  const timer = setTimeout(() => {
  finish(
  new AppError(
  "Deriv market request timed out",
  504,
  "DERIV_MARKET_TIMEOUT"
  )
  );
  }, timeout);

  const cleanup = () => {
  if (!ws) return;

  try {
  ws.removeAllListeners();

  
   if (
     ws.readyState === WebSocket.OPEN ||
     ws.readyState === WebSocket.CONNECTING
   ) {
     ws.close();
   }
  

  } catch {
  // Ignore cleanup errors.
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
     finish(
       new AppError(
         "Invalid response received from Deriv",
         502,
         "DERIV_INVALID_RESPONSE"
       )
     );
     return;
   }

   if (message.error) {
     finish(
       new AppError(
         message.error.message ||
           "Deriv market request failed",
         400,
         message.error.code || "DERIV_MARKET_ERROR"
       )
     );
     return;
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

* Normalize a symbol for comparisons only.
*
* IMPORTANT:
* We do not return this value to Deriv. The original provider symbol
* is preserved and used for API requests.
  */
  function normalizeSymbol(symbol) {
  return String(symbol || "")
  .trim()
  .toLowerCase();
  }

function formatMarket(symbol) {
return {
symbol: symbol.symbol,


displayName:
  symbol.display_name ||
  symbol.displayName ||
  symbol.symbol,

display_name:
  symbol.display_name ||
  symbol.displayName ||
  symbol.symbol,

market: symbol.market || null,

marketDisplayName:
  symbol.market_display_name ||
  symbol.marketDisplayName ||
  symbol.market ||
  null,

market_display_name:
  symbol.market_display_name ||
  symbol.marketDisplayName ||
  symbol.market ||
  null,

submarket:
  symbol.submarket ||
  symbol.subgroup ||
  null,

submarketDisplayName:
  symbol.submarket_display_name ||
  symbol.subgroup_display_name ||
  symbol.submarketDisplayName ||
  symbol.submarket ||
  symbol.subgroup ||
  null,

submarket_display_name:
  symbol.submarket_display_name ||
  symbol.subgroup_display_name ||
  symbol.submarket ||
  symbol.subgroup ||
  null,

subgroup:
  symbol.subgroup ||
  symbol.submarket ||
  null,

subgroup_display_name:
  symbol.subgroup_display_name ||
  symbol.submarket_display_name ||
  null,

exchangeIsOpen:
  symbol.exchange_is_open === 1 ||
  symbol.exchange_is_open === true,

exchange_is_open:
  symbol.exchange_is_open === 1 ||
  symbol.exchange_is_open === true,

isTradingSuspended:
  symbol.is_trading_suspended === 1 ||
  symbol.is_trading_suspended === true,

is_trading_suspended:
  symbol.is_trading_suspended === 1 ||
  symbol.is_trading_suspended === true,

pip: symbol.pip ?? null,
pipSize: symbol.pip_size ?? null,
pip_size: symbol.pip_size ?? null,

delayAmount: symbol.delay_amount ?? null,
delay_amount: symbol.delay_amount ?? null,

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
this.marketRequest = null;


}

/**

* Get all active symbols directly from Deriv.
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

* Return formatted markets.
  */
  async markets(options = {}) {
  const symbols = await this.activeSymbols(options);


return symbols



  .map(formatMarket)
  .sort((a, b) =>
    String(a.displayName).localeCompare(
      String(b.displayName)
    )
  );


}

/**

* Find one market without changing its provider casing.
  */
  async symbol(symbol, options = {}) {
  const requested = String(symbol || "").trim();


if (!requested) {



  throw new AppError(
    "Market symbol is required",
    400,
    "MARKET_SYMBOL_REQUIRED"
  );
}

const normalized = normalizeSymbol(requested);
const symbols = await this.activeSymbols(options);

return (
  symbols.find(
    (item) =>
      normalizeSymbol(item.symbol) === normalized
  ) || null
);


}

/**

* Get a live price for one market.
  */
  async price(symbol, { forceRefresh = false } = {}) {
  const requested = String(symbol || "").trim();


if (!requested) {



  throw new AppError(
    "Market symbol is required",
    400,
    "MARKET_SYMBOL_REQUIRED"
  );
}

const cacheKey = normalizeSymbol(requested);
const cached = this.priceCache.get(cacheKey);

if (
  !forceRefresh &&
  cached &&
  cached.expiresAt > Date.now()
) {
  return cached.data;
}

const market = await this.symbol(requested);

if (!market) {
  throw new AppError(
    `Market ${requested} is not available`,
    404,
    "MARKET_NOT_FOUND"
  );
}

if (
  market.is_trading_suspended === 1 ||
  market.is_trading_suspended === true
) {
  throw new AppError(
    `Market ${market.symbol} is currently suspended`,
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
    503,
    "PRICE_UNAVAILABLE"
  );
}

const quote = Number(tick.quote);

if (!Number.isFinite(quote)) {
  throw new AppError(
    `Invalid live price received for ${market.symbol}`,
    502,
    "INVALID_PRICE"
  );
}

const data = {
  symbol: tick.symbol || market.symbol,
  quote,
  price: quote,
  latestPrice: quote,
  lastPrice: quote,
  epoch: tick.epoch ?? null,
  pipSize:
    tick.pip_size ??
    market.pip_size ??
    null,
  pip_size:
    tick.pip_size ??
    market.pip_size ??
    null,
  displayName:
    market.display_name ||
    market.symbol,
  receivedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

this.priceCache.set(cacheKey, {
  data,
  expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
});

return data;


}

/**

* Get live prices for multiple symbols.
*
* Accepts:
* prices(["R_100", "frxEURUSD"])
*
* or:
* prices({ symbols: [...], limit: 100 })
*
* If symbols are omitted, the first available active symbols are used.
  */
  async prices(input = [], options = {}) {
  let symbols = [];
  let limit = 100;
  let forceRefresh = false;


if (Array.isArray(input)) {



  symbols = input;
  limit = options.limit || 100;
  forceRefresh = Boolean(options.forceRefresh);
} else if (input && typeof input === "object") {
  symbols = Array.isArray(input.symbols)
    ? input.symbols
    : [];

  limit = input.limit || 100;
  forceRefresh = Boolean(input.forceRefresh);
}

limit = Math.min(
  Math.max(Number(limit) || 100, 1),
  1000
);

/**
 * When no symbols are explicitly supplied, use the real
 * active Deriv catalogue.
 */
if (symbols.length === 0) {
  const active = await this.activeSymbols({
    forceRefresh,
  });

  symbols = active
    .filter(
      (item) =>
        item?.symbol &&
        item.is_trading_suspended !== 1 &&
        item.is_trading_suspended !== true
    )
    .slice(0, limit)
    .map((item) => item.symbol);
}

const uniqueSymbols = [
  ...new Map(
    symbols
      .map((symbol) => String(symbol || "").trim())
      .filter(Boolean)
      .map((symbol) => [
        normalizeSymbol(symbol),
        symbol,
      ])
  ).values(),
].slice(0, limit);

const results = await Promise.allSettled(
  uniqueSymbols.map((symbol) =>
    this.price(symbol, { forceRefresh })
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

* Get real OHLC candles from Deriv.
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
  const market = await this.symbol(symbol);


if (!market) {



  throw new AppError(
    `Market ${symbol} was not found`,
    404,
    "MARKET_NOT_FOUND"
  );
}

const payload = {
  ticks_history: market.symbol,
  style: "candles",
  granularity,
  count,
};

if (start !== undefined) {
  payload.start = start;
}

if (end !== undefined) {
  payload.end = end;
}

const response = await requestOnce(payload);

const candles = Array.isArray(
  response.candles
)
  ? response.candles
  : [];

return {
  symbol: market.symbol,
  granularity,
  candles,
};


}

/**

* Get contracts actually available for a symbol.
  */
  async contractsFor(symbol) {
  const market = await this.symbol(symbol);


if (!market) {



  throw new AppError(
    `Market ${symbol} was not found`,
    404,
    "MARKET_NOT_FOUND"
  );
}

const response = await requestOnce({
  contracts_for: market.symbol,
});

const available =
  response.contracts_for?.available ||
  [];

return {
  symbol: market.symbol,
  displayName:
    market.display_name ||
    market.symbol,
  contracts: Array.isArray(available)
    ? available
    : [],
};


}

/**

* Group markets for selection interfaces.
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

* Explicitly refresh the market catalogue.
  */
  async refresh() {
  this.clearCache();


return this.activeSymbols({



  forceRefresh: true,
});


}

clearCache() {
this.marketCache = {
data: null,
expiresAt: 0,
};


this.priceCache.clear();
this.marketRequest = null;


}
}

export const derivMarketService =
new DerivMarketService();
