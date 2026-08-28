import { TradingSettings } from "../models/TradingSettings.js";
import { Trade } from "../models/Trade.js";
import { DerivAccount } from "../models/DerivAccount.js";

import { AppError } from "../utils/AppError.js";
import { decrypt } from "../utils/crypto.js";

import { autoTradingService } from "../services/AutoTradingService.js";
import { derivMarketService } from "../services/DerivMarketService.js";
import { derivBalanceService } from "../services/DerivBalanceService.js";
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

function normalizeText(value) {
return String(value || "")
.trim()
.toLowerCase();
}

function serializeSettings(settings) {
if (!settings) return null;

const data =
typeof settings.toObject === "function"
? settings.toObject()
: { ...settings };

// Explicitly return only fields the frontend needs.
return {
userId: data.userId,


selectedMarket: data.selectedMarket || null,
contractType: data.contractType || null,
contractDuration: data.contractDuration ?? null,
contractDurationUnit:
  data.contractDurationUnit || null,
stakeBasis: data.stakeBasis || "stake",

autoTradingEnabled:
  data.autoTradingEnabled === true,

realTradingAuthorized:
  data.realTradingAuthorized === true,

realTradingAuthorizedAt:
  data.realTradingAuthorizedAt || null,

emergencyStop:
  data.emergencyStop === true,

emergencyStoppedAt:
  data.emergencyStoppedAt || null,

emergencyReleasedAt:
  data.emergencyReleasedAt || null,

stake: data.stake,
maxStake: data.maxStake,
minimumBalance: data.minimumBalance,

maxDailyLoss: data.maxDailyLoss,
maxDailyTrades: data.maxDailyTrades,
maxConsecutiveLosses:
  data.maxConsecutiveLosses,

aiConfidenceThreshold:
  data.aiConfidenceThreshold,

tradingIntervalMs:
  data.tradingIntervalMs,

analysisInterval:
  data.analysisInterval,

cooldown: data.cooldown,

stopReason: data.stopReason || null,
startedAt: data.startedAt || null,
stoppedAt: data.stoppedAt || null,

createdAt: data.createdAt || null,
updatedAt: data.updatedAt || null,


};
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

/* ============================================================
SELECTED REAL DERIV ACCOUNT
============================================================ */

async function getSelectedRealAccountOrThrow(
userId,
{ includeToken = false } = {}
) {
let query = DerivAccount.findOne({
userId,
selected: true,
});

if (includeToken) {
query = query.select("+encryptedAccessToken");
}

const account = await query;

if (!account) {
throw new AppError(
"Please connect and select a Deriv account before continuing.",
400,
"DERIV_ACCOUNT_NOT_SELECTED"
);
}

if (!account.derivAccountId) {
throw new AppError(
"The selected Deriv account does not have a valid account ID. Please reconnect your account.",
400,
"DERIV_ACCOUNT_ID_MISSING"
);
}

if (
normalizeText(account.accountType) !== "real"
) {
throw new AppError(
"The selected account is not a REAL Deriv account. Select a real account before using live auto-trading.",
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

if (
includeToken &&
(
typeof account.encryptedAccessToken !==
"string" ||
!account.encryptedAccessToken.trim()
)
) {
throw new AppError(
"The selected Deriv account does not have valid credentials. Please reconnect your account.",
401,
"DERIV_TOKEN_MISSING"
);
}

return account;
}

/* ============================================================
DERIV ACCESS TOKEN
============================================================ */

function getAccessToken(account) {
try {
const token = decrypt(
account.encryptedAccessToken
);


if (
  typeof token !== "string" ||
  !token.trim()
) {
  throw new Error("Invalid access token");
}

return token.trim();


} catch {
throw new AppError(
"Unable to access Deriv credentials. Please reconnect your Deriv account.",
401,
"DERIV_TOKEN_INVALID"
);
}
}

/* ============================================================
LIVE BALANCE
============================================================ */

function serializeLiveBalance(account, liveBalance) {
if (
!liveBalance ||
typeof liveBalance !== "object"
) {
throw new AppError(
"Deriv did not return live balance information",
502,
"DERIV_LIVE_BALANCE_UNAVAILABLE"
);
}

const rawBalance = liveBalance.balance;

if (
rawBalance === undefined ||
rawBalance === null ||
rawBalance === ""
) {
throw new AppError(
"Deriv did not return a balance for the selected account",
502,
"DERIV_LIVE_BALANCE_MISSING"
);
}

const amount = Number(rawBalance);

if (!Number.isFinite(amount)) {
throw new AppError(
"Deriv returned an invalid live balance",
502,
"DERIV_LIVE_BALANCE_INVALID"
);
}

const responseAccountId =
liveBalance.accountId ??
liveBalance.loginid ??
liveBalance.loginId ??
liveBalance.account_id ??
null;

if (
responseAccountId !== null &&
String(responseAccountId).trim() !==
String(account.derivAccountId).trim()
) {
throw new AppError(
"Deriv returned balance information for a different account",
403,
"DERIV_BALANCE_ACCOUNT_MISMATCH"
);
}

const currency =
typeof liveBalance.currency === "string" &&
liveBalance.currency.trim()
? liveBalance.currency.trim().toUpperCase()
: typeof account.currency === "string" &&
account.currency.trim()
? account.currency.trim().toUpperCase()
: null;

return {
balance: amount,
currency,
accountId: String(account.derivAccountId),
derivAccountId: String(account.derivAccountId),
accountType: "real",
source: "deriv_live",
updatedAt:
typeof liveBalance.updatedAt === "string"
? liveBalance.updatedAt
: new Date().toISOString(),
};
}

async function fetchLiveBalanceFromAccount(account) {
const accessToken = getAccessToken(account);

const liveBalance =
await derivBalanceService.get(
String(account.derivAccountId),
accessToken,
{ subscribe: false }
);

if (!liveBalance) {
throw new AppError(
"Deriv did not return the current account balance",
502,
"DERIV_LIVE_BALANCE_UNAVAILABLE"
);
}

return serializeLiveBalance(
account,
liveBalance
);
}

async function fetchLiveDerivBalance(userId) {
const account =
await getSelectedRealAccountOrThrow(
userId,
{ includeToken: true }
);

const balance =
await fetchLiveBalanceFromAccount(account);

return {
account,
balance,
};
}

async function getLiveBalanceForStatus(
userId,
selectedAccount
) {
if (!selectedAccount) {
return {
balance: null,
currency: null,
accountId: null,
derivAccountId: null,
accountType: null,
source: null,
updatedAt: null,
available: false,
error: "NO_SELECTED_ACCOUNT",
};
}

if (
normalizeText(selectedAccount.accountType) !==
"real" ||
!isAccountConnected(selectedAccount)
) {
return {
balance: null,
currency:
selectedAccount.currency || null,
accountId:
selectedAccount.derivAccountId || null,
derivAccountId:
selectedAccount.derivAccountId || null,
accountType:
selectedAccount.accountType || null,
source: null,
updatedAt: null,
available: false,
error:
normalizeText(selectedAccount.accountType) !==
"real"
? "REAL_ACCOUNT_REQUIRED"
: "DERIV_ACCOUNT_NOT_CONNECTED",
};
}

try {
// Reload with token because the status query intentionally
// does not expose credentials.
const { balance } =
await fetchLiveDerivBalance(userId);


return {
  ...balance,
  available: true,
  error: null,
};


} catch (error) {
console.error(
"Unable to fetch current live Deriv balance:",
error?.message || error
);


return {
  balance: null,
  currency:
    selectedAccount.currency || null,
  accountId:
    selectedAccount.derivAccountId || null,
  derivAccountId:
    selectedAccount.derivAccountId || null,
  accountType:
    selectedAccount.accountType || null,
  source: null,
  updatedAt: null,
  available: false,
  error:
    error?.code ||
    error?.message ||
    "DERIV_BALANCE_UNAVAILABLE",
};


}
}

/* ============================================================
ENGINE STATE
============================================================ */

function isEngineRunning(userId) {
try {
return (
autoTradingService?.isRunning?.(userId) ===
true
);
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
let settings =
await TradingSettings.findOne({ userId });

if (!settings) {
settings =
await TradingSettings.create(
defaultSettings(userId)
);
}

return settings;
}

async function validateSelectedMarketOrThrow(
settings
) {
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

const symbol =
await derivMarketService.symbol(market);

if (!symbol?.symbol) {
throw new AppError(
"The selected market is currently unavailable on Deriv",
400,
"MARKET_UNAVAILABLE"
);
}

return symbol;
}

async function stopEngineSafely(
userId,
reason
) {
try {
if (
typeof autoTradingService?.stop !==
"function"
) {
console.warn(
"AutoTradingService.stop() is not available"
);
return false;
}


await autoTradingService.stop(
  userId,
  reason
);

return true;


} catch (error) {
console.error(
"Trading engine stop failed:",
error?.message || error
);


return false;


}
}

async function startEngineOrThrow(userId) {
if (
typeof autoTradingService?.start !==
"function"
) {
throw new Error(
"AutoTradingService.start() is not implemented"
);
}

const result =
await autoTradingService.start(userId);

if (
result?.started === false &&
result?.reason !== "ALREADY_RUNNING"
) {
throw new Error(
result?.reason ||
"The trading engine could not start"
);
}

if (!isEngineRunning(userId)) {
throw new Error(
"The trading engine did not remain running after startup"
);
}

return result;
}

function buildEngineState(
settings,
engineRunning
) {
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
(enabled &&
!emergencyActive &&
!engineRunning) ||
(!enabled && engineRunning),
};
}

/* ============================================================
GET /trading/status
============================================================ */

export async function status(req, res) {
const userId = getUserId(req);

const [settings, account] =
await Promise.all([
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

const [balance, engineRunning] =
await Promise.all([
getLiveBalanceForStatus(
userId,
account
),
Promise.resolve(
isEngineRunning(userId)
),
]);

const engine = buildEngineState(
settings,
engineRunning
);

const accountData = account
? {
accountId: account.derivAccountId,
derivAccountId:
account.derivAccountId,
accountType: account.accountType,
currency:
balance.currency ||
account.currency ||
null,
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
balance: balance.balance,
currentBalance: balance.balance,
}
: null;

return res.status(200).json({
success: true,
data: {
settings: serializeSettings(settings),
engine,
balance,
currentBalance: balance.balance,
account: accountData,
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

if (
confirmation !==
REAL_AUTH_CONFIRMATION
) {
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

const settings =
await getSettings(userId);

const engineRunningBefore =
isEngineRunning(userId);

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

const account =
await getSelectedRealAccountOrThrow(userId);

const market =
await validateSelectedMarketOrThrow(settings);

if (
settings.autoTradingEnabled === true &&
engineRunningBefore === true
) {
return res.status(200).json({
success: true,
message:
"Auto-trading is already running.",
data: {
...serializeSettings(settings),
engine: buildEngineState(
settings,
true
),
},
});
}

const wasEnabledBefore =
settings.autoTradingEnabled === true;

const recoveringEngine =
wasEnabledBefore &&
engineRunningBefore === false;

settings.autoTradingEnabled = true;
settings.stopReason = null;
settings.startedAt =
settings.startedAt || new Date();
settings.stoppedAt = null;

await settings.save();

try {
await startEngineOrThrow(userId);
} catch (error) {
/*
* Preserve the persisted enabled state during a recovery
* attempt. A temporary process failure should not silently
* change the user's intended trading state.
*/
settings.autoTradingEnabled =
wasEnabledBefore;


settings.stopReason =
  recoveringEngine
    ? "ENGINE_RECOVERY_FAILED"
    : "ENGINE_START_FAILED";

settings.stoppedAt =
  recoveringEngine
    ? settings.stoppedAt
    : new Date();

await settings.save();

await logActivitySafe({
  userId,
  type: "AUTO_TRADING_START_FAILED",
  title: recoveringEngine
    ? "Auto-trading recovery failed"
    : "Auto-trading failed to start",
  description:
    error?.message ||
    "The automatic trading engine could not start.",
  metadata: {
    accountId: account.derivAccountId,
    market: settings.selectedMarket,
    recoveryAttempt:
      recoveringEngine,
  },
});

throw new AppError(
  error?.message ||
    "Unable to start the auto-trading engine",
  500,
  recoveringEngine
    ? "AUTO_TRADING_RECOVERY_FAILED"
    : "AUTO_TRADING_START_FAILED"
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
engine: buildEngineState(
settings,
engineRunningAfter
),
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

const settings =
await getSettings(userId);

const engineRunning =
isEngineRunning(userId);

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

ONLY this endpoint activates the persistent Emergency Stop lock.
============================================================ */

export async function emergency(req, res) {
const userId = getUserId(req);

const settings =
await getSettings(userId);

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
============================================================ */

export async function releaseEmergencyStop(
req,
res
) {
const userId = getUserId(req);

const settings =
await getSettings(userId);

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

const requestedLimit =
Number(req.query.limit);

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
