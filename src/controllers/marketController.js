import { derivMarketService } from "../services/DerivMarketService.js";
import { AppError } from "../utils/AppError.js";

/* ============================================================
VALIDATION
============================================================ */

/**

* Preserve the original symbol casing.
*
* Deriv symbols such as frxEURUSD should not be blindly converted
* before being sent to the provider.
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
"VALIDATION_ERROR"
);
}

return symbol;
}

function getLimit(value, fallback = 100, max = 1000) {
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
return undefined;
}

return Math.min(
Math.max(Math.floor(parsed), min),
max
);
}

function numeric(value) {
if (
typeof value === "number" ||
typeof value === "string"
) {
return value;
}

return null;
}

/* ============================================================
SERIALIZERS
============================================================ */

function serializeMarket(market) {
if (!market) return null;

return {
id: market.id || market.symbol || null,
symbol: market.symbol || null,


displayName:
  market.displayName ||
  market.display_name ||
  market.symbol ||
  null,

display_name:
  market.display_name ||
  market.displayName ||
  market.symbol ||
  null,

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
  market.subgroup_display_name ||
  market.submarket ||
  market.subgroup ||
  null,

submarket_display_name:
  market.submarket_display_name ||
  market.submarketDisplayName ||
  market.subgroup_display_name ||
  market.submarket ||
  market.subgroup ||
  null,

subgroup:
  market.subgroup ||
  market.submarket ||
  null,

exchangeIsOpen:
  market.exchangeIsOpen === true ||
  market.exchange_is_open === true ||
  market.exchange_is_open === 1,

exchange_is_open:
  market.exchangeIsOpen === true ||
  market.exchange_is_open === true ||
  market.exchange_is_open === 1,

isTradingSuspended:
  market.isTradingSuspended === true ||
  market.is_trading_suspended === true ||
  market.is_trading_suspended === 1,

pip: market.pip ?? null,
pipSize:
  market.pipSize ??
  market.pip_size ??
  null,

pip_size:
  market.pip_size ??
  market.pipSize ??
  null,

price: numeric(
  market.price ?? market.quote
),

quote: numeric(
  market.quote ?? market.price
),

updatedAt:
  market.updatedAt ||
  market.updated_at ||
  null,


};
}

function serializePrice(price, fallbackSymbol = null) {
if (!price) return null;

if (
typeof price === "number" ||
typeof price === "string"
) {
return {
symbol: fallbackSymbol,
price,
quote: price,
latestPrice: price,
lastPrice: price,
updatedAt: new Date().toISOString(),
};
}

return {
success:
price.success !== false,


symbol:
  price.symbol ||
  price.underlying_symbol ||
  fallbackSymbol ||
  null,

price: numeric(
  price.price ??
  price.quote ??
  price.lastPrice
),

quote: numeric(
  price.quote ??
  price.price ??
  price.lastPrice
),

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

epoch:
  price.epoch ??
  price.timestamp ??
  null,

pipSize:
  price.pipSize ??
  price.pip_size ??
  null,

updatedAt:
  price.updatedAt ||
  price.receivedAt ||
  new Date().toISOString(),

error:
  price.success === false
    ? price.error || "Price unavailable"
    : undefined,


};
}

function serializeCandle(candle) {
if (!candle) return null;

return {
epoch:
candle.epoch ??
candle.open_time ??
candle.time ??
null,


time:
  candle.time ??
  candle.open_time ??
  candle.epoch ??
  null,

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
MARKET LIST
============================================================ */

export async function list(req, res) {
const limit = getLimit(
req.query.limit,
500
);

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
const haystack = [
item.market,
item.market_display_name,
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
source: "Deriv",
},
});
}

/* ============================================================
LIVE PRICES
============================================================ */

/**

* GET /api/v1/markets/prices?limit=100
*
* Returns real prices from Deriv. Individual symbol failures do not
* fail the entire response.
  */
  export async function prices(req, res) {
  const limit = getLimit(
  req.query.limit,
  100,
  1000
  );

const requestedSymbols =
typeof req.query.symbols === "string"
? req.query.symbols
.split(",")
.map((value) => value.trim())
.filter(Boolean)
: [];

const result =
await derivMarketService.prices({
symbols: requestedSymbols,
limit,
});

const data = result
.map((item) =>
serializePrice(item, item.symbol)
)
.filter(Boolean);

const successfulPrices = data.filter(
(item) => item.success !== false
);

return res.status(200).json({
success: true,
data,
meta: {
total: data.length,
successful: successfulPrices.length,
failed:
data.length - successfulPrices.length,
source: "Deriv",
updatedAt: new Date().toISOString(),
},
});
}

/* ============================================================
SINGLE MARKET
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

try {
livePrice =
await derivMarketService.price(symbol);
} catch (error) {
console.warn(
`Live price unavailable for ${symbol}:`,
error?.message || error
);
}

const normalizedPrice =
serializePrice(livePrice, market.symbol);

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
updatedAt:
normalizedPrice?.updatedAt ??
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
await derivMarketService.price(symbol);

const data =
serializePrice(result, market.symbol);

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
"PRICE_UNAVAILABLE"
);
}

return res.status(200).json({
success: true,
data,
});
}

/* ============================================================
HISTORICAL CANDLES
============================================================ */

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
await derivMarketService.candles(symbol, {
granularity,
count,
start,
end,
});

const rawCandles =
Array.isArray(result?.candles)
? result.candles
: [];

const data = rawCandles
.map(serializeCandle)
.filter(
(candle) =>
candle &&
candle.open !== null &&
candle.high !== null &&
candle.low !== null &&
candle.close !== null
);

return res.status(200).json({
success: true,
data: {
symbol: result.symbol,
granularity,
count: data.length,
candles: data,
},
});
}

/* ============================================================
CONTRACTS
============================================================ */

export async function contracts(req, res) {
const symbol = getSymbol(req);

const result =
await derivMarketService.contractsFor(symbol);

const data = Array.isArray(result?.contracts)
? result.contracts
: [];

return res.status(200).json({
success: true,
data,
meta: {
symbol: result?.symbol || symbol,
displayName:
result?.displayName || symbol,
total: data.length,
},
});
}

/* ============================================================
REFRESH
============================================================ */

export async function refresh(req, res) {
const markets =
await derivMarketService.refresh();

const data = Array.isArray(markets)
? markets
.map(serializeMarket)
.filter(Boolean)
: [];

return res.status(200).json({
success: true,
message: "Markets refreshed successfully",
data,
meta: {
total: data.length,
source: "Deriv",
refreshedAt: new Date().toISOString(),
},
});
}
