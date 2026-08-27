import { TradingSettings } from "../models/TradingSettings.js";
import { Trade } from "../models/Trade.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";
import { ActivityLog } from "../models/ActivityLog.js";
import { autoTradingService } from "../services/AutoTradingService.js";

const REAL_AUTH_CONFIRMATION =
  "I AUTHORIZE REAL MONEY AUTO-TRADING";

async function getSettingsOrThrow(userId) {
  const settings = await TradingSettings.findOne({ userId });

  if (!settings) {
    throw new AppError(
      "Trading settings were not found",
      404,
      "TRADING_SETTINGS_NOT_FOUND",
    );
  }

  return settings;
}

async function getSelectedRealAccountOrThrow(userId) {
  const account = await DerivAccount.findOne({
    userId,
    selected: true,
  });

  if (!account) {
    throw new AppError(
      "Please select a Deriv account before continuing",
      400,
      "DERIV_ACCOUNT_NOT_SELECTED",
    );
  }

  if (
    String(account.accountType || "").toLowerCase() !== "real"
  ) {
    throw new AppError(
      "Only a real Deriv account can be used for live auto-trading",
      403,
      "NOT_REAL_ACCOUNT",
    );
  }

  if (
    account.connectionStatus &&
    String(account.connectionStatus).toLowerCase() !== "connected"
  ) {
    throw new AppError(
      "The selected Deriv account is not connected",
      403,
      "DERIV_ACCOUNT_NOT_CONNECTED",
    );
  }

  return account;
}

/**
 * GET /trading/status
 */
export async function status(req, res) {
  const settings = await getSettingsOrThrow(req.user.id);

  const account = await DerivAccount.findOne({
    userId: req.user.id,
    selected: true,
  }).select(
    "derivAccountId accountType currency selected connectionStatus",
  );

  return res.json({
    success: true,
    data: {
      settings,
      account: account
        ? {
            accountId: account.derivAccountId,
            accountType: account.accountType,
            currency: account.currency,
            selected: account.selected,
            connectionStatus: account.connectionStatus,
          }
        : null,
    },
  });
}

/**
 * POST /trading/authorize-real
 *
 * Requires an explicit statement from the user before
 * real-money auto-trading can ever be started.
 */
export async function authorizeReal(req, res) {
  const { confirmation } = req.body || {};

  if (confirmation !== REAL_AUTH_CONFIRMATION) {
    throw new AppError(
      "Explicit confirmation is required before authorizing real-money auto-trading",
      400,
      "REAL_AUTH_CONFIRMATION_REQUIRED",
    );
  }

  await getSelectedRealAccountOrThrow(req.user.id);

  const settings = await getSettingsOrThrow(req.user.id);

  settings.realTradingAuthorized = true;
  settings.realTradingAuthorizedAt = new Date();

  await settings.save();

  await ActivityLog.create({
    userId: req.user.id,
    type: "REAL_TRADING_AUTHORIZED",
    message:
      "User explicitly authorized real-money auto-trading",
    metadata: {
      confirmation: "EXPLICIT",
    },
  });

  return res.json({
    success: true,
    message:
      "Real-money auto-trading has been authorized. Trading is still stopped until you explicitly start it.",
    data: settings,
  });
}

/**
 * POST /trading/start
 */
export async function start(req, res) {
  const settings = await getSettingsOrThrow(req.user.id);

  if (!settings.realTradingAuthorized) {
    throw new AppError(
      "Real trading must be explicitly authorized first",
      400,
      "REAL_AUTH_REQUIRED",
    );
  }

  const account = await getSelectedRealAccountOrThrow(
    req.user.id,
  );

  if (settings.emergencyStop) {
    throw new AppError(
      "Trading cannot start while emergency stop is active. Reset the emergency stop first.",
      409,
      "EMERGENCY_STOP_ACTIVE",
    );
  }

  if (settings.autoTradingEnabled) {
    return res.json({
      success: true,
      message: "Auto-trading is already running",
      data: settings,
    });
  }

  /*
   * Persist the intent first. The AutoTradingService should also
   * independently verify these settings before placing every trade.
   */
  settings.autoTradingEnabled = true;
  settings.stopReason = null;
  settings.startedAt = new Date();

  await settings.save();

  try {
    await autoTradingService.start(req.user.id);

    await ActivityLog.create({
      userId: req.user.id,
      type: "AUTO_TRADING_STARTED",
      message:
        "User started real-money automatic trading",
      metadata: {
        accountId: account.derivAccountId,
      },
    });

    return res.json({
      success: true,
      message: "Auto-trading started successfully",
      data: settings,
    });
  } catch (error) {
    /*
     * Roll back persisted state if the trading engine cannot start.
     */
    settings.autoTradingEnabled = false;
    settings.stopReason = "START_FAILED";
    await settings.save();

    throw error;
  }
}

/**
 * POST /trading/stop
 *
 * Normal stop. The user can start trading again later.
 */
export async function stop(req, res) {
  const settings = await getSettingsOrThrow(req.user.id);

  try {
    await autoTradingService.stop(
      req.user.id,
      "USER_REQUESTED_STOP",
    );
  } catch (error) {
    req.log?.error?.(
      { err: error, userId: req.user.id },
      "Failed to stop auto-trading engine",
    );

    throw new AppError(
      "Unable to safely stop automatic trading",
      409,
      "AUTO_TRADING_STOP_FAILED",
    );
  }

  settings.autoTradingEnabled = false;
  settings.stopReason = "USER_REQUESTED_STOP";

  await settings.save();

  await ActivityLog.create({
    userId: req.user.id,
    type: "AUTO_TRADING_STOPPED",
    message: "User stopped automatic trading",
  });

  return res.json({
    success: true,
    message: "Auto-trading stopped successfully",
    data: settings,
  });
}

/**
 * POST /trading/emergency-stop
 *
 * Emergency stop disables trading and blocks future starts until
 * emergencyStop is explicitly reset through a protected workflow.
 */
export async function emergency(req, res) {
  const settings = await getSettingsOrThrow(req.user.id);

  try {
    await autoTradingService.stop(
      req.user.id,
      "EMERGENCY_STOP",
    );
  } catch (error) {
    req.log?.error?.(
      { err: error, userId: req.user.id },
      "Failed to stop auto-trading during emergency stop",
    );

    throw new AppError(
      "Unable to safely execute emergency stop",
      409,
      "EMERGENCY_STOP_FAILED",
    );
  }

  settings.autoTradingEnabled = false;
  settings.emergencyStop = true;
  settings.stopReason = "EMERGENCY_STOP";
  settings.emergencyStoppedAt = new Date();

  await settings.save();

  await ActivityLog.create({
    userId: req.user.id,
    type: "EMERGENCY_STOP",
    message:
      "Emergency stop activated. Automatic trading was disabled.",
  });

  return res.json({
    success: true,
    message:
      "Emergency stop activated. Automatic trading has been stopped.",
    data: settings,
  });
}

/**
 * GET /trading/trades
 */
export async function trades(req, res) {
  const requestedLimit = Number(req.query.limit);

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100)
    : 50;

  const data = await Trade.find({
    userId: req.user.id,
  })
    .sort({ createdAt: -1 })
    .limit(limit);

  return res.json({
    success: true,
    data,
    meta: {
      limit,
    },
  });
}

/**
 * GET /trading/trades/:id
 */
export async function trade(req, res) {
  const data = await Trade.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!data) {
    throw new AppError(
      "Trade not found",
      404,
      "TRADE_NOT_FOUND",
    );
  }

  return res.json({
    success: true,
    data,
  });
}