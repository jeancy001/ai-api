import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";

import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/* ============================================================
CONFIGURATION
============================================================ */

const AI_TIMEOUT_MS = 20_000;
const AI_MAX_RETRIES = 2;
const AI_RETRY_DELAY_MS = 1_500;

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

function sleep(ms) {
return new Promise((resolve) => {
setTimeout(resolve, ms);
});
}

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
sanitizeValue(item, depth + 1)
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
])
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
"GEMINI_EMPTY_RESPONSE"
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
"GEMINI_EMPTY_RESPONSE"
);
}

try {
return JSON.parse(cleaned);
} catch {
throw new AppError(
"Gemini returned invalid JSON",
502,
"GEMINI_INVALID_JSON"
);
}
}

function withTimeout(
promise,
timeoutMs,
message
) {
let timer;

const timeoutPromise = new Promise(
(_, reject) => {
timer = setTimeout(() => {
reject(
new AppError(
message,
504,
"GEMINI_TIMEOUT"
)
);
}, timeoutMs);
}
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

/**

* Some failures are temporary: network interruptions,
* provider overload, or timeouts.
*
* These should not stop the trading engine.
  */
  function isRetryableError(error) {
  const status =
  Number(error?.status) ||
  Number(error?.statusCode) ||
  Number(error?.response?.status);

const code = String(
error?.code || ""
).toUpperCase();

if (
status === 408 ||
status === 429 ||
status >= 500
) {
return true;
}

return [
"GEMINI_TIMEOUT",
"GEMINI_ANALYSIS_FAILED",
"ECONNRESET",
"ETIMEDOUT",
"ENOTFOUND",
].includes(code);
}

/* ============================================================
GEMINI TRADING ANALYSIS SERVICE
============================================================ */

/**

* Gemini is an ANALYSIS component.
*
* The application scheduler remains responsible for continuing
* future analysis cycles.
*
* Important behavior:
*
* * BUY/SELL -> candidate signal for backend validation.
* * HOLD -> no trade this cycle; analyze again next cycle.
* * AI failure -> no trade this cycle; analyze again next cycle.
*
* Gemini cannot directly:
* * stop the engine
* * activate Emergency Stop
* * change account settings
* * execute a Deriv order
    */
    export class GeminiTradingService {
    constructor() {
    if (!env.GEMINI_API_KEY) {
    throw new Error(
    "GEMINI_API_KEY is not configured"
    );
    }

  if (!env.GEMINI_MODEL) {
  throw new Error(
  "GEMINI_MODEL is not configured"
  );
  }

  this.client = new GoogleGenerativeAI(
  env.GEMINI_API_KEY
  );

  this.model =
  this.client.getGenerativeModel({
  model: env.GEMINI_MODEL,

  
   generationConfig: {
     responseMimeType:
       "application/json",

     /**
      * Lower temperature makes structured analysis more
      * consistent. It does not guarantee correctness.
      */
     temperature: 0.2,

     maxOutputTokens: 1_200,
   },
  

  });
  }

/**

* Execute one AI request.
  */
  async requestAnalysis(prompt) {
  let lastError;


for (



  let attempt = 1;
  attempt <= AI_MAX_RETRIES + 1;
  attempt += 1
) {
  try {
    const result = await withTimeout(
      this.model.generateContent(prompt),
      AI_TIMEOUT_MS,
      "Gemini market analysis timed out"
    );

    return result;
  } catch (error) {
    lastError = error;

    const shouldRetry =
      attempt <= AI_MAX_RETRIES &&
      isRetryableError(error);

    if (!shouldRetry) {
      break;
    }

    console.warn(
      `Gemini analysis attempt ${attempt} failed. Retrying...`,
      error?.message || error
    );

    await sleep(
      AI_RETRY_DELAY_MS * attempt
    );
  }
}

if (lastError instanceof AppError) {
  throw lastError;
}

throw new AppError(
  lastError?.message ||
    "Gemini market analysis failed",
  502,
  "GEMINI_ANALYSIS_FAILED"
);


}

/**

* Generate one market analysis.
*
* This method does NOT decide whether a real trade is allowed.
* AutoTradingService must independently validate the result.
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
    "INVALID_ANALYSIS_CONTEXT"
  );
}

const expectedMarket =
  normalizeMarket(
    validatedContext.symbol
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

Analyze ONLY the market data supplied by the backend.

Your task is to identify whether the supplied evidence currently
supports a directional BUY signal, a directional SELL signal, or
HOLD.

Return exactly one JSON object:

{
"action": "BUY" | "SELL" | "HOLD",
"confidence": number between 0 and 1,
"market": "${expectedMarket}",
"reason": "brief evidence-based explanation",
"recommendedParameters": {}
}

ANALYSIS RULES:

1. Use only the supplied market data and indicators.
2. Do not invent prices, trends, indicators, historical events, news, or account information.
3. BUY or SELL should be returned only when the supplied data provides a coherent directional signal.
4. HOLD means conditions are currently unclear or insufficient. HOLD DOES NOT stop the trading engine.
5. A HOLD signal means the system should wait for the next market update and analyze again.
6. Confidence describes confidence in the analytical signal, not the probability of profit.
7. Never guarantee profit, winning trades, or market direction.
8. recommendedParameters are informational and non-executable.
9. You cannot execute trades, change settings, stop trading, or activate Emergency Stop.
10. Return only valid JSON. Do not use Markdown.

MARKET DATA:

${JSON.stringify(safeContext)}
`.trim();


const result =
  await this.requestAnalysis(prompt);

let text;

try {
  text =
    result?.response?.text?.();
} catch {
  throw new AppError(
    "Unable to read Gemini analysis response",
    502,
    "GEMINI_RESPONSE_READ_FAILED"
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
    "GEMINI_INVALID_ANALYSIS"
  );
}

const returnedMarket =
  normalizeMarket(analysis.market);

if (returnedMarket !== expectedMarket) {
  throw new AppError(
    "Gemini returned analysis for an unexpected market",
    502,
    "GEMINI_MARKET_MISMATCH"
  );
}

return {
  ...analysis,

  market: expectedMarket,

  analyzedAt:
    new Date().toISOString(),

  source: "gemini",

  /**
   * Explicitly identifies that the analysis was successful.
   * HOLD can still be a successful analysis.
   */
  analysisAvailable: true,

  /**
   * HOLD is a normal analysis outcome, not a stopped engine.
   */
  shouldContinueAnalyzing: true,

  emergencyStopRequested: false,
};


}

/**

* Safe interface used by AutoTradingService.
*
* CRITICAL:
* An AI failure only skips the current execution opportunity.
* The AutoTradingService scheduler must remain active and call
* this method again during the next scheduled analysis cycle.
  */
  async analyzeSafely(context) {
  try {
  return await this.analyze(context);
  } catch (error) {
  console.error(
  "Gemini analysis unavailable for current cycle:",
  error?.message || error
  );

  return {
  action: "HOLD",
  confidence: 0,

  market: normalizeMarket(
  context?.symbol || "UNKNOWN"
  ),

  reason:
  "AI analysis was temporarily unavailable for this cycle. No trade will be opened from this analysis cycle, and the trading engine should continue collecting market data and analyzing future cycles.",

  recommendedParameters: {},

  analyzedAt:
  new Date().toISOString(),

  source: "gemini",

  analysisAvailable: false,

  /**
  * The scheduler should continue normally.
  */
  shouldContinueAnalyzing: true,

  errorCode:
  error?.code ||
  "GEMINI_ANALYSIS_FAILED",

  /**
  * AI analysis NEVER requests an emergency stop.
  */
  emergencyStopRequested: false,
  };
  }
  }
  }

export const geminiTradingService =
new GeminiTradingService();
