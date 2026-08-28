import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/**

* Maximum time allowed for one Gemini analysis request.
*
* A Gemini timeout or temporary failure does NOT activate Emergency Stop.
* The trading cycle simply receives a safe HOLD signal and waits for the
* next scheduled cycle.
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

/**

* Reject waiting after the configured timeout.
*
* A timeout does NOT activate Emergency Stop. It only prevents one
* analysis request from blocking the current trading cycle forever.
  */
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

/* ============================================================
GEMINI TRADING ANALYSIS SERVICE
============================================================ */

/**

* Gemini provides market analysis only.
*
* IMPORTANT:
* * Gemini cannot activate Emergency Stop.
* * Gemini cannot stop the trading engine.
* * Gemini cannot execute Deriv trades.
* * Gemini failures produce HOLD for the current cycle.
*
* Emergency Stop is controlled exclusively by the application's
* explicit backend settings/controller logic.
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

     temperature: 0.2,

     maxOutputTokens: 1_200,
   },
  

  });
  }

/**

* Generate an AI market analysis.
*
* BUY/SELL/HOLD is only an analysis signal. The backend independently
* performs strategy validation, risk management, account validation,
* and execution authorization.
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

1. BUY and SELL are trading ANALYSIS signals only.
2. The backend independently validates every signal.
3. If data is insufficient, conflicting, stale, or ambiguous, return HOLD.
4. Never invent prices, indicators, trends, news, or historical data.
5. Never guarantee profit or a successful trade.
6. Confidence is confidence in the analytical signal, not probability of profit.
7. recommendedParameters are informational only and are never executable.
8. You cannot authorize, execute, stop, or emergency-stop trading.
9. Return only valid JSON without Markdown.

MARKET DATA:

${JSON.stringify(safeContext)}
`.trim();


let result;

try {
  result = await withTimeout(
    this.model.generateContent(prompt),
    AI_TIMEOUT_MS,
    "Gemini market analysis timed out"
  );
} catch (error) {
  if (error instanceof AppError) {
    throw error;
  }

  throw new AppError(
    error?.message ||
      "Gemini market analysis failed",
    502,
    "GEMINI_ANALYSIS_FAILED"
  );
}

let text;

try {
  text = result?.response?.text?.();
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
};


}

/**

* Safe method for AutoTradingService.
*
* Gemini errors do NOT stop the engine and do NOT activate Emergency Stop.
* They only reject the current cycle by returning HOLD.
*
* The next scheduled cycle can analyze the market again normally.
  */
  async analyzeSafely(context) {
  try {
  return await this.analyze(context);
  } catch (error) {
  console.error(
  "Gemini analysis failed for current cycle:",
  error?.message || error
  );

  return {
  action: "HOLD",
  confidence: 0,

  market: normalizeMarket(
  context?.symbol || "UNKNOWN"
  ),

  reason:
  "AI analysis was unavailable for this cycle. Trading was skipped and the engine will continue with the next scheduled cycle.",

  recommendedParameters: {},

  analyzedAt:
  new Date().toISOString(),

  source: "gemini",

  errorCode:
  error?.code ||
  "GEMINI_ANALYSIS_FAILED",

  /**
  * Explicitly documents that this result must not be interpreted
  * as an Emergency Stop request.
  */
  emergencyStopRequested: false,
  };
  }
  }
  }

export const geminiTradingService =
new GeminiTradingService();
