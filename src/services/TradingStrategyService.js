import { AppError } from "../utils/AppError.js";

/**
 * TradingStrategyService
 *
 * IMPORTANT:
 * This service decides only whether an AI/strategy signal is eligible
 * to continue through the current trading pipeline.
 *
 * A rejected signal is a NORMAL trading outcome. It must NOT:
 * - activate Emergency Stop
 * - disable real-money authorization
 * - permanently stop the trading engine
 *
 * Examples of normal rejections:
 * - HOLD signal
 * - low confidence
 * - stale market data
 * - invalid signal data
 *
 * Emergency Stop is controlled separately by an explicit safety action
 * or a dedicated backend safety mechanism.
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
   * A validation failure means "DO NOT TRADE THIS CYCLE".
   * It does NOT mean "EMERGENCY STOP".
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
     *
     * This is a normal rejection for the current cycle.
     */
    if (!signal || typeof signal !== "object") {
      return this.createRejectedResult(
        ["INVALID_TRADING_SIGNAL"],
        warnings
      );
    }

    const action = String(signal.action || "")
      .trim()
      .toUpperCase();

    if (!["BUY", "SELL", "HOLD"].includes(action)) {
      reasons.push("INVALID_SIGNAL_ACTION");
    }

    /**
     * HOLD is a valid analysis outcome.
     *
     * It simply means no trade should be opened during this cycle.
     * It must never activate Emergency Stop.
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
     * Market data validation.
     *
     * Invalid or unavailable market data means this cycle is skipped.
     * The trading engine may safely wait for fresh data and try again.
     */
    if (!market || typeof market !== "object") {
      reasons.push("NO_FRESH_MARKET_DATA");
    } else {
      const quote = Number(market.quote);

      if (!Number.isFinite(quote) || quote <= 0) {
        reasons.push("INVALID_MARKET_PRICE");
      }

      /**
       * Ensure the returned tick belongs to the expected symbol.
       */
      if (
        expectedSymbol &&
        market.symbol &&
        String(market.symbol).trim().toUpperCase() !==
          String(expectedSymbol).trim().toUpperCase()
      ) {
        reasons.push("MARKET_SYMBOL_MISMATCH");
      }

      /**
       * Deriv ticks commonly provide epoch in seconds.
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
           * Future timestamps indicate invalid data or a clock issue.
           * Reject the current cycle rather than treating it as an
           * emergency.
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
     * Ensure the signal belongs to the market currently evaluated.
     */
    if (
      expectedSymbol &&
      signal.market &&
      String(signal.market).trim().toUpperCase() !==
        String(expectedSymbol).trim().toUpperCase()
    ) {
      reasons.push("SIGNAL_MARKET_MISMATCH");
    }

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
       * A rejected strategy signal only skips the current trade cycle.
       *
       * The engine can continue monitoring the market and evaluate
       * the next valid signal.
       */
      shouldSkipCycle: !approved,

      /**
       * Strategy validation NEVER requests Emergency Stop.
       *
       * Emergency state must be managed explicitly elsewhere.
       */
      emergencyStopRequested: false,

      /**
       * This service never gives final execution authorization.
       */
      executionAuthorized: false,
    };
  }

  /**
   * Create a consistent normal rejection response.
   *
   * This is intentionally NOT an emergency response.
   */
  createRejectedResult(reasons, warnings = []) {
    return {
      approved: false,
      action: null,
      confidence: null,
      reasons,
      warnings,

      // Skip only the current cycle.
      shouldSkipCycle: true,

      // Never activate emergency stop from strategy validation.
      emergencyStopRequested: false,

      // Final execution authorization belongs elsewhere.
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
      typeof contractType !== "string" ||
      !contractType.trim()
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