import { TradingSettings } from "../models/TradingSettings.js";
import { AppError } from "../utils/AppError.js";
import { derivMarketService } from "../services/DerivMarketService.js";
import { logActivitySafe } from "../services/ActivityService.js";

/**
 * Fields the client is allowed to modify.
 *
 * IMPORTANT:
 * Trading engine state and real-money authorization are intentionally
 * NOT included here. Those fields must only be controlled by dedicated
 * backend endpoints.
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
  "cooldown",
]);

const MIN_ANALYSIS_INTERVAL = 5_000;
const MAX_ANALYSIS_INTERVAL = 60 * 60 * 1000; // 1 hour

const MIN_COOLDOWN = 0;
const MAX_COOLDOWN = 60 * 60 * 1000; // 1 hour

/* ============================================================
   HELPERS
============================================================ */

/**
 * Get the authenticated user ID consistently.
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
 * Default settings for a new user.
 *
 * Trading is disabled and unauthorized by default.
 */
function createDefaultSettings(userId) {
  return {
    userId,

    selectedMarket: null,

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

    // AI confidence is between 0 and 1.
    aiConfidenceThreshold: 0.7,

    // Milliseconds.
    analysisInterval: 15_000,
    cooldown: 5_000,
  };
}

/**
 * Return a plain object suitable for the API.
 */
function serializeSettings(settings) {
  if (!settings) {
    return null;
  }

  return typeof settings.toObject === "function"
    ? settings.toObject()
    : { ...settings };
}

/**
 * Validate and normalize incoming settings.
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
    "cooldown",
  ];

  for (const field of numericFields) {
    if (!(field in patch)) {
      continue;
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

  if (
    patch.stake !== undefined &&
    patch.stake <= 0
  ) {
    throw new AppError(
      "Stake must be greater than zero",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.maxStake !== undefined &&
    patch.maxStake <= 0
  ) {
    throw new AppError(
      "Maximum stake must be greater than zero",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.minimumBalance !== undefined &&
    patch.minimumBalance < 0
  ) {
    throw new AppError(
      "Minimum balance cannot be negative",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.maxDailyLoss !== undefined &&
    patch.maxDailyLoss < 0
  ) {
    throw new AppError(
      "Maximum daily loss cannot be negative",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.maxDailyTrades !== undefined &&
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
    patch.maxConsecutiveLosses !== undefined &&
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
    patch.aiConfidenceThreshold !== undefined &&
    (patch.aiConfidenceThreshold < 0 ||
      patch.aiConfidenceThreshold > 1)
  ) {
    throw new AppError(
      "AI confidence threshold must be between 0 and 1",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.analysisInterval !== undefined &&
    (!Number.isInteger(patch.analysisInterval) ||
      patch.analysisInterval < MIN_ANALYSIS_INTERVAL ||
      patch.analysisInterval > MAX_ANALYSIS_INTERVAL)
  ) {
    throw new AppError(
      `Analysis interval must be an integer between ${MIN_ANALYSIS_INTERVAL} and ${MAX_ANALYSIS_INTERVAL} milliseconds`,
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.cooldown !== undefined &&
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
    patch.selectedMarket !== undefined &&
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

    if (!patch.selectedMarket) {
      patch.selectedMarket = null;
    }
  }
}

/**
 * Verify that a selected market exists and is currently open on Deriv.
 */
async function validateSelectedMarket(selectedMarket) {
  if (!selectedMarket) {
    return;
  }

  const market =
    await derivMarketService.symbol(selectedMarket);

  if (!market) {
    throw new AppError(
      `The market "${selectedMarket}" is not currently available on Deriv`,
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

/**
 * Ensure the user's settings document exists.
 */
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
 * Only explicitly whitelisted configuration fields may be modified.
 *
 * Security-sensitive fields remain backend-controlled:
 * - autoTradingEnabled
 * - realTradingAuthorized
 * - emergencyStop
 * - stopReason
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

  const submittedFields = Object.keys(req.body);

  const forbiddenFields =
    submittedFields.filter(
      (field) => !ALLOWED_FIELDS.has(field),
    );

  /**
   * Reject unknown fields rather than silently ignoring them.
   */
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

  const current =
    await getOrCreateSettings(userId);

  /**
   * Never allow inconsistent stake limits.
   */
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

  /**
   * Validate the market only when the user is changing it.
   */
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "selectedMarket",
    )
  ) {
    await validateSelectedMarket(
      patch.selectedMarket,
    );
  }

  /**
   * Safety policy:
   * Trading/risk configuration cannot be changed while
   * automatic trading is active.
   */
  if (current.autoTradingEnabled) {
    throw new AppError(
      "Stop auto-trading before changing trading or risk settings",
      409,
      "STOP_TRADING_BEFORE_SETTINGS_CHANGE",
    );
  }

  /**
   * Apply changes to the existing document.
   */
  Object.assign(current, patch);

  await current.save();

  /**
   * Logging must never make a successful settings update fail.
   *
   * logActivitySafe already handles errors internally.
   */
  await logActivitySafe({
    userId,
    type: "TRADING_SETTINGS_UPDATED",
    title: "Trading settings updated",
    description:
      "The user updated automatic trading configuration.",
    metadata: {
      changedFields: Object.keys(patch),
      selectedMarket:
        patch.selectedMarket ??
        current.selectedMarket ??
        null,
    },
  });

  return res.status(200).json({
    success: true,
    message: "Trading settings updated successfully",
    data: serializeSettings(current),
  });
}