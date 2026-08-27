import { DerivAccount } from "../models/DerivAccount.js";
import { TradingSettings } from "../models/TradingSettings.js";
import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**
 * Resolve the authenticated user's ID.
 *
 * Supports JWT middleware using either `id` or `sub`.
 */
function getUserId(req) {
  const userId =
    req.user?.id ||
    req.user?.sub ||
    req.user?._id;

  if (!userId) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  return String(userId);
}

/**
 * Serialize the selected Deriv account.
 *
 * Never expose encrypted access tokens or other credentials.
 */
function serializeAccount(account) {
  if (!account) {
    return null;
  }

  return {
    id: String(account._id),
    derivAccountId:
      account.derivAccountId ||
      account.accountId ||
      account.loginId ||
      null,

    accountId:
      account.accountId ||
      account.derivAccountId ||
      account.loginId ||
      null,

    accountType:
      account.accountType || null,

    type: account.accountType || null,
    currency: account.currency || null,

    selected: Boolean(account.selected),

    connected:
      account.connected ??
      account.connectionStatus === "CONNECTED",

    status:
      account.status ||
      account.connectionStatus ||
      "UNKNOWN",

    lastKnownBalance:
      Number(account.lastKnownBalance ?? 0),

    lastBalanceUpdatedAt:
      account.lastBalanceUpdatedAt || null,

    connectedAt: account.connectedAt || null,
    updatedAt: account.updatedAt || null,
  };
}

/**
 * Serialize a trade for dashboard consumption.
 */
function serializeTrade(trade) {
  return {
    id: String(trade._id),
    symbol: trade.symbol || null,
    contractType: trade.contractType || null,
    stake:
      trade.stake !== undefined
        ? Number(trade.stake)
        : null,
    status: trade.status || "UNKNOWN",
    profitLoss:
      trade.profitLoss !== undefined
        ? Number(trade.profitLoss)
        : null,
    executionTime:
      trade.executionTime || null,
    createdAt: trade.createdAt || null,
    updatedAt: trade.updatedAt || null,
  };
}

/**
 * GET /dashboard
 */
export async function dashboard(req, res) {
  const userId = getUserId(req);

  const [account, settings, trades] =
    await Promise.all([
      DerivAccount.findOne({
        userId,
        selected: true,
      }).lean(),

      TradingSettings.findOne({
        userId,
      }).lean(),

      Trade.find({
        userId,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

  const serializedAccount =
    serializeAccount(account);

  const recentTrades =
    trades.map(serializeTrade);

  return res.json({
    success: true,
    data: {
      /**
       * Account information for the dashboard.
       */
      account: serializedAccount,

      /**
       * Balance is separated because your frontend Dashboard
       * interface already supports `balance`.
       */
      balance: account
        ? {
            balance: Number(
              account.lastKnownBalance ?? 0,
            ),
            currency: account.currency || null,
            accountId:
              account.derivAccountId ||
              account.accountId ||
              account.loginId ||
              null,
            accountType:
              account.accountType || null,
            source: "cached",
            updatedAt:
              account.lastBalanceUpdatedAt || null,
          }
        : null,

      /**
       * Keep `settings` for your current frontend API.
       */
      settings: settings || null,

      /**
       * Alias retained for compatibility with dashboards
       * expecting a `trading` property.
       */
      trading: settings || null,

      recentTrades,

      /**
       * Useful aliases for your existing Dashboard interface.
       */
      trades: recentTrades,

      openPositions: [],

      latestAnalysis: null,
    },
  });
}