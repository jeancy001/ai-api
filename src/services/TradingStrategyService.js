import { AppError } from "../utils/AppError.js";

/**
 * TradingStrategyService
 *
 * IMPORTANT:
 * This service validates whether an analysis signal is eligible to
 * continue through the trading pipeline. It does NOT execute trades
 * and does NOT bypass risk management.
 *
 * Final trade authorization must still be performed by:
 * - Trading settings checks
 * - RiskManagementService
 * - Deriv account validation
 * - Contract validation
 * - TradeExecutionService
 */
export class TradingStrategyService {
  /**
   * Validate an AI/strategy signal against the available market data.
   *
   * @param {object} signal - Analysis result.
   * @param {object} market - Latest market tick/data.
   * @param {object} options - Optional explicit strategy constraints.
   */
  validate(signal, market, options = {}) {
    const reasons = [];
    const warnings = [];

    const {
      minimumConfidence = 0,
      expectedSymbol = null,
      maxSignalAgeMs = 30_000,
    } = options;

    /**
     * Validate signal structure defensively.
     */
    if (!signal || typeof signal !== "object") {
      return {
        approved: false,
        reasons: ["INVALID_TRADING_SIGNAL"],
        warnings,
      };
    }

    const action = String(signal.action || "")
      .trim()
      .toUpperCase();

    if (!["BUY", "SELL", "HOLD"].includes(action)) {
      reasons.push("INVALID_SIGNAL_ACTION");
    }

    /**
     * HOLD is never a trade instruction.
     */
    if (action === "HOLD") {
      reasons.push("AI_HOLD");
    }

    /**
     * Confidence must be a finite value between 0 and 1.
     */
    const confidence = Number(signal.confidence);

    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      reasons.push("INVALID_SIGNAL_CONFIDENCE");
    } else if (confidence < minimumConfidence) {
      reasons.push("STRATEGY_CONFIDENCE_TOO_LOW");
    }

    /**
     * Market data must exist and contain a valid positive quote.
     *
     * Do not use `if (!market.quote)` because a numeric validation
     * is safer and makes the reason explicit.
     */
    if (!market || typeof market !== "object") {
      reasons.push("NO_FRESH_MARKET_DATA");
    } else {
      const quote = Number(market.quote);

      if (!Number.isFinite(quote) || quote <= 0) {
        reasons.push("INVALID_MARKET_PRICE");
      }

      /**
       * Ensure the returned tick belongs to the expected symbol when
       * both values are available.
       */
      if (
        expectedSymbol &&
        market.symbol &&
        String(market.symbol) !== String(expectedSymbol)
      ) {
        reasons.push("MARKET_SYMBOL_MISMATCH");
      }

      /**
       * Reject stale market data when the tick provides an epoch.
       * Deriv ticks commonly use epoch in seconds.
       */
      if (market.epoch !== undefined && market.epoch !== null) {
        const epoch = Number(market.epoch);

        if (Number.isFinite(epoch) && epoch > 0) {
          const marketTimeMs = epoch * 1000;
          const ageMs = Date.now() - marketTimeMs;

          if (ageMs > maxSignalAgeMs) {
            reasons.push("STALE_MARKET_DATA");
          }

          /**
           * A significantly future timestamp can indicate invalid data
           * or clock problems. Don't silently trade on it.
           */
          if (ageMs < -60_000) {
            reasons.push("INVALID_MARKET_TIMESTAMP");
          }
        } else {
          warnings.push("MARKET_TIMESTAMP_UNAVAILABLE");
        }
      } else {
        warnings.push("MARKET_TIMESTAMP_UNAVAILABLE");
      }
    }

    /**
     * Ensure the signal is for the market currently being evaluated.
     */
    if (
      expectedSymbol &&
      signal.market &&
      String(signal.market) !== String(expectedSymbol)
    ) {
      reasons.push("SIGNAL_MARKET_MISMATCH");
    }

    /**
     * A reason is useful for auditability, but absence of a reason
     * should not be confused with permission to execute.
     */
    const approved = reasons.length === 0;

    return {
      approved,
      action: action || null,
      confidence: Number.isFinite(confidence)
        ? confidence
        : null,
      reasons,
      warnings,

      /**
       * This means only that the strategy validation passed.
       * It is NOT final authorization to execute a real trade.
       */
      executionAuthorized: false,
    };
  }

  /**
   * Convert an approved analysis action into a neutral direction.
   *
   * Contract-specific mapping must be explicitly configured elsewhere.
   * This method intentionally does not invent Deriv contract types.
   */
  getDirection(signal) {
    const action = String(signal?.action || "")
      .trim()
      .toUpperCase();

    if (action === "BUY") {
      return "BUY";
    }

    if (action === "SELL") {
      return "SELL";
    }

    return null;
  }

  /**
   * Require explicit contract configuration before execution.
   *
   * This prevents the system from guessing contract parameters based
   * only on an AI BUY/SELL response.
   */
  validateContractParameters(parameters) {
    if (
      !parameters ||
      typeof parameters !== "object"
    ) {
      throw new AppError(
        "Explicit contract parameters are required",
        400,
        "CONTRACT_PARAMETERS_REQUIRED"
      );
    }

    const contractType =
      parameters.contractType ||
      parameters.contract_type;

    if (
      !contractType ||
      typeof contractType !== "string"
    ) {
      throw new AppError(
        "A contract type must be explicitly configured",
        400,
        "CONTRACT_TYPE_REQUIRED"
      );
    }

    return {
      valid: true,
      contractType: contractType.trim().toUpperCase(),
    };
  }
}

export const tradingStrategyService =
  new TradingStrategyService();