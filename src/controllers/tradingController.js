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
* The database safety state is always the source of truth.
* Failure to stop an in-memory scheduler must not undo a
* persistent safety block.
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

/**

* Emergency Stop does NOT revoke an existing real-money
* authorization. Authorization is a separate user consent state.
*
* This endpoint therefore remains available even if Emergency Stop
* is active. Emergency Stop still prevents actual trade execution
* until explicitly released.
  */
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

if (!settings.realTradingAuthorized) {
throw new AppError(
"Real-money trading must be explicitly authorized first",
400,
"REAL_AUTH_REQUIRED"
);
}

/**

* Emergency Stop blocks START only while it is enabled.
* Once releaseEmergencyStop() clears the flag, Start works
* normally without requiring a new authorization.
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

/**

* If a scheduler is already active, don't create another one.
  */
  if (
  settings.autoTradingEnabled &&
  autoTradingService?.isRunning?.(userId)
  ) {
  return res.status(200).json({
  success: true,
  message:
  "Auto-trading is already running",
  data: serializeSettings(settings),
  });
  }

/**

* Enable the persistent execution flag before starting the engine.
* Every cycle independently verifies this state.
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
* Do NOT modify emergencyStop or authorization here.
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

/**

* Normal Stop does not activate Emergency Stop.
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

/**

* Emergency Stop is an immediate execution block.
*
* It is active only while settings.emergencyStop === true.
* It does NOT revoke realTradingAuthorized.
  */
  export async function emergency(req, res) {
  const userId = getUserId(req);

const settings = await getSettings(userId);

/**

* Persist the block first so every active or future cycle can
* independently refuse execution.
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
"Emergency Stop was activated. Automatic trading is blocked while Emergency Stop remains enabled.",
metadata: {
engineStopped,
},
});

return res.status(200).json({
success: true,
message:
"Emergency Stop is active. Automatic trading is blocked until Emergency Stop is explicitly released.",
data: serializeSettings(settings),
});
}

/* ============================================================
POST /trading/release-emergency-stop

Releasing Emergency Stop removes only the emergency block.
It NEVER automatically starts trading.
============================================================ */

export async function releaseEmergencyStop(req, res) {
const userId = getUserId(req);

const settings = await getSettings(userId);

if (settings.emergencyStop !== true) {
return res.status(200).json({
success: true,
message: "Emergency Stop is not active",
data: serializeSettings(settings),
});
}

/**

* Verify that the account is still valid.
*
* This does not start the scheduler and does not change
* realTradingAuthorized.
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
"Emergency Stop was released. Automatic trading remains disabled until the user explicitly starts it.",
});

return res.status(200).json({
success: true,
message:
"Emergency Stop has been released. Automatic trading is still stopped and requires an explicit Start action.",
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
