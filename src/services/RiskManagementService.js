import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**
 * Convert a value to a finite number.
 */
function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

/**
 * Get the beginning of the current UTC day.
 *
 * Using UTC avoids different server timezones producing
 * inconsistent daily risk calculations.
 */
function getStartOfToday() {
  const now = new Date();

  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

/**
 * Normalize a trade status.
 */
function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

/**
 * Risk Management Service
 *
 * IMPORTANT:
 * This service is a backend safety layer. AI signals must never
 * bypass these checks.
 */
export class RiskManagementService {
  /**
   * Evaluate whether a new automated trade may be opened.
   */
  async evaluate({
    settings,
    balance,
    userId,
    accountId,
    stake,
  }) {
    if (!settings) {
      throw new AppError(
        "Trading settings are required for risk evaluation",
        500,
        "RISK_SETTINGS_MISSING"
      );
    }

    if (!userId || !accountId) {
      throw new AppError(
        "User and account information are required for risk evaluation",
        500,
        "RISK_CONTEXT_INVALID"
      );
    }

    const reasons = [];

    const currentBalance = toNumber(balance);
    const requestedStake = toNumber(stake);

    const minimumBalance = toNumber(
      settings.minimumBalance
    );

    const maxStake = toNumber(
      settings.maxStake
    );

    const maxDailyTrades = Math.max(
      0,
      Math.floor(toNumber(settings.maxDailyTrades))
    );

    const maxDailyLoss = Math.max(
      0,
      toNumber(settings.maxDailyLoss)
    );

    const maxConsecutiveLosses = Math.max(
      0,
      Math.floor(
        toNumber(settings.maxConsecutiveLosses)
      )
    );

    /* ==========================================================
       CRITICAL TRADING STATE CHECKS
    ========================================================== */

    if (!settings.autoTradingEnabled) {
      reasons.push("AUTO_TRADING_DISABLED");
    }

    if (!settings.realTradingAuthorized) {
      reasons.push("REAL_TRADING_NOT_AUTHORIZED");
    }

    if (settings.emergencyStop) {
      reasons.push("EMERGENCY_STOP_ACTIVE");
    }

    /* ==========================================================
       STAKE VALIDATION
    ========================================================== */

    if (
      !Number.isFinite(requestedStake) ||
      requestedStake <= 0
    ) {
      reasons.push("INVALID_STAKE");
    }

    if (
      requestedStake > 0 &&
      currentBalance > 0 &&
      requestedStake > currentBalance
    ) {
      reasons.push("INSUFFICIENT_BALANCE");
    }

    if (
      maxStake > 0 &&
      requestedStake > maxStake
    ) {
      reasons.push("MAX_STAKE_EXCEEDED");
    }

    /* ==========================================================
       MINIMUM BALANCE PROTECTION
    ========================================================== */

    if (
      minimumBalance > 0 &&
      currentBalance < minimumBalance
    ) {
      reasons.push("MINIMUM_BALANCE_PROTECTION");
    }

    /* ==========================================================
       DAILY TRADE HISTORY
    ========================================================== */

    const startOfToday = getStartOfToday();

    const [
      todayTrades,
      openTrade,
    ] = await Promise.all([
      Trade.find({
        userId,
        derivAccountId: String(accountId),
        createdAt: {
          $gte: startOfToday,
        },
      })
        .select(
          "status profitLoss createdAt closedAt"
        )
        .sort({
          createdAt: 1,
        })
        .lean(),

      Trade.exists({
        userId,
        derivAccountId: String(accountId),
        status: {
          $in: [
            "pending",
            "open",
            "active",
          ],
        },
      }),
    ]);

    const tradeCount = todayTrades.length;

    /* ==========================================================
       DAILY TRADE LIMIT
    ========================================================== */

    if (
      maxDailyTrades > 0 &&
      tradeCount >= maxDailyTrades
    ) {
      reasons.push("MAX_DAILY_TRADES_REACHED");
    }

    /* ==========================================================
       DAILY LOSS LIMIT

       Only CLOSED trades should contribute to realized daily loss.
    ========================================================== */

    const closedTrades = todayTrades.filter(
      (trade) =>
        normalizeStatus(trade.status) === "closed"
    );

    const dailyLoss = closedTrades.reduce(
      (total, trade) => {
        const profitLoss = toNumber(
          trade.profitLoss
        );

        return profitLoss < 0
          ? total + Math.abs(profitLoss)
          : total;
      },
      0
    );

    if (
      maxDailyLoss > 0 &&
      dailyLoss >= maxDailyLoss
    ) {
      reasons.push("DAILY_LOSS_LIMIT_REACHED");
    }

    /* ==========================================================
       CONSECUTIVE LOSS LIMIT

       Start from the newest CLOSED trade and count losses until
       the first winning/break-even closed trade.
    ========================================================== */

    const tradesByNewest = [...closedTrades].sort(
      (a, b) =>
        new Date(b.closedAt || b.createdAt).getTime() -
        new Date(a.closedAt || a.createdAt).getTime()
    );

    let consecutiveLosses = 0;

    for (const trade of tradesByNewest) {
      const profitLoss = toNumber(
        trade.profitLoss
      );

      if (profitLoss < 0) {
        consecutiveLosses += 1;
        continue;
      }

      // A closed non-losing trade breaks the loss streak.
      break;
    }

    if (
      maxConsecutiveLosses > 0 &&
      consecutiveLosses >=
        maxConsecutiveLosses
    ) {
      reasons.push(
        "MAX_CONSECUTIVE_LOSSES_REACHED"
      );
    }

    /* ==========================================================
       OPEN TRADE PROTECTION

       Do not open another trade while an existing automated
       trade is still pending or active.
    ========================================================== */

    if (openTrade) {
      reasons.push("CONFLICTING_OPEN_TRADE");
    }

    return {
      approved: reasons.length === 0,
      reasons,

      limits: {
        balance: currentBalance,
        stake: requestedStake,

        minimumBalance,

        maxStake,

        dailyLoss,
        maxDailyLoss,

        tradeCount,
        maxDailyTrades,

        consecutiveLosses,
        maxConsecutiveLosses,

        hasOpenTrade: Boolean(openTrade),
      },
    };
  }
}

export const riskManagementService =
  new RiskManagementService();