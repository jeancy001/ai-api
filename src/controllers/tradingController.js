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

* Safely check whether the in-memory trading engine is running.
*
* MongoDB remains the source of truth for permission to trade.
* This value is primarily used to detect scheduler/state mismatches.
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

// Explicit contract configuration.
contractType: null,
contractDuration: null,
contractDurationUnit: null,
stakeBasis: "stake",

// Execution and safety defaults.
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

tradingIntervalMs: 15_000,
analysisInterval: 15_000,
cooldown: 5_000,

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

if (normalizeText(account.accountType) !== "real") {
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

* Validate the selected market before starting the engine.
  */
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

/**

* Stop the local scheduler safely.
*
* IMPORTANT:
* MongoDB safety state is persisted before calling this function.
* Therefore, even if the process-level scheduler fails to stop,
* future execution cycles must independently see that trading is
* disabled and refuse to execute trades.
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

const engineRunning = isEngineRunning(userId);

/**

* Database state controls whether trading is authorized to run.
*
* engineRunning only reports the local scheduler state.
  */
  const tradingActive =
  settings.autoTradingEnabled === true &&
  engineRunning === true;

return res.status(200).json({
success: true,
data: {
settings: serializeSettings(settings),


  engine: {
    running: engineRunning,
    active: tradingActive,

    /**
     * Useful for diagnosing deployment restarts or scheduler
     * failures without allowing the frontend to override safety.
     */
    stateMismatch:
      settings.autoTradingEnabled === true &&
      engineRunning === false,
  },

  account: account
    ? {
        accountId: account.derivAccountId,
        derivAccountId: account.derivAccountId,

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


message: settings.emergencyStop
  ? "Real-money auto-trading is authorized. Emergency Stop is still active, so trading cannot execute until it is explicitly released."
  : "Real-money auto-trading has been authorized. Trading remains stopped until you explicitly start it.",

data: serializeSettings(settings),


});
}

/* ============================================================
POST /trading/start
============================================================ */

export async function start(req, res) {
const userId = getUserId(req);

const settings = await getSettings(userId);
const engineRunning = isEngineRunning(userId);

if (!settings.realTradingAuthorized) {
throw new AppError(
"Real-money trading must be explicitly authorized first",
400,
"REAL_AUTH_REQUIRED"
);
}

if (settings.emergencyStop === true) {
throw new AppError(
"Trading cannot start while Emergency Stop is active. Release Emergency Stop first.",
409,
"EMERGENCY_STOP_ACTIVE"
);
}

const account =
await getSelectedRealAccountOrThrow(userId);

await validateSelectedMarketOrThrow(settings);

/**

* Already healthy and running.
  */
  if (
  settings.autoTradingEnabled === true &&
  engineRunning
  ) {
  return res.status(200).json({
  success: true,
  message:
  "Auto-trading is already running",
  data: serializeSettings(settings),
  });
  }

/**

* Database says trading is enabled but the engine disappeared.
* This can happen after a server restart.
*
* We allow the explicit Start request to recover the scheduler.
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
/**
* Roll back only the start operation.
*
* Never change emergencyStop or real-money authorization here.
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
const engineRunning = isEngineRunning(userId);

/**

* This is the important fix.
*
* If the persistent trading state is already disabled AND no
* engine is running, there is nothing to stop.
*
* The frontend can now receive a 409 response and keep its Stop
* button disabled when trading is not active.
  */
  if (
  settings.autoTradingEnabled !== true &&
  engineRunning !== true
  ) {
  throw new AppError(
  "Auto-trading is already stopped",
  409,
  "AUTO_TRADING_ALREADY_STOPPED"
  );
  }

/**

* Persist the safety state FIRST.
*
* Any active trading cycle must read this state before executing
* a new trade.
  */
  settings.autoTradingEnabled = false;
  settings.stopReason = "USER_REQUESTED_STOP";
  settings.stoppedAt = new Date();

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
wasEngineRunning: engineRunning,
},
});

return res.status(200).json({
success: true,
message:
"Auto-trading has been stopped. New automated trades are blocked.",
data: {
...serializeSettings(settings),
engineStopped,
},
});
}

/* ============================================================
POST /trading/emergency-stop
============================================================ */

export async function emergency(req, res) {
const userId = getUserId(req);

const settings = await getSettings(userId);

/**

* Emergency Stop is intentionally idempotent.
*
* A safety control should remain safe even when clicked more
* than once. It always persists the execution block.
  */
  const wasAlreadyActive =
  settings.emergencyStop === true;

settings.autoTradingEnabled = false;
settings.emergencyStop = true;
settings.stopReason = "EMERGENCY_STOP";

if (!wasAlreadyActive) {
settings.emergencyStoppedAt = new Date();
}

await settings.save();

const engineStopped = await stopEngineSafely(
userId,
"EMERGENCY_STOP"
);

if (!wasAlreadyActive) {
await logActivitySafe({
userId,
type: "EMERGENCY_STOP",
title: "Emergency stop activated",
description:
"Emergency Stop was activated. Automatic trading is blocked while Emergency Stop remains enabled.",
metadata: {
engineStopped,
},
});
}

return res.status(200).json({
success: true,
message: wasAlreadyActive
? "Emergency Stop is already active. Automatic trading remains blocked."
: "Emergency Stop is active. Automatic trading is blocked until it is explicitly released.",


data: {
  ...serializeSettings(settings),
  engineStopped,
},


});
}

/* ============================================================
POST /trading/release-emergency-stop

Releasing Emergency Stop removes only the emergency block.
It NEVER automatically starts trading.
============================================================ */

/* ============================================================
POST /trading/release-emergency-stop

Releases only the Emergency Stop lock.

IMPORTANT:
- Does NOT authorize real-money trading.
- Does NOT start the trading engine.
- Does NOT enable auto-trading.
- The user must explicitly press Start afterwards.
============================================================ */

export async function releaseEmergencyStop(req, res) {
  const userId = getUserId(req);

  const settings = await getSettings(userId);

  // Idempotent: releasing an inactive emergency stop is safe.
  if (settings.emergencyStop !== true) {
    return res.status(200).json({
      success: true,
      message: "Emergency Stop is already inactive.",
      data: serializeSettings(settings),
    });
  }

  /**
   * Keep trading explicitly stopped.
   *
   * Releasing the emergency lock must NEVER restart the engine.
   */
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
      "Emergency Stop was released. Automatic trading remains stopped and requires an explicit Start action.",
    metadata: {
      autoTradingEnabled: false,
    },
  });

  return res.status(200).json({
    success: true,
    message:
      "Emergency Stop has been released. Auto-trading remains stopped. Press Start Auto Trading when you are ready.",
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
Math.max(
Math.floor(requestedLimit),
1
),
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
