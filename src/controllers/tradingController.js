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
* MongoDB remains the source of truth for whether trading is
* permitted to execute.
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

/**
 * IMPORTANT:
 * This must only become true through the explicit
 * /trading/emergency-stop endpoint.
 */
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

if (
normalizeText(account.accountType) !== "real"
) {
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

const tradingActive =
settings.autoTradingEnabled === true &&
settings.emergencyStop !== true &&
engineRunning === true;

let engineState = "STOPPED";

if (settings.emergencyStop === true) {
engineState = "EMERGENCY_BLOCKED";
} else if (tradingActive) {
engineState = "RUNNING";
} else if (
settings.autoTradingEnabled === true &&
!engineRunning
) {
engineState = "STARTING_OR_RECOVERY_REQUIRED";
}

return res.status(200).json({
success: true,
data: {
settings: serializeSettings(settings),


  engine: {
    running: engineRunning,
    active: tradingActive,
    state: engineState,

    stateMismatch:
      settings.autoTradingEnabled === true &&
      settings.emergencyStop !== true &&
      engineRunning === false,
  },

  account: account
    ? {
        accountId: account.derivAccountId,
        derivAccountId:
          account.derivAccountId,
        accountType: account.accountType,
        currency: account.currency,
        selected: account.selected === true,
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
"Real-money auto-trading is authorized. Trading remains stopped until explicitly started.",
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

/**

* Emergency Stop is the ONLY persistent block.
* HOLD, low confidence, skipped cycles and Gemini failures
* must never create this state.
  */
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

* Enable the engine. Never modify emergencyStop here.
  */
  settings.autoTradingEnabled = true;
  settings.stopReason = null;
  settings.startedAt = new Date();
  settings.stoppedAt = null;

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
* A start failure stops only this start request.
* It MUST NOT activate Emergency Stop.
*/
settings.autoTradingEnabled = false;
settings.stopReason =
"ENGINE_START_FAILED";


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
message:
"Auto-trading started successfully. HOLD or skipped analysis cycles will not stop the engine.",
data: serializeSettings(settings),
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
const engineRunning = isEngineRunning(userId);

/**

* Normal Stop is idempotent.
* This makes the frontend safer and prevents unnecessary errors.
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
settings.stopReason = "EMERGENCY_STOP";
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
It never starts the engine automatically.
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

* Ensure no stale scheduler survives the emergency state.
* The next explicit /start creates a fresh engine.
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
"Emergency Stop released successfully. You can now start Auto Trading.",
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
