import { DerivAccount } from "../models/DerivAccount.js";
import { TradingSettings } from "../models/TradingSettings.js";
import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**
 * Resolve the authenticated user's ID consistently.
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
 * Normalize account connection state.
 */
function normalizeConnectionStatus(account) {
  if (!account) return "DISCONNECTED";

  if (account.connected === true) {
    return "CONNECTED";
  }

  const status = String(
    account.connectionStatus || account.status || "",
  ).trim().toUpperCase();

  return status || "DISCONNECTED";
}

/**
 * Serialize the selected Deriv account.
 *
 * SECURITY:
 * Never expose OAuth tokens, encrypted credentials, or internal secrets.
 */
function serializeAccount(account) {
  if (!account) return null;

  const derivAccountId =
    account.derivAccountId ||
    account.accountId ||
    account.loginId ||
    null;

  const connectionStatus =
    normalizeConnectionStatus(account);

  return {
    id: String(account._id),

    derivAccountId,
    accountId: derivAccountId,

    accountType:
      account.accountType
        ? String(account.accountType).toUpperCase()
        : null,

    type:
      account.accountType
        ? String(account.accountType).toUpperCase()
        : null,

    currency: account.currency || null,

    selected: account.selected === true,

    connected:
      account.connected === true ||
      connectionStatus === "CONNECTED",

    connectionStatus,
    status: connectionStatus,

    lastKnownBalance: Number(
      account.lastKnownBalance ?? 0,
    ),

    lastBalanceUpdatedAt:
      account.lastBalanceUpdatedAt || null,

    lastVerifiedAt:
      account.lastVerifiedAt || null,

    connectedAt:
      account.connectedAt || null,

    updatedAt:
      account.updatedAt || null,
  };
}

/**
 * Serialize a trade for frontend consumption.
 */
function serializeTrade(trade) {
  if (!trade) return null;

  return {
    id: String(trade._id),

    derivContractId:
      trade.derivContractId || null,

    derivAccountId:
      trade.derivAccountId || null,

    symbol:
      trade.symbol ||
      trade.market ||
      null,

    market:
      trade.market ||
      trade.symbol ||
      null,

    contractType:
      trade.contractType || null,

    action:
      trade.action || null,

    stake:
      trade.stake !== undefined &&
      trade.stake !== null
        ? Number(trade.stake)
        : null,

    status:
      trade.status || "UNKNOWN",

    profitLoss:
      trade.profitLoss !== undefined &&
      trade.profitLoss !== null
        ? Number(trade.profitLoss)
        : null,

    executionTime:
      trade.executionTime ||
      trade.executedAt ||
      null,

    openedAt:
      trade.openedAt || null,

    closedAt:
      trade.closedAt || null,

    createdAt:
      trade.createdAt || null,

    updatedAt:
      trade.updatedAt || null,
  };
}

/**
 * Calculate lightweight dashboard statistics.
 */
function calculateStatistics(trades) {
  const closedTrades = trades.filter(
    (trade) => trade.status === "closed",
  );

  const totalTrades = trades.length;

  const winningTrades = closedTrades.filter(
    (trade) => Number(trade.profitLoss || 0) > 0,
  );

  const losingTrades = closedTrades.filter(
    (trade) => Number(trade.profitLoss || 0) < 0,
  );

  const totalProfitLoss = closedTrades.reduce(
    (total, trade) =>
      total + Number(trade.profitLoss || 0),
    0,
  );

  const winRate =
    closedTrades.length > 0
      ? Number(
          (
            (winningTrades.length /
              closedTrades.length) *
            100
          ).toFixed(2),
        )
      : 0;

  return {
    totalTrades,
    closedTrades: closedTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    totalProfitLoss: Number(
      totalProfitLoss.toFixed(2),
    ),
  };
}

/**
 * GET /api/v1/dashboard
 *
 * Returns dashboard-safe information only.
 */
export async function dashboard(req, res) {
  const userId = getUserId(req);

  const [
    account,
    settings,
    recentTradesRaw,
    openTradesRaw,
    allClosedTrades,
  ] = await Promise.all([
    DerivAccount.findOne({
      userId,
      selected: true,
    }).lean(),

    TradingSettings.findOne({
      userId,
    }).lean(),

    Trade.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),

    Trade.find({
      userId,
      status: {
        $in: ["pending", "open"],
      },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),

    Trade.find({
      userId,
      status: "closed",
    })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean(),
  ]);

  const serializedAccount =
    serializeAccount(account);

  const recentTrades =
    recentTradesRaw.map(serializeTrade);

  const openPositions =
    openTradesRaw.map(serializeTrade);

  const statistics =
    calculateStatistics(allClosedTrades);

  /**
   * Do not claim the balance is live when it is cached.
   * The frontend can explicitly call /account/deriv/balance/refresh
   * when it needs a fresh value.
   */
  const balance = account
    ? {
        balance: Number(
          account.lastKnownBalance ?? 0,
        ),

        currency:
          account.currency || null,

        accountId:
          account.derivAccountId ||
          account.accountId ||
          account.loginId ||
          null,

        accountType:
          account.accountType
            ? String(
                account.accountType,
              ).toUpperCase()
            : null,

        source: "cached",

        updatedAt:
          account.lastBalanceUpdatedAt || null,
      }
    : null;

  /**
   * Explicit trading state for simple frontend rendering.
   */
  const tradingState = {
    realTradingAuthorized:
      settings?.realTradingAuthorized === true,

    autoTradingEnabled:
      settings?.autoTradingEnabled === true,

    emergencyStop:
      settings?.emergencyStop === true,

    stopReason:
      settings?.stopReason || null,

    isRunning:
      settings?.autoTradingEnabled === true &&
      settings?.emergencyStop !== true,

    startedAt:
      settings?.startedAt || null,

    emergencyStoppedAt:
      settings?.emergencyStoppedAt || null,
  };

  return res.status(200).json({
    success: true,

    data: {
      account: serializedAccount,

      balance,

      /**
       * Full settings retained for your existing frontend.
       */
      settings: settings || null,

      /**
       * Explicit state recommended for new frontend components.
       */
      tradingState,

      /**
       * Backward-compatible alias.
       */
      trading: settings || null,

      recentTrades,

      /**
       * Backward-compatible alias.
       */
      trades: recentTrades,

      openPositions,

      statistics,

      /**
       * AI analysis should only be populated from a stored analysis
       * record. Never fabricate a signal here.
       */
      latestAnalysis: null,
    },
  });
}