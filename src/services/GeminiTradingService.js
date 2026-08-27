import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

const AI_TIMEOUT_MS = 20_000;

/**
 * The model is allowed to produce a market-analysis signal only.
 *
 * IMPORTANT:
 * recommendedParameters are suggestions, not executable Deriv
 * contract parameters. The backend must validate every parameter
 * independently before execution.
 */
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
      .max(1000),

    recommendedParameters: z
      .record(z.string(), z.unknown())
      .default({}),
  })
  .strict();

/**
 * Validate the minimum context required for useful analysis.
 *
 * Do not send tokens, credentials, internal account identifiers,
 * or unnecessary personal information to the AI model.
 */
const contextSchema = z
  .object({
    symbol: z.string().trim().min(1).max(100),

    currentPrice: z
      .number()
      .finite()
      .positive(),

    currency: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .optional(),

    timestamp: z.string().datetime().optional(),

    /**
     * Optional market indicators or historical information.
     * Keep these structured and bounded.
     */
    indicators: z
      .record(z.string(), z.unknown())
      .optional(),

    marketData: z
      .record(z.string(), z.unknown())
      .optional(),
  })
  .passthrough();

/**
 * Remove characters that could unnecessarily increase prompt size
 * and limit recursive/unbounded payloads.
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 4) {
    return "[MAX_DEPTH_REACHED]";
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) =>
        sanitizeValue(item, depth + 1)
      );
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          String(key).slice(0, 100),
          sanitizeValue(item, depth + 1),
        ])
    );
  }

  return String(value).slice(0, 500);
}

/**
 * Extract JSON defensively.
 *
 * responseMimeType should already produce JSON, but this protects
 * against accidental Markdown fences or surrounding whitespace.
 */
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
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

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
 * Promise timeout helper.
 */
function withTimeout(
  promise,
  timeoutMs,
  message
) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError(
          message,
          504,
          "GEMINI_TIMEOUT"
        )
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(
    () => clearTimeout(timer)
  );
}

export class GeminiTradingService {
  constructor() {
    if (!env.GEMINI_API_KEY) {
      throw new Error(
        "GEMINI_API_KEY is not configured"
      );
    }

    this.client = new GoogleGenerativeAI(
      env.GEMINI_API_KEY
    );

    this.model = this.client.getGenerativeModel({
      model: env.GEMINI_MODEL,

      generationConfig: {
        responseMimeType: "application/json",

        /**
         * Lower temperature improves consistency for structured
         * analytical output. This does NOT make predictions reliable.
         */
        temperature: 0.2,

        maxOutputTokens: 1200,
      },
    });
  }

  /**
   * Generate an AI market-analysis signal.
   *
   * This method NEVER executes a trade.
   */
  async analyze(context) {
    const validatedContext =
      contextSchema.parse(context);

    const safeContext = sanitizeValue({
      symbol: validatedContext.symbol,
      currentPrice: validatedContext.currentPrice,
      currency: validatedContext.currency,
      timestamp:
        validatedContext.timestamp ||
        new Date().toISOString(),
      indicators: validatedContext.indicators,
      marketData: validatedContext.marketData,
    });

    const prompt = `
You are a market-analysis component inside a backend trading system.

Your role is ANALYSIS ONLY.

You MUST NOT claim to execute, authorize, purchase, sell, or place a trade.

Analyze ONLY the supplied market data. Do not assume access to live
prices, account balances, positions, news, or information that was not
explicitly provided.

Return exactly one JSON object with this structure:

{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number between 0 and 1,
  "market": "string",
  "reason": "brief explanation",
  "recommendedParameters": {}
}

Rules:

1. If the supplied data is insufficient or ambiguous, choose HOLD.
2. Never claim certainty or guarantee profit.
3. Confidence represents uncertainty in your analysis, not probability
   of profit.
4. Do not invent market data.
5. recommendedParameters are analytical suggestions only.
6. Do not include credentials, tokens, account identifiers, or secrets.
7. Your output is consumed by backend validation and may be rejected.
8. The backend risk engine has final authority over every trade.

Supplied market data:

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

    const text = result?.response?.text?.();

    const parsed = parseModelJson(text);

    const analysis =
      analysisSchema.parse(parsed);

    /**
     * Prevent the model from returning analysis for a different market.
     */
    if (
      analysis.market.toLowerCase() !==
      validatedContext.symbol.toLowerCase()
    ) {
      throw new AppError(
        "Gemini returned analysis for an unexpected market",
        502,
        "GEMINI_MARKET_MISMATCH"
      );
    }

    return {
      ...analysis,

      /**
       * Server-generated metadata is more trustworthy than
       * model-generated metadata.
       */
      analyzedAt: new Date().toISOString(),

      source: "gemini",
    };
  }

  /**
   * Safe wrapper for automated systems.
   *
   * If Gemini is unavailable or produces invalid output, return HOLD
   * rather than allowing an exception to accidentally trigger an
   * alternative execution path.
   */
  async analyzeSafely(context) {
    try {
      return await this.analyze(context);
    } catch (error) {
      return {
        action: "HOLD",
        confidence: 0,
        market: String(
          context?.symbol || "UNKNOWN"
        ),
        reason:
          "AI analysis is unavailable or invalid. No trade signal was accepted.",
        recommendedParameters: {},
        analyzedAt: new Date().toISOString(),
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