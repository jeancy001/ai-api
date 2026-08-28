import { derivMarketService } from "../services/DerivMarketService.js";
import { AppError } from "../utils/AppError.js";

/* ============================================================
VALIDATION & NORMALIZATION HELPERS
============================================================ */

/**

* Preserve the symbol exactly as provided by the client.
*
* Do not uppercase symbols in the controller. The market service
* is responsible for matching provider symbols internally.
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
"MARKET_SYMBOL_REQUIRED"
);
}

return symbol;
}

function getLimit(value, fallback = 100, max = 1000) {
if (
value === undefined ||
value === null ||
value === ""
) {
return fallback;
}

const parsed = Number(value);

if (!Number.isFinite(parsed)) {
return fallback;
}

return Math.min(
Math.max(Math.floor(parsed), 1),
max
);
}

function getOptionalNumber(
value,
min = 0,
max = Number.MAX_SAFE_INTEGER
) {
if (
value === undefined ||
value === null ||
value === ""
) {
return undefined;
}

const parsed = Number(value);

if (!Number.isFinite(parsed)) {
throw new AppError(
"Invalid numeric query parameter",
400,
"VALIDATION_ERROR"
);
}

return Math.min(
Math.max(Math.floor(parsed), min),
max
);
}

/**

* Parse symbols from query parameters.
*
* Supported:
* ?symbols=R_100,R_50
* ?symbols[]=R_100&symbols[]=R_50
*
* Returns null when symbols were not supplied. This allows the
* prices endpoint to automatically load available markets.
  */
  function parseSymbols(value) {
  if (
  value === undefined ||
  value === null ||
  value === ""
  ) {
  return null;
  }

const values = Array.isArray(value)
? value
: [value];

const symbols = values
.flatMap((item) => {
if (typeof item !== "string") {
return [];
}


  return item.split(",");
})
.map((item) => item.trim())
.filter(Boolean);


if (symbols.length === 0) {
throw new AppError(
"symbols must contain at least one valid market symbol",
400,
"INVALID_SYMBOLS_INPUT"
);
}

return [
...new Set(symbols),
];
}

function getBooleanQuery(value, fallback = false) {
if (
value === undefined ||
value === null ||
value === ""
) {
return fallback;
}

if (
value === true ||
value === "true" ||
value === 1 ||
value === "1"
) {
return true;
}

if (
value === false ||
value === "false" ||
value === 0 ||
value === "0"
) {
return false;
}

return fallback;
}

function numeric(value) {
if (
value === undefined ||
value === null ||
value === ""
) {
return null;
}

const parsed = Number(value);

return Number.isFinite(parsed)
? parsed
: null;
}

function booleanValue(value) {
return (
value === true ||
value === 1 ||
value === "1" ||
value === "true"
);
}

/* ============================================================
SERIALIZERS
============================================================ */

function serializeMarket(market) {
if (!market || typeof market !== "object") {
return null;
}

const exchangeIsOpen =
typeof market.exchangeIsOpen === "boolean"
? market.exchangeIsOpen
: typeof market.exchange_is_open === "boolean"
? market.exchange_is_open
: market.exchange_is_open === undefined
? true
: booleanValue(market.exchange_is_open);

const isTradingSuspended =
typeof market.isTradingSuspended === "boolean"
? market.isTradingSuspended
: booleanValue(market.is_trading_suspended);

const isTradingAvailable =
typeof market.isTradingAvailable === "boolean"
? market.isTradingAvailable
: exchangeIsOpen && !isTradingSuspended;

return {
id: market.id || market.symbol || null,
symbol: market.symbol || null,


underlyingSymbol:
  market.underlyingSymbol ||
  market.underlying_symbol ||
  market.symbol ||
  null,

underlying_symbol:
  market.underlying_symbol ||
  market.underlyingSymbol ||
  market.symbol ||
  null,

displayName:
  market.displayName ||
  market.display_name ||
  market.underlyingSymbolName ||
  market.symbol ||
  null,

display_name:
  market.display_name ||
  market.displayName ||
  market.underlying_symbol_name ||
  market.symbol ||
  null,

underlyingSymbolName:
  market.underlyingSymbolName ||
  market.underlying_symbol_name ||
  market.displayName ||
  market.symbol ||
  null,

underlying_symbol_name:
  market.underlying_symbol_name ||
  market.underlyingSymbolName ||
  market.display_name ||
  market.symbol ||
  null,

/* ---------------- MARKET GROUPING ---------------- */

market: market.market || null,

marketDisplayName:
  market.marketDisplayName ||
  market.market_display_name ||
  market.market ||
  null,

market_display_name:
  market.market_display_name ||
  market.marketDisplayName ||
  market.market ||
  null,

submarket:
  market.submarket ||
  market.subgroup ||
  null,

submarketDisplayName:
  market.submarketDisplayName ||
  market.submarket_display_name ||
  market.subgroupDisplayName ||
  market.subgroup_display_name ||
  market.submarket ||
  market.subgroup ||
  null,

submarket_display_name:
  market.submarket_display_name ||
  market.submarketDisplayName ||
  market.subgroup_display_name ||
  market.subgroupDisplayName ||
  market.submarket ||
  market.subgroup ||
  null,

subgroup:
  market.subgroup ||
  market.submarket ||
  null,

subgroupDisplayName:
  market.subgroupDisplayName ||
  market.subgroup_display_name ||
  market.submarketDisplayName ||
  market.submarket_display_name ||
  market.subgroup ||
  market.submarket ||
  null,

subgroup_display_name:
  market.subgroup_display_name ||
  market.subgroupDisplayName ||
  market.submarket_display_name ||
  market.submarketDisplayName ||
  market.subgroup ||
  market.submarket ||
  null,

/* ---------------- TRADING STATUS ---------------- */

exchangeIsOpen,
exchange_is_open: exchangeIsOpen,

isTradingAvailable,

isTradingSuspended,
is_trading_suspended: isTradingSuspended,

/* ---------------- MARKET DETAILS ---------------- */

underlyingSymbolType:
  market.underlyingSymbolType ||
  market.underlying_symbol_type ||
  null,

underlying_symbol_type:
  market.underlying_symbol_type ||
  market.underlyingSymbolType ||
  null,

pip: numeric(market.pip),

pipSize: numeric(
  market.pipSize ??
  market.pip_size
),

pip_size: numeric(
  market.pip_size ??
  market.pipSize
),

/* ---------------- LIVE PRICE ---------------- */

price: numeric(
  market.price ??
  market.latestPrice ??
  market.quote
),

latestPrice: numeric(
  market.latestPrice ??
  market.price ??
  market.quote
),

lastPrice: numeric(
  market.lastPrice ??
  market.price ??
  market.quote
),

quote: numeric(
  market.quote ??
  market.price ??
  market.latestPrice
),

bid: numeric(market.bid),
ask: numeric(market.ask),

epoch: numeric(market.epoch),

updatedAt:
  market.updatedAt ||
  market.updated_at ||
  null,

priceStatus:
  market.priceStatus ||
  (Number.isFinite(Number(market.quote))
    ? "live"
    : "not_requested"),


};
}

function serializePrice(price, fallbackSymbol = null) {
if (!price || typeof price !== "object") {
return null;
}

const quote = numeric(
price.quote ??
price.price ??
price.latestPrice
);

const failed =
price.success === false ||
quote === null;

return {
success: !failed,


symbol:
  price.symbol ||
  price.underlying_symbol ||
  fallbackSymbol ||
  null,

displayName:
  price.displayName ||
  price.display_name ||
  null,

price: quote,

latestPrice: numeric(
  price.latestPrice ??
  price.price ??
  price.quote
),

lastPrice: numeric(
  price.lastPrice ??
  price.price ??
  price.quote
),

quote,

bid: numeric(price.bid),
ask: numeric(price.ask),

epoch: numeric(
  price.epoch ??
  price.timestamp
),

pipSize: numeric(
  price.pipSize ??
  price.pip_size
),

pip_size: numeric(
  price.pip_size ??
  price.pipSize
),

updatedAt:
  price.updatedAt ||
  price.receivedAt ||
  null,

priceStatus:
  price.priceStatus ||
  (failed ? "unavailable" : "live"),

...(failed
  ? {
      error:
        typeof price.error === "string"
          ? price.error
          : "Live Deriv price unavailable",
    }
  : {}),


};
}

function serializeCandle(candle) {
if (!candle || typeof candle !== "object") {
return null;
}

return {
epoch:
numeric(
candle.epoch ??
candle.open_time ??
candle.time ??
candle.timestamp
),


time:
  numeric(
    candle.time ??
    candle.open_time ??
    candle.epoch ??
    candle.timestamp
  ),

open: numeric(candle.open),
high: numeric(candle.high),
low: numeric(candle.low),
close: numeric(candle.close),

volume: numeric(
  candle.volume ??
  candle.tick_count
),


};
}

/* ============================================================
GET ALL MARKETS
============================================================ */

/**

* GET /api/v1/markets
*
* Query parameters:
* * limit: maximum markets returned
* * market: filter by market group
* * search: search symbols and display names
* * refresh=true: bypass market metadata cache
    */
    export async function list(req, res) {
    const limit = getLimit(
    req.query.limit,
    500,
    1000
    );

const search =
typeof req.query.search === "string"
? req.query.search.trim().toLowerCase()
: "";

const marketFilter =
typeof req.query.market === "string"
? req.query.market.trim().toLowerCase()
: "";

const forceRefresh = getBooleanQuery(
req.query.refresh,
false
);

const markets =
await derivMarketService.activeSymbols({
forceRefresh,
});

let filtered = Array.isArray(markets)
? markets
: [];

if (marketFilter) {
filtered = filtered.filter((item) => {
const haystack = [
item.market,
item.market_display_name,
item.marketDisplayName,
]
.filter(Boolean)
.join(" ")
.toLowerCase();


  return haystack.includes(marketFilter);
});


}

if (search) {
filtered = filtered.filter((item) => {
const haystack = [
item.symbol,
item.display_name,
item.displayName,
item.underlying_symbol_name,
item.underlyingSymbolName,
item.market,
item.market_display_name,
item.marketDisplayName,
item.submarket,
item.submarket_display_name,
item.submarketDisplayName,
item.subgroup,
item.subgroup_display_name,
item.subgroupDisplayName,
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
source: "Deriv",
},
});
}

/* ============================================================
GET MULTIPLE LIVE PRICES
============================================================ */

/**

* GET /api/v1/markets/prices
* GET /api/v1/markets/prices?limit=100
* GET /api/v1/markets/prices?symbols=R_100,R_50
*
* IMPORTANT:
* When symbols are omitted, the endpoint automatically selects
* currently tradable Deriv markets up to the requested limit.
*
* No request body is required for GET requests.
  */
  export async function prices(req, res) {
  const limit = getLimit(
  req.query.limit,
  100,
  1000
  );

const forceRefresh = getBooleanQuery(
req.query.refresh,
false
);

const requestedSymbols =
parseSymbols(req.query.symbols);

let symbols = requestedSymbols;

/**

* GET /markets/prices with no symbols:
* Select real currently tradable markets from Deriv.
  */
  if (!symbols) {
  const markets =
  await derivMarketService.activeSymbols({
  forceRefresh,
  });


symbols = (Array.isArray(markets)



  ? markets
  : [])
  .filter(
    (market) =>
      market?.symbol &&
      market.isTradingAvailable !== false &&
      market.isTradingSuspended !== true
  )
  .slice(0, limit)
  .map((market) => market.symbol);


}

/**

* Respect the limit for explicit requests as well, preventing
* accidentally expensive requests.
  */
  symbols = symbols.slice(0, limit);

if (symbols.length === 0) {
return res.status(200).json({
success: true,
data: [],
meta: {
total: 0,
successful: 0,
failed: 0,
requested: 0,
source: "Deriv",
updatedAt: new Date().toISOString(),
},
});
}

/**

* IMPORTANT:
* DerivMarketService.prices() expects an array as its first
* argument, not { symbols, limit }.
  */
  const rawPrices =
  await derivMarketService.prices(
  symbols,
  { forceRefresh }
  );

const results = Array.isArray(rawPrices)
? rawPrices
: [];

const data = results
.map((item, index) =>
serializePrice(
item,
symbols[index] || null
)
)
.filter(Boolean);

const successful =
data.filter(
(item) => item.success === true
).length;

return res.status(200).json({
success: true,
data,
meta: {
total: data.length,
requested: symbols.length,
successful,
failed: data.length - successful,
source: "Deriv",
updatedAt: new Date().toISOString(),
},
});
}

/* ============================================================
GET ONE MARKET WITH LIVE PRICE
============================================================ */

export async function one(req, res) {
const symbol = getSymbol(req);

const market =
await derivMarketService.symbol(symbol);

if (!market) {
throw new AppError(
`Market "${symbol}" was not found`,
404,
"MARKET_NOT_FOUND"
);
}

let livePrice = null;

/**

* A temporary price failure should not hide valid market
* metadata from the user.
  */
  try {
  livePrice =
  await derivMarketService.price(
  market.symbol
  );
  } catch {
  livePrice = null;
  }

const normalizedPrice =
serializePrice(
livePrice,
market.symbol
);

const data = serializeMarket({
...market,


price:
  normalizedPrice?.price ??
  null,

latestPrice:
  normalizedPrice?.latestPrice ??
  null,

lastPrice:
  normalizedPrice?.lastPrice ??
  null,

quote:
  normalizedPrice?.quote ??
  null,

bid:
  normalizedPrice?.bid ??
  null,

ask:
  normalizedPrice?.ask ??
  null,

epoch:
  normalizedPrice?.epoch ??
  null,

updatedAt:
  normalizedPrice?.updatedAt ??
  null,

priceStatus:
  normalizedPrice?.priceStatus ||
  "unavailable",


});

return res.status(200).json({
success: true,
data,
});
}

/* ============================================================
GET SINGLE VERIFIED LIVE PRICE
============================================================ */

export async function price(req, res) {
const symbol = getSymbol(req);

const market =
await derivMarketService.symbol(symbol);

if (!market) {
throw new AppError(
`Market "${symbol}" was not found`,
404,
"MARKET_NOT_FOUND"
);
}

const result =
await derivMarketService.price(
market.symbol,
{
waitForLivePrice: true,
forceRefresh: getBooleanQuery(
req.query.refresh,
false
),
}
);

const data =
serializePrice(
result,
market.symbol
);

if (
!data ||
data.success === false ||
data.quote === null
) {
throw new AppError(
`A verified live price is currently unavailable for "${market.symbol}"`,
503,
"PRICE_UNAVAILABLE"
);
}

return res.status(200).json({
success: true,
data,
});
}

/* ============================================================
GET HISTORICAL CANDLES
============================================================ */

/**

* GET /api/v1/markets/:symbol/candles
*
* Query parameters:
* * granularity
* * count
* * start
* * end
    */
    export async function candles(req, res) {
    const symbol = getSymbol(req);

const granularity = getLimit(
req.query.granularity,
60,
86_400
);

const count = getLimit(
req.query.count,
100,
5_000
);

const start = getOptionalNumber(
req.query.start
);

const end = getOptionalNumber(
req.query.end
);

if (
start !== undefined &&
end !== undefined &&
start >= end
) {
throw new AppError(
"The candle start time must be earlier than the end time",
400,
"VALIDATION_ERROR"
);
}

const result =
await derivMarketService.candles(
symbol,
{
granularity,
count,
start,
end,
}
);

const rawCandles =
Array.isArray(result?.candles)
? result.candles
: [];

const data = rawCandles
.map(serializeCandle)
.filter(
(candle) =>
candle &&
candle.epoch !== null &&
candle.open !== null &&
candle.high !== null &&
candle.low !== null &&
candle.close !== null
);

return res.status(200).json({
success: true,
data: {
symbol:
result?.symbol ||
symbol,


  displayName:
    result?.displayName ||
    symbol,

  granularity,

  count: data.length,

  candles: data,
},
meta: {
  source: "Deriv",
},


});
}

/* ============================================================
GET AVAILABLE CONTRACTS
============================================================ */

/**

* GET /api/v1/markets/:symbol/contracts
  */
  export async function contracts(req, res) {
  const symbol = getSymbol(req);

const result =
await derivMarketService.contractsFor(
symbol
);

const availableContracts =
Array.isArray(result?.contracts)
? result.contracts
: [];

return res.status(200).json({
success: true,


data: {
  symbol:
    result?.symbol ||
    symbol,

  displayName:
    result?.displayName ||
    result?.display_name ||
    symbol,

  contracts:
    availableContracts,
},

meta: {
  symbol:
    result?.symbol ||
    symbol,

  total:
    availableContracts.length,

  source: "Deriv",
},


});
}

/* ============================================================
REFRESH MARKET CATALOGUE
============================================================ */

/**

* POST /api/v1/markets/refresh
*
* Clears the local metadata and price caches and retrieves a
* fresh market catalogue directly from Deriv.
  */
  export async function refresh(req, res) {
  const markets =
  await derivMarketService.refresh();

const rawMarkets =
Array.isArray(markets)
? markets
: [];

const data = rawMarkets
.map(serializeMarket)
.filter(Boolean);

return res.status(200).json({
success: true,
message:
"Market catalogue refreshed successfully",
data,
meta: {
total: data.length,
source: "Deriv",
refreshedAt: new Date().toISOString(),
},
});
}
