import { TradingSettings } from "../models/TradingSettings.js";
import { Trade } from "../models/Trade.js";
import { DerivAccount } from "../models/DerivAccount.js";

import { AppError } from "../utils/AppError.js";

import { autoTradingService } from "../services/AutoTradingService.js";
import { derivMarketService } from "../services/DerivMarketService.js";
import { logActivitySafe } from "../services/ActivityService.js";

const REAL_AUTH_CONFIRMATION =
  "I AUTHORIZE REAL MONEY AUTO-TRADING";

/* ============================================================
   HELPERS
============================================================ */

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.user?.sub ||
    req.user?._id;

  if (!userId) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED"
    );
  }

  return String(userId);
}

function serializeSettings(settings) {
  if (!settings) return null;

  return typeof settings.toObject === "function"
    ? settings.toObject()
    : settings;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * A connected account can be represented either by the explicit
 * boolean or by the connection status returned by the backend.
 */
function isAccountConnected(account) {
  if (!account) return false;

  const status = normalizeText(
    account.connectionStatus
  );

  return (
    account.connected === true ||
    status === "connected" ||
    status === "active"
  );
}

function defaultSettings(userId) {
  return {
    userId,

    selectedMarket: null,

    // Explicit contract configuration.
    contractType: null,
    contractDuration: null,
    contractDurationUnit: null,
    stakeBasis: "stake",

    // Safety defaults.
    autoTradingEnabled: false,
    realTradingAuthorized: false,
    emergencyStop: false,

    stake: 1,
    maxStake: 10,
    minimumBalance: 0,
    maxDailyLoss: 10,
    maxDailyTrades: 10,
    maxConsecutiveLosses: 3,

    aiConfidenceThreshold: 0.7,

    // AutoTradingService currently reads tradingIntervalMs.
    tradingIntervalMs: 15000,

    // Keep compatibility with existing settings if used elsewhere.
    analysisInterval: 15000,
    cooldown: 5000,

    stopReason: null,
  };
}

async function getSettings(userId) {
  let settings = await TradingSettings.findOne({
    userId,
  });

  if (!settings) {
    settings = await TradingSettings.create(
      defaultSettings(userId)
    );
  }

  return settings;
}

/**
 * Return the explicitly selected REAL Deriv account.
 *
 * We do not require the `connected` field in the MongoDB query because
 * older account documents may represent connectivity through
 * connectionStatus instead.
 */
async function getSelectedRealAccountOrThrow(userId) {
  const account = await DerivAccount.findOne({
    userId,
    selected: true,
  });

  if (!account) {
    throw new AppError(
      "Please connect and select a Deriv account before continuing",
      400,
      "DERIV_ACCOUNT_NOT_SELECTED"
    );
  }

  if (!account.derivAccountId) {
    throw new AppError(
      "The selected Deriv account does not have a valid Deriv account ID",
      400,
      "DERIV_ACCOUNT_ID_MISSING"
    );
  }

  const accountType = normalizeText(
    account.accountType
  );

  if (accountType !== "real") {
    throw new AppError(
      "Only a REAL Deriv account can be used for live auto-trading",
      403,
      "NOT_REAL_ACCOUNT"
    );
  }

  if (!isAccountConnected(account)) {
    throw new AppError(
      "The selected Deriv account is not connected",
      403,
      "DERIV_ACCOUNT_NOT_CONNECTED"
    );
  }

  return account;
}

/**
 * Validate the selected market against the backend's Deriv market
 * service before allowing the trading engine to start.
 */
async function validateSelectedMarketOrThrow(
  settings
) {
  const market = String(
    settings.selectedMarket || ""
  ).trim();

  if (!market) {
    throw new AppError(
      "Please select a market before starting auto-trading",
      400,
      "MARKET_NOT_SELECTED"
    );
  }

  const symbol = await derivMarketService.symbol(
    market
  );

  if (!symbol) {
    throw new AppError(
      "The selected market is currently unavailable on Deriv",
      400,
      "MARKET_UNAVAILABLE"
    );
  }

  return symbol;
}

/**
 * Stop the in-memory trading worker.
 *
 * IMPORTANT:
 * AutoTradingService.stop(userId, reason) expects positional
 * arguments, not an object.
 */
async function stopEngineSafely(userId, reason) {
  if (
    !autoTradingService ||
    typeof autoTradingService.stop !== "function"
  ) {
    console.warn(
      "AutoTradingService.stop() is not available"
    );

    return false;
  }

  try {
    await autoTradingService.stop(userId, reason);
    return true;
  } catch (error) {
    console.error(
      "Trading engine stop failed:",
      error?.message || error
    );

    return false;
  }
}

/* ============================================================
   GET /trading/status
============================================================ */

export async function status(req, res) {
  const userId = getUserId(req);

  const [settings, account] = await Promise.all([
    getSettings(userId),

    DerivAccount.findOne({
      userId,
      selected: true,
    })
      .select(
        [
          "derivAccountId",
          "accountType",
          "currency",
          "selected",
          "connected",
          "connectionStatus",
          "lastVerifiedAt",
        ].join(" ")
      )
      .lean(),
  ]);

  return res.status(200).json({
    success: true,

    data: {
      settings: serializeSettings(settings),

      account: account
        ? {
            // Legacy compatibility.
            accountId: account.derivAccountId,

            // Canonical Deriv account ID.
            derivAccountId:
              account.derivAccountId,

            accountType: account.accountType,
            currency: account.currency,

            selected:
              account.selected === true,

            connected:
              isAccountConnected(account),

            connectionStatus:
              account.connectionStatus ||
              (isAccountConnected(account)
                ? "connected"
                : "disconnected"),

            lastVerifiedAt:
              account.lastVerifiedAt || null,
          }
        : null,
    },
  });
}

/* ============================================================
   POST /trading/authorize-real
============================================================ */

export async function authorizeReal(req, res) {
  const userId = getUserId(req);

  const confirmation =
    typeof req.body?.confirmation === "string"
      ? req.body.confirmation.trim()
      : "";

  if (confirmation !== REAL_AUTH_CONFIRMATION) {
    throw new AppError(
      `Explicit confirmation is required. Please confirm with: ${REAL_AUTH_CONFIRMATION}`,
      400,
      "REAL_AUTH_CONFIRMATION_REQUIRED"
    );
  }

  const account =
    await getSelectedRealAccountOrThrow(userId);

  const settings = await getSettings(userId);

  /**
   * Emergency Stop intentionally blocks authorization actions.
   * The user must explicitly release the emergency state first.
   */
  if (settings.emergencyStop) {
    throw new AppError(
      "Real-money authorization is unavailable while Emergency Stop is active",
      409,
      "EMERGENCY_STOP_ACTIVE"
    );
  }

  if (!settings.realTradingAuthorized) {
    settings.realTradingAuthorized = true;
    settings.realTradingAuthorizedAt =
      new Date();

    await settings.save();

    await logActivitySafe({
      userId,
      type: "REAL_TRADING_AUTHORIZED",
      title: "Real trading authorized",
      description:
        "User explicitly authorized real-money automatic trading.",
      metadata: {
        accountId: account.derivAccountId,
        confirmation: "EXPLICIT",
      },
    });
  }

  return res.status(200).json({
    success: true,

    message:
      "Real-money auto-trading has been authorized. Trading remains stopped until you explicitly start it.",

    data: serializeSettings(settings),
  });
}

/* ============================================================
   POST /trading/start
============================================================ */

export async function start(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  if (!settings.realTradingAuthorized) {
    throw new AppError(
      "Real-money trading must be explicitly authorized first",
      400,
      "REAL_AUTH_REQUIRED"
    );
  }

  if (settings.emergencyStop) {
    throw new AppError(
      "Trading cannot start while Emergency Stop is active",
      409,
      "EMERGENCY_STOP_ACTIVE"
    );
  }

  const account =
    await getSelectedRealAccountOrThrow(userId);

  await validateSelectedMarketOrThrow(settings);

  /**
   * If the database says trading is enabled and a local engine is
   * already running, do not create another scheduler.
   */
  if (settings.autoTradingEnabled) {
    return res.status(200).json({
      success: true,
      message:
        "Auto-trading is already enabled",

      data: serializeSettings(settings),
    });
  }

  /*
   * Enable the persistent safety flag before starting the scheduler.
   * Every cycle independently verifies this flag.
   */
  settings.autoTradingEnabled = true;
  settings.stopReason = null;
  settings.startedAt = new Date();

  await settings.save();

  try {
    if (
      !autoTradingService ||
      typeof autoTradingService.start !== "function"
    ) {
      throw new Error(
        "AutoTradingService.start() is not implemented"
      );
    }

    /**
     * IMPORTANT:
     * AutoTradingService.start(userId) expects the user ID directly.
     */
    const engineResult =
      await autoTradingService.start(userId);

    if (
      engineResult?.started === false &&
      engineResult?.reason !== "ALREADY_RUNNING"
    ) {
      throw new Error(
        engineResult?.reason ||
          "The trading engine could not start"
      );
    }

  } catch (error) {
    /*
     * Roll back the database flag if the scheduler failed to start.
     */
    settings.autoTradingEnabled = false;
    settings.stopReason = "ENGINE_START_FAILED";

    await settings.save();

    await logActivitySafe({
      userId,
      type: "AUTO_TRADING_START_FAILED",
      title: "Auto-trading failed to start",
      description:
        error?.message ||
        "The automatic trading engine could not start.",
      metadata: {
        accountId: account.derivAccountId,
        market: settings.selectedMarket,
      },
    });

    throw new AppError(
      error?.message ||
        "Unable to start the auto-trading engine",
      500,
      "AUTO_TRADING_START_FAILED"
    );
  }

  await logActivitySafe({
    userId,
    type: "AUTO_TRADING_STARTED",
    title: "Auto-trading started",
    description:
      "User started the automatic trading engine.",
    metadata: {
      accountId: account.derivAccountId,
      market: settings.selectedMarket,
    },
  });

  return res.status(200).json({
    success: true,
    message: "Auto-trading started successfully",
    data: serializeSettings(settings),
  });
}

/* ============================================================
   POST /trading/stop
============================================================ */

export async function stop(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  /*
   * Safety first: persist the block before stopping the scheduler.
   */
  settings.autoTradingEnabled = false;
  settings.stopReason = "USER_REQUESTED_STOP";

  await settings.save();

  const engineStopped = await stopEngineSafely(
    userId,
    "USER_REQUESTED_STOP"
  );

  await logActivitySafe({
    userId,
    type: "AUTO_TRADING_STOPPED",
    title: "Auto-trading stopped",
    description:
      "User stopped automatic trading.",
    metadata: {
      engineStopped,
    },
  });

  return res.status(200).json({
    success: true,

    message:
      "Auto-trading has been disabled. New automated trades are blocked.",

    data: serializeSettings(settings),
  });
}

/* ============================================================
   POST /trading/emergency-stop
============================================================ */

export async function emergency(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  /*
   * Highest-priority safety operation.
   *
   * Persist the emergency block FIRST. Even if the process takes a
   * moment to stop the scheduler, the next cycle will see this flag
   * and refuse execution.
   */
  settings.autoTradingEnabled = false;
  settings.emergencyStop = true;
  settings.stopReason = "EMERGENCY_STOP";
  settings.emergencyStoppedAt = new Date();

  await settings.save();

  const engineStopped = await stopEngineSafely(
    userId,
    "EMERGENCY_STOP"
  );

  await logActivitySafe({
    userId,
    type: "EMERGENCY_STOP",
    title: "Emergency stop activated",
    description:
      "Emergency stop was activated and new automated trades were blocked.",
    metadata: {
      engineStopped,
    },
  });

  return res.status(200).json({
    success: true,

    message:
      "Emergency Stop activated. Automatic trading is blocked until Emergency Stop is explicitly released.",

    data: serializeSettings(settings),
  });
}

/* ============================================================
   POST /trading/release-emergency-stop

   Releasing Emergency Stop DOES NOT start trading.
   The user must explicitly press Start afterwards.
============================================================ */

export async function releaseEmergencyStop(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  if (!settings.emergencyStop) {
    return res.status(200).json({
      success: true,
      message: "Emergency Stop is not active",
      data: serializeSettings(settings),
    });
  }

  /**
   * Verify that the selected account is still valid before removing
   * the safety block. This still does not start trading.
   */
  await getSelectedRealAccountOrThrow(userId);

  settings.autoTradingEnabled = false;
  settings.emergencyStop = false;
  settings.stopReason = "EMERGENCY_STOP_RELEASED";
  settings.emergencyReleasedAt = new Date();

  await settings.save();

  await logActivitySafe({
    userId,
    type: "EMERGENCY_STOP_RELEASED",
    title: "Emergency stop released",
    description:
      "Emergency Stop was released. Automatic trading remains stopped until explicitly started.",
  });

  return res.status(200).json({
    success: true,

    message:
      "Emergency Stop has been released. Automatic trading remains stopped and requires an explicit Start action.",

    data: serializeSettings(settings),
  });
}

/* ============================================================
   GET /trading/trades
============================================================ */

export async function trades(req, res) {
  const userId = getUserId(req);

  const requestedLimit = Number(
    req.query.limit
  );

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(
        Math.max(Math.floor(requestedLimit), 1),
        100
      )
    : 50;

  const data = await Trade.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return res.status(200).json({
    success: true,
    data,
    meta: { limit },
  });
}

/* ============================================================
   GET /trading/trades/:id
============================================================ */

export async function trade(req, res) {
  const userId = getUserId(req);

  const data = await Trade.findOne({
    _id: req.params.id,
    userId,
  }).lean();

  if (!data) {
    throw new AppError(
      "Trade not found",
      404,
      "TRADE_NOT_FOUND"
    );
  }

  return res.status(200).json({
    success: true,
    data,
  });
}