import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/**

* Maximum time allowed for one Gemini analysis request.
*
* If Gemini does not respond within this period, the automated
* trading engine receives a safe HOLD signal.
  */
  const AI_TIMEOUT_MS = 20_000;

const MAX_CONTEXT_ITEMS = 100;
const MAX_STRING_LENGTH = 2_000;

/* ============================================================
VALIDATION
============================================================ */

const analysisSchema = z
.object({
action: z.enum(["BUY", "SELL", "HOLD"]),


confidence: z
  .number()
  .finite()
  .min(0)
  .max(1),

market: z
  .string()
  .trim()
  .min(1)
  .max(100),

reason: z
  .string()
  .trim()
  .min(1)
  .max(1_000),

recommendedParameters: z
  .record(z.string(), z.unknown())
  .default({}),


})
.strict();

const contextSchema = z
.object({
symbol: z
.string()
.trim()
.min(1)
.max(100),


currentPrice: z
  .number()
  .finite()
  .positive(),

currency: z
  .string()
  .trim()
  .min(1)
  .max(20)
  .optional()
  .nullable(),

timestamp: z
  .string()
  .datetime()
  .optional(),

indicators: z
  .record(z.string(), z.unknown())
  .optional(),

marketData: z
  .record(z.string(), z.unknown())
  .optional(),


})
.strict();

/* ============================================================
HELPERS
============================================================ */

function sanitizeValue(value, depth = 0) {
if (depth > 4) {
return "[MAX_DEPTH_REACHED]";
}

if (value === null) {
return null;
}

if (typeof value === "string") {
return value.slice(0, MAX_STRING_LENGTH);
}

if (typeof value === "boolean") {
return value;
}

if (typeof value === "number") {
return Number.isFinite(value)
? value
: null;
}

if (Array.isArray(value)) {
return value
.slice(0, MAX_CONTEXT_ITEMS)
.map((item) =>
sanitizeValue(item, depth + 1),
);
}

if (
typeof value === "object" &&
value !== null
) {
return Object.fromEntries(
Object.entries(value)
.slice(0, MAX_CONTEXT_ITEMS)
.map(([key, item]) => [
String(key).slice(0, 100),
sanitizeValue(item, depth + 1),
]),
);
}

return String(value).slice(0, 500);
}

function normalizeMarket(value) {
return String(value || "")
.trim()
.toUpperCase();
}

function parseModelJson(text) {
if (!text || typeof text !== "string") {
throw new AppError(
"Gemini returned an empty response",
502,
"GEMINI_EMPTY_RESPONSE",
);
}

const cleaned = text
.trim()
.replace(/^`json\s*/i, "")
    .replace(/^`\s*/i, "")
.replace(/\s*$/i, "")
.trim();

if (!cleaned) {
throw new AppError(
"Gemini returned an empty response",
502,
"GEMINI_EMPTY_RESPONSE",
);
}

try {
return JSON.parse(cleaned);
} catch {
throw new AppError(
"Gemini returned invalid JSON",
502,
"GEMINI_INVALID_JSON",
);
}
}

/**

* Reject the caller after timeout.
*
* Note: Promise.race cannot necessarily cancel the underlying SDK
* request, but it prevents the trading cycle from waiting forever.
  */
  function withTimeout(
  promise,
  timeoutMs,
  message,
  ) {
  let timer;

const timeoutPromise = new Promise(
(_, reject) => {
timer = setTimeout(() => {
reject(
new AppError(
message,
504,
"GEMINI_TIMEOUT",
),
);
}, timeoutMs);
},
);

return Promise.race([
promise,
timeoutPromise,
]).finally(() => {
if (timer) {
clearTimeout(timer);
}
});
}

/* ============================================================
GEMINI TRADING ANALYSIS SERVICE
============================================================ */

/**

* Gemini provides the AI trading signal.
*
* Flow:
*
* Market Data
* 
   ↓

* Gemini Analysis
* 
   ↓

* Strategy Validation
* 
   ↓

* Risk Management
* 
   ↓

* Backend-controlled Deriv Execution
*
* Gemini NEVER receives the Deriv token and NEVER calls Deriv.
  */
  export class GeminiTradingService {
  constructor() {
  if (!env.GEMINI_API_KEY) {
  throw new Error(
  "GEMINI_API_KEY is not configured",
  );
  }

  if (!env.GEMINI_MODEL) {
  throw new Error(
  "GEMINI_MODEL is not configured",
  );
  }

  this.client = new GoogleGenerativeAI(
  env.GEMINI_API_KEY,
  );

  this.model =
  this.client.getGenerativeModel({
  model: env.GEMINI_MODEL,


   generationConfig: {
     responseMimeType:
       "application/json",

     temperature: 0.2,

     maxOutputTokens: 1_200,
   },


  });
  }

/**

* Generate an AI trading analysis.
*
* The returned BUY/SELL/HOLD is a signal used by the backend.
* It is never directly sent to the Deriv API.
  */
  async analyze(context) {
  let validatedContext;


try {



  validatedContext =
    contextSchema.parse(context);
} catch {
  throw new AppError(
    "Invalid market analysis context",
    400,
    "INVALID_ANALYSIS_CONTEXT",
  );
}

const expectedMarket =
  normalizeMarket(
    validatedContext.symbol,
  );

const safeContext = sanitizeValue({
  symbol: expectedMarket,

  currentPrice:
    validatedContext.currentPrice,

  currency:
    validatedContext.currency || null,

  timestamp:
    validatedContext.timestamp ||
    new Date().toISOString(),

  indicators:
    validatedContext.indicators || {},

  marketData:
    validatedContext.marketData || {},
});

const prompt = `


You are an AI market-analysis component inside an automated trading system.

Your role is to analyze ONLY the market data supplied by the backend.

You do not have access to live prices, news, trading accounts,
balances, positions, credentials, or any information not explicitly
provided below.

Return exactly one JSON object:

{
"action": "BUY" | "SELL" | "HOLD",
"confidence": number between 0 and 1,
"market": "${expectedMarket}",
"reason": "brief evidence-based explanation",
"recommendedParameters": {}
}

RULES:

1. BUY and SELL are trading ANALYSIS signals.
2. The backend independently validates every signal.
3. If data is insufficient, conflicting, stale, or ambiguous, return HOLD.
4. Never invent prices, indicators, trends, news, or historical data.
5. Never guarantee profit or a successful trade.
6. Confidence is confidence in the analytical signal, not probability of profit.
7. recommendedParameters are informational only and are not executable.
8. Return only valid JSON without Markdown.

MARKET DATA:

${JSON.stringify(safeContext)}
`.trim();


let result;

try {
  result = await withTimeout(
    this.model.generateContent(prompt),
    AI_TIMEOUT_MS,
    "Gemini market analysis timed out",
  );
} catch (error) {
  if (error instanceof AppError) {
    throw error;
  }

  throw new AppError(
    error?.message ||
      "Gemini market analysis failed",
    502,
    "GEMINI_ANALYSIS_FAILED",
  );
}

let text;

try {
  text = result?.response?.text?.();
} catch {
  throw new AppError(
    "Unable to read Gemini analysis response",
    502,
    "GEMINI_RESPONSE_READ_FAILED",
  );
}

const parsed = parseModelJson(text);

let analysis;

try {
  analysis =
    analysisSchema.parse(parsed);
} catch {
  throw new AppError(
    "Gemini returned an invalid analysis structure",
    502,
    "GEMINI_INVALID_ANALYSIS",
  );
}

const returnedMarket =
  normalizeMarket(analysis.market);

if (returnedMarket !== expectedMarket) {
  throw new AppError(
    "Gemini returned analysis for an unexpected market",
    502,
    "GEMINI_MARKET_MISMATCH",
  );
}

return {
  ...analysis,
  market: expectedMarket,
  analyzedAt:
    new Date().toISOString(),
  source: "gemini",
};


}

/**

* Safe method for the automatic trading engine.
*
* Timeout, network errors, invalid JSON, or Gemini failures
* always result in HOLD.
  */
  async analyzeSafely(context) {
  try {
  return await this.analyze(context);
  } catch (error) {
  console.error(
  "Gemini analysis failed:",
  error?.message || error,
  );

  return {
  action: "HOLD",
  confidence: 0,

  market: normalizeMarket(
  context?.symbol || "UNKNOWN",
  ),

  reason:
  "AI analysis is unavailable, timed out, or returned invalid data. No trade signal was accepted.",

  recommendedParameters: {},

  analyzedAt:
  new Date().toISOString(),

  source: "gemini",

  errorCode:
  error?.code ||
  "GEMINI_ANALYSIS_FAILED",
  };
  }
  }
  }

export const geminiTradingService =
new GeminiTradingService();
