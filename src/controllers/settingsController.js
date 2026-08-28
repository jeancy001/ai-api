import { TradingSettings } from "../models/TradingSettings.js";
import { AppError } from "../utils/AppError.js";
import { derivMarketService } from "../services/DerivMarketService.js";
import { logActivitySafe } from "../services/ActivityService.js";

/**

* Trading settings that the authenticated user is allowed to modify.
*
* IMPORTANT:
* Execution state, real-money authorization, and emergency controls
* are intentionally excluded. Those values must only be changed by
* dedicated backend actions.
  */
  const ALLOWED_FIELDS = new Set([
  "selectedMarket",
  "stake",
  "maxStake",
  "minimumBalance",
  "maxDailyLoss",
  "maxDailyTrades",
  "maxConsecutiveLosses",
  "aiConfidenceThreshold",
  "analysisInterval",
  "tradingIntervalMs",
  "cooldown",

/**

* Explicit contract configuration.
*
* These are configuration values only. They do not allow the client
* or AI to directly send arbitrary parameters to Deriv.
  */
  "contractType",
  "contractDuration",
  "contractDurationUnit",
  "stakeBasis",
  "currency",
  ]);

const MIN_ANALYSIS_INTERVAL = 5_000;
const MAX_ANALYSIS_INTERVAL = 60 * 60 * 1000;

const MIN_COOLDOWN = 0;
const MAX_COOLDOWN = 60 * 60 * 1000;

const MIN_CONTRACT_DURATION = 1;
const MAX_CONTRACT_DURATION = 10_000;

const ALLOWED_DURATION_UNITS = new Set([
"s",
"m",
"h",
"d",
"t",
]);

const ALLOWED_STAKE_BASES = new Set([
"stake",
"payout",
]);

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
"UNAUTHORIZED",
);
}

return String(userId);
}

/**

* Default settings for a new user.
*
* Safety-sensitive execution fields always start disabled.
  */
  function createDefaultSettings(userId) {
  return {
  userId,

  selectedMarket: null,

  // Backend-controlled safety state.
  autoTradingEnabled: false,
  realTradingAuthorized: false,
  emergencyStop: false,

  // Risk configuration.
  stake: 1,
  maxStake: 10,
  minimumBalance: 0,
  maxDailyLoss: 10,
  maxDailyTrades: 10,
  maxConsecutiveLosses: 3,

  // AI is analysis only.
  aiConfidenceThreshold: 0.7,

  // Scheduler configuration.
  analysisInterval: 15_000,
  tradingIntervalMs: 15_000,
  cooldown: 5_000,

  /**

  * Contract configuration starts incomplete deliberately.
  *
  * AutoTradingService must refuse execution until the user has
  * selected a backend-supported contract configuration.
    */
    contractType: null,
    contractDuration: null,
    contractDurationUnit: null,
    stakeBasis: "stake",
    currency: null,
    };
    }

function serializeSettings(settings) {
if (!settings) {
return null;
}

return typeof settings.toObject === "function"
? settings.toObject()
: { ...settings };
}

function hasOwn(object, key) {
return Object.prototype.hasOwnProperty.call(
object,
key,
);
}

function validateNumber(patch, field) {
if (!hasOwn(patch, field)) {
return;
}

const value = Number(patch[field]);

if (!Number.isFinite(value)) {
throw new AppError(
`${field} must be a valid number`,
400,
"VALIDATION_ERROR",
);
}

patch[field] = value;
}

/**

* Validate and normalize incoming user-controlled settings.
  */
  function validatePatch(patch) {
  const numericFields = [
  "stake",
  "maxStake",
  "minimumBalance",
  "maxDailyLoss",
  "maxDailyTrades",
  "maxConsecutiveLosses",
  "aiConfidenceThreshold",
  "analysisInterval",
  "tradingIntervalMs",
  "cooldown",
  "contractDuration",
  ];

for (const field of numericFields) {
validateNumber(patch, field);
}

if (
hasOwn(patch, "stake") &&
patch.stake <= 0
) {
throw new AppError(
"Stake must be greater than zero",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "maxStake") &&
patch.maxStake <= 0
) {
throw new AppError(
"Maximum stake must be greater than zero",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "minimumBalance") &&
patch.minimumBalance < 0
) {
throw new AppError(
"Minimum balance cannot be negative",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "maxDailyLoss") &&
patch.maxDailyLoss < 0
) {
throw new AppError(
"Maximum daily loss cannot be negative",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "maxDailyTrades") &&
(!Number.isInteger(patch.maxDailyTrades) ||
patch.maxDailyTrades < 1)
) {
throw new AppError(
"Maximum daily trades must be a positive integer",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "maxConsecutiveLosses") &&
(!Number.isInteger(
patch.maxConsecutiveLosses,
) ||
patch.maxConsecutiveLosses < 1)
) {
throw new AppError(
"Maximum consecutive losses must be a positive integer",
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "aiConfidenceThreshold") &&
(patch.aiConfidenceThreshold < 0 ||
patch.aiConfidenceThreshold > 1)
) {
throw new AppError(
"AI confidence threshold must be between 0 and 1",
400,
"VALIDATION_ERROR",
);
}

for (const field of [
"analysisInterval",
"tradingIntervalMs",
]) {
if (
hasOwn(patch, field) &&
(!Number.isInteger(patch[field]) ||
patch[field] < MIN_ANALYSIS_INTERVAL ||
patch[field] > MAX_ANALYSIS_INTERVAL)
) {
throw new AppError(
`${field} must be an integer between ${MIN_ANALYSIS_INTERVAL} and ${MAX_ANALYSIS_INTERVAL} milliseconds`,
400,
"VALIDATION_ERROR",
);
}
}

if (
hasOwn(patch, "cooldown") &&
(!Number.isInteger(patch.cooldown) ||
patch.cooldown < MIN_COOLDOWN ||
patch.cooldown > MAX_COOLDOWN)
) {
throw new AppError(
`Cooldown must be an integer between ${MIN_COOLDOWN} and ${MAX_COOLDOWN} milliseconds`,
400,
"VALIDATION_ERROR",
);
}

if (
hasOwn(patch, "contractDuration") &&
(!Number.isInteger(patch.contractDuration) ||
patch.contractDuration <
MIN_CONTRACT_DURATION ||
patch.contractDuration >
MAX_CONTRACT_DURATION)
) {
throw new AppError(
`Contract duration must be an integer between ${MIN_CONTRACT_DURATION} and ${MAX_CONTRACT_DURATION}`,
400,
"VALIDATION_ERROR",
);
}

/* ----------------------------------------------------------
MARKET
---------------------------------------------------------- */

if (
hasOwn(patch, "selectedMarket") &&
patch.selectedMarket !== null &&
typeof patch.selectedMarket !== "string"
) {
throw new AppError(
"Selected market must be a valid market symbol",
400,
"VALIDATION_ERROR",
);
}

if (typeof patch.selectedMarket === "string") {
patch.selectedMarket =
patch.selectedMarket.trim().toUpperCase();

```
if (!patch.selectedMarket) {
  patch.selectedMarket = null;
}
```

}

/* ----------------------------------------------------------
CONTRACT TYPE
---------------------------------------------------------- */

if (hasOwn(patch, "contractType")) {
if (
patch.contractType !== null &&
typeof patch.contractType !== "string"
) {
throw new AppError(
"Contract type must be a valid string",
400,
"VALIDATION_ERROR",
);
}

```
if (typeof patch.contractType === "string") {
  patch.contractType =
    patch.contractType.trim().toUpperCase() ||
    null;
}
```

}

if (hasOwn(patch, "contractDurationUnit")) {
if (
patch.contractDurationUnit !== null &&
typeof patch.contractDurationUnit !== "string"
) {
throw new AppError(
"Contract duration unit must be a valid string",
400,
"VALIDATION_ERROR",
);
}

```
if (
  typeof patch.contractDurationUnit ===
  "string"
) {
  patch.contractDurationUnit =
    patch.contractDurationUnit
      .trim()
      .toLowerCase() || null;

  if (
    patch.contractDurationUnit &&
    !ALLOWED_DURATION_UNITS.has(
      patch.contractDurationUnit,
    )
  ) {
    throw new AppError(
      "Unsupported contract duration unit",
      400,
      "VALIDATION_ERROR",
    );
  }
}
```

}

if (hasOwn(patch, "stakeBasis")) {
if (typeof patch.stakeBasis !== "string") {
throw new AppError(
"Stake basis must be a valid string",
400,
"VALIDATION_ERROR",
);
}

```
patch.stakeBasis =
  patch.stakeBasis.trim().toLowerCase();

if (
  !ALLOWED_STAKE_BASES.has(
    patch.stakeBasis,
  )
) {
  throw new AppError(
    "Stake basis must be either stake or payout",
    400,
    "VALIDATION_ERROR",
  );
}
```

}

if (hasOwn(patch, "currency")) {
if (
patch.currency !== null &&
typeof patch.currency !== "string"
) {
throw new AppError(
"Currency must be a valid string",
400,
"VALIDATION_ERROR",
);
}

```
if (typeof patch.currency === "string") {
  patch.currency =
    patch.currency.trim().toUpperCase() ||
    null;

  if (
    patch.currency &&
    !/^[A-Z]{3,10}$/.test(patch.currency)
  ) {
    throw new AppError(
      "Currency format is invalid",
      400,
      "VALIDATION_ERROR",
    );
  }
}
```

}
}

/**

* Keep the scheduler interval fields synchronized.
*
* AutoTradingService uses tradingIntervalMs. analysisInterval is kept
* for compatibility with existing clients and analysis configuration.
  */
  function synchronizeIntervals(patch) {
  const hasAnalysisInterval = hasOwn(
  patch,
  "analysisInterval",
  );

const hasTradingInterval = hasOwn(
patch,
"tradingIntervalMs",
);

if (
hasAnalysisInterval &&
hasTradingInterval &&
patch.analysisInterval !==
patch.tradingIntervalMs
) {
throw new AppError(
"analysisInterval and tradingIntervalMs must match when both are provided",
400,
"VALIDATION_ERROR",
);
}

if (hasAnalysisInterval && !hasTradingInterval) {
patch.tradingIntervalMs =
patch.analysisInterval;
}

if (hasTradingInterval && !hasAnalysisInterval) {
patch.analysisInterval =
patch.tradingIntervalMs;
}
}

/**

* Verify that a selected market exists and is available.
*
* The trading engine must still validate the market again immediately
* before execution. A market can change state after this request.
  */
  async function validateSelectedMarket(selectedMarket) {
  if (!selectedMarket) {
  return;
  }

const market =
await derivMarketService.symbol(selectedMarket);

if (!market) {
throw new AppError(
`The market "${selectedMarket}" is not available on Deriv`,
400,
"MARKET_UNAVAILABLE",
);
}

if (
market.exchange_is_open === 0 ||
market.exchange_is_open === false
) {
throw new AppError(
`The market "${selectedMarket}" is currently closed`,
400,
"MARKET_CLOSED",
);
}
}

async function getOrCreateSettings(userId) {
let settings =
await TradingSettings.findOne({ userId });

if (!settings) {
settings = await TradingSettings.create(
createDefaultSettings(userId),
);
}

return settings;
}

/* ============================================================
GET /api/v1/settings/trading
============================================================ */

export async function get(req, res) {
const userId = getUserId(req);

const settings =
await getOrCreateSettings(userId);

return res.status(200).json({
success: true,
data: serializeSettings(settings),
});
}

/* ============================================================
PUT /api/v1/settings/trading
============================================================ */

/**

* Update user-controlled trading configuration.
*
* Security-sensitive fields are never accepted here:
* * autoTradingEnabled
* * realTradingAuthorized
* * emergencyStop
* * stopReason
* * authorization timestamps
    */
    export async function update(req, res) {
    const userId = getUserId(req);

if (
!req.body ||
typeof req.body !== "object" ||
Array.isArray(req.body)
) {
throw new AppError(
"Invalid settings data",
400,
"VALIDATION_ERROR",
);
}

const submittedFields =
Object.keys(req.body);

const forbiddenFields =
submittedFields.filter(
(field) => !ALLOWED_FIELDS.has(field),
);

if (forbiddenFields.length > 0) {
throw new AppError(
`The following settings cannot be modified: ${forbiddenFields.join(", ")}`,
403,
"SETTINGS_FIELD_NOT_ALLOWED",
);
}

const patch = { ...req.body };

if (Object.keys(patch).length === 0) {
throw new AppError(
"No settings were provided",
400,
"VALIDATION_ERROR",
);
}

validatePatch(patch);
synchronizeIntervals(patch);

const current =
await getOrCreateSettings(userId);

/* ----------------------------------------------------------
CROSS-FIELD RISK VALIDATION
---------------------------------------------------------- */

const effectiveStake =
patch.stake ?? current.stake;

const effectiveMaxStake =
patch.maxStake ?? current.maxStake;

if (effectiveStake > effectiveMaxStake) {
throw new AppError(
"Stake cannot be greater than maximum stake",
400,
"VALIDATION_ERROR",
);
}

/* ----------------------------------------------------------
MARKET VALIDATION
---------------------------------------------------------- */

if (hasOwn(patch, "selectedMarket")) {
await validateSelectedMarket(
patch.selectedMarket,
);
}

/* ----------------------------------------------------------
SAFETY: NEVER CHANGE ACTIVE CONFIGURATION MID-TRADE
---------------------------------------------------------- */

if (current.autoTradingEnabled) {
throw new AppError(
"Stop auto-trading before changing trading or risk settings",
409,
"STOP_TRADING_BEFORE_SETTINGS_CHANGE",
);
}

/**

* Emergency Stop intentionally remains active until a dedicated
* backend-controlled reset endpoint clears it.
*
* This settings endpoint must never silently clear it.
  */

Object.assign(current, patch);

await current.save();

await logActivitySafe({
userId,
type: "TRADING_SETTINGS_UPDATED",
title: "Trading settings updated",
description:
"The user updated automatic trading configuration.",
metadata: {
changedFields: Object.keys(patch),
selectedMarket:
current.selectedMarket || null,
contractConfigured: Boolean(
current.contractType &&
current.contractDuration &&
current.contractDurationUnit,
),
},
});

return res.status(200).json({
success: true,
message:
"Trading settings updated successfully",
data: serializeSettings(current),
});
}
