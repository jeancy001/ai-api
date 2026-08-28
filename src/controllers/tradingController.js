
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
    : { ...settings };
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

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

/**
 * The scheduler state is process-local.
 *
 * MongoDB stores whether trading is permitted, while this method
 * reports whether the current backend process actually has an
 * active trading scheduler for this user.
 */
function isEngineRunning(userId) {
  try {
    if (
      !autoTradingService ||
      typeof autoTradingService.isRunning !== "function"
    ) {
      return false;
    }

    return autoTradingService.isRunning(userId) === true;
  } catch (error) {
    console.error(
      "Unable to determine trading engine state:",
      error?.message || error
    );

    return false;
  }
}

function defaultSettings(userId) {
  return {
    userId,

    selectedMarket: null,

    contractType: null,
    contractDuration: null,
    contractDurationUnit: null,
    stakeBasis: "stake",

    autoTradingEnabled: false,
    realTradingAuthorized: false,
    realTradingAuthorizedAt: null,

    /**
     * This is a persistent safety lock.
     * It can ONLY be activated through the emergency endpoint.
     */
    emergencyStop: false,
    emergencyStoppedAt: null,
    emergencyReleasedAt: null,

    stake: 1,
    maxStake: 10,
    minimumBalance: 0,

    maxDailyLoss: 10,
    maxDailyTrades: 10,
    maxConsecutiveLosses: 3,

    aiConfidenceThreshold: 0.7,

    tradingIntervalMs: 15_000,
    analysisInterval: 15_000,
    cooldown: 5_000,

    stopReason: null,
    startedAt: null,
    stoppedAt: null,
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

async function getSelectedRealAccountOrThrow(userId) {
  const account = await DerivAccount.findOne({
    userId,
    selected: true,
  });

  if (!account) {
    throw new AppError(
      "Please connect and select a Deriv account before starting auto-trading",
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

  if (
    normalizeText(account.accountType) !== "real"
  ) {
    throw new AppError(
      "The selected account is not a REAL Deriv account. Select a real account before starting live auto-trading.",
      403,
      "NOT_REAL_ACCOUNT"
    );
  }

  if (!isAccountConnected(account)) {
    throw new AppError(
      "The selected Deriv account is not connected. Please reconnect the account and try again.",
      403,
      "DERIV_ACCOUNT_NOT_CONNECTED"
    );
  }

  return account;
}

async function validateSelectedMarketOrThrow(settings) {
  const market = String(
    settings.selectedMarket || ""
  )
    .trim()
    .toUpperCase();

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

  if (!symbol?.symbol) {
    throw new AppError(
      "The selected market is currently unavailable on Deriv",
      400,
      "MARKET_UNAVAILABLE"
    );
  }

  return symbol;
}

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

/**
 * Start the process-local scheduler.
 *
 * Different versions of AutoTradingService may return different
 * values, so this helper supports a successful undefined result
 * while still rejecting an explicit failure.
 */
async function startEngineOrThrow(userId) {
  if (
    !autoTradingService ||
    typeof autoTradingService.start !== "function"
  ) {
    throw new Error(
      "AutoTradingService.start() is not implemented"
    );
  }

  const result = await autoTradingService.start(userId);

  if (result?.started === false) {
    const reason = result?.reason;

    /**
     * ALREADY_RUNNING is not an error because Start is idempotent.
     */
    if (reason !== "ALREADY_RUNNING") {
      throw new Error(
        reason ||
          "The trading engine could not start"
      );
    }
  }

  /**
   * If the service exposes isRunning(), confirm that the scheduler
   * is actually running after startup.
   */
  if (
    typeof autoTradingService.isRunning === "function"
  ) {
    const running = isEngineRunning(userId);

    if (!running) {
      throw new Error(
        "The trading engine did not remain running after startup"
      );
    }
  }

  return result;
}

function buildEngineState(settings, engineRunning) {
  const emergencyActive =
    settings.emergencyStop === true;

  const enabled =
    settings.autoTradingEnabled === true;

  const active =
    enabled &&
    !emergencyActive &&
    engineRunning;

  let state = "STOPPED";

  if (emergencyActive) {
    state = "EMERGENCY_BLOCKED";
  } else if (active) {
    state = "RUNNING";
  } else if (enabled && !engineRunning) {
    state = "RECOVERY_REQUIRED";
  } else if (!enabled && engineRunning) {
    state = "STOPPING_OR_STALE_ENGINE";
  }

  return {
    running: engineRunning,
    active,
    state,

    stateMismatch:
      (enabled && !emergencyActive && !engineRunning) ||
      (!enabled && engineRunning),
  };
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

  const engineRunning = isEngineRunning(userId);
  const engine = buildEngineState(
    settings,
    engineRunning
  );

  return res.status(200).json({
    success: true,
    data: {
      settings: serializeSettings(settings),

      engine,

      account: account
        ? {
            accountId: account.derivAccountId,
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
      "Real-money auto-trading is authorized. Trading remains stopped until you explicitly start it.",
    data: serializeSettings(settings),
  });
}

/* ============================================================
   POST /trading/start
============================================================ */

export async function start(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);
  const engineRunningBefore =
    isEngineRunning(userId);

  /**
   * Emergency Stop is the ONLY persistent state that returns a
   * conflict and blocks an explicit start.
   */
  if (settings.emergencyStop === true) {
    throw new AppError(
      "Trading cannot start because Emergency Stop is active. Release Emergency Stop first, then start trading again.",
      409,
      "EMERGENCY_STOP_ACTIVE"
    );
  }

  if (!settings.realTradingAuthorized) {
    throw new AppError(
      "Real-money trading must be explicitly authorized before auto-trading can start.",
      400,
      "REAL_AUTH_REQUIRED"
    );
  }

  /**
   * Validate the live account and market before changing the
   * persisted engine permission state.
   */
  const account =
    await getSelectedRealAccountOrThrow(userId);

  const market =
    await validateSelectedMarketOrThrow(settings);

  /**
   * Fully idempotent start.
   */
  if (
    settings.autoTradingEnabled === true &&
    engineRunningBefore === true
  ) {
    return res.status(200).json({
      success: true,
      message:
        "Auto-trading is already running.",
      data: serializeSettings(settings),
    });
  }

  /**
   * A backend restart can leave autoTradingEnabled=true in MongoDB
   * while the process-local scheduler is gone.
   *
   * This is NOT a conflict. An explicit Start is allowed to recover
   * the scheduler without requiring the user to Stop first.
   */
  const recoveringEngine =
    settings.autoTradingEnabled === true &&
    engineRunningBefore === false;

  settings.autoTradingEnabled = true;
  settings.stopReason = null;
  settings.startedAt = new Date();
  settings.stoppedAt = null;

  /**
   * Never modify emergencyStop during normal startup.
   */
  await settings.save();

  try {
    await startEngineOrThrow(userId);
  } catch (error) {
    /**
     * Roll back only the enabled state. A failed start must never
     * silently activate Emergency Stop.
     */
    settings.autoTradingEnabled = false;
    settings.stopReason =
      "ENGINE_START_FAILED";
    settings.stoppedAt = new Date();

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
        recoveryAttempt: recoveringEngine,
      },
    });

    throw new AppError(
      error?.message ||
        "Unable to start the auto-trading engine",
      500,
      "AUTO_TRADING_START_FAILED"
    );
  }

  const engineRunningAfter =
    isEngineRunning(userId);

  await logActivitySafe({
    userId,
    type: recoveringEngine
      ? "AUTO_TRADING_ENGINE_RECOVERED"
      : "AUTO_TRADING_STARTED",
    title: recoveringEngine
      ? "Auto-trading engine recovered"
      : "Auto-trading started",
    description: recoveringEngine
      ? "The auto-trading scheduler was restarted after a process state mismatch."
      : "User started the automatic trading engine.",
    metadata: {
      accountId: account.derivAccountId,
      market:
        market.symbol ||
        settings.selectedMarket,
      engineRunning: engineRunningAfter,
    },
  });

  return res.status(200).json({
    success: true,
    message: recoveringEngine
      ? "Auto-trading engine recovered and started successfully."
      : "Auto-trading started successfully. HOLD or skipped analysis cycles will not stop the engine.",
    data: {
      ...serializeSettings(settings),
      engine: {
        running: engineRunningAfter,
        active:
          settings.autoTradingEnabled === true &&
          settings.emergencyStop !== true &&
          engineRunningAfter,
      },
    },
  });
}

/* ============================================================
   POST /trading/stop

   NORMAL STOP ONLY.
   Never activates Emergency Stop.
============================================================ */

export async function stop(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);
  const engineRunning =
    isEngineRunning(userId);

  /**
   * Normal Stop is idempotent.
   */
  if (
    settings.autoTradingEnabled !== true &&
    engineRunning !== true
  ) {
    return res.status(200).json({
      success: true,
      message:
        "Auto-trading is already stopped.",
      data: serializeSettings(settings),
    });
  }

  settings.autoTradingEnabled = false;
  settings.stopReason =
    "USER_REQUESTED_STOP";
  settings.stoppedAt = new Date();

  /**
   * NEVER set emergencyStop here.
   */
  await settings.save();

  const engineStopped =
    await stopEngineSafely(
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
      wasEngineRunning: engineRunning,
    },
  });

  return res.status(200).json({
    success: true,
    message:
      "Auto-trading has been stopped.",
    data: {
      ...serializeSettings(settings),
      engineStopped,
    },
  });
}

/* ============================================================
   POST /trading/emergency-stop

   This is the ONLY controller action that activates the
   persistent Emergency Stop lock.
============================================================ */

export async function emergency(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  const wasAlreadyActive =
    settings.emergencyStop === true;

  settings.autoTradingEnabled = false;
  settings.emergencyStop = true;
  settings.stopReason =
    "EMERGENCY_STOP";
  settings.stoppedAt = new Date();

  if (!wasAlreadyActive) {
    settings.emergencyStoppedAt =
      new Date();
  }

  await settings.save();

  const engineStopped =
    await stopEngineSafely(
      userId,
      "EMERGENCY_STOP"
    );

  if (!wasAlreadyActive) {
    await logActivitySafe({
      userId,
      type: "EMERGENCY_STOP",
      title: "Emergency stop activated",
      description:
        "Emergency Stop was explicitly activated by the user.",
      metadata: {
        engineStopped,
      },
    });
  }

  return res.status(200).json({
    success: true,
    message: wasAlreadyActive
      ? "Emergency Stop is already active."
      : "Emergency Stop is active. Automatic trading is blocked until explicitly released.",
    data: {
      ...serializeSettings(settings),
      engineStopped,
      alreadyActive: wasAlreadyActive,
    },
  });
}

/* ============================================================
   POST /trading/release-emergency-stop

   Releases only the emergency lock.
   It NEVER starts trading automatically.
============================================================ */

export async function releaseEmergencyStop(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  if (settings.emergencyStop !== true) {
    return res.status(200).json({
      success: true,
      message:
        "Emergency Stop is already inactive.",
      data: serializeSettings(settings),
    });
  }

  settings.emergencyStop = false;
  settings.autoTradingEnabled = false;
  settings.stopReason =
    "EMERGENCY_STOP_RELEASED";
  settings.emergencyReleasedAt =
    new Date();
  settings.stoppedAt = new Date();

  await settings.save();

  /**
   * Ensure a stale scheduler does not survive the emergency state.
   * The next explicit Start creates a fresh engine.
   */
  const engineStopped =
    await stopEngineSafely(
      userId,
      "EMERGENCY_STOP_RELEASED"
    );

  await logActivitySafe({
    userId,
    type: "EMERGENCY_STOP_RELEASED",
    title: "Emergency stop released",
    description:
      "Emergency Stop was released. Automatic trading requires an explicit Start action.",
    metadata: {
      engineStopped,
    },
  });

  return res.status(200).json({
    success: true,
    message:
      "Emergency Stop released successfully. You can now explicitly start Auto Trading.",
    data: {
      ...serializeSettings(settings),
      engineStopped,
    },
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

  const limit = Number.isFinite(
    requestedLimit
  )
    ? Math.min(
        Math.max(
          Math.floor(requestedLimit),
          1
        ),
        100
      )
    : 50;

  const data = await Trade.find({
    userId,
  })
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

