import { TradingSettings } from "../models/TradingSettings.js";
import { AppError } from "../utils/AppError.js";

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

function createDefaultSettings(userId) {
  return {
    userId,
    selectedMarket: null,

    // Trading is always disabled by default.
    autoTradingEnabled: false,
    realTradingAuthorized: false,
    emergencyStop: false,

    stake: 1,
    maxStake: 10,
    minimumBalance: 0,
    maxDailyLoss: 10,
    maxDailyTrades: 10,
    maxConsecutiveLosses: 3,

    // AI confidence from 0 to 1.
    aiConfidenceThreshold: 0.7,

    // Milliseconds.
    analysisInterval: 15000,
    cooldown: 5000,
  };
}

/**
 * Validate values that are important for risk management.
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
    if (!(field in patch)) continue;

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
    patch.analysisInterval < 5000
  ) {
    throw new AppError(
      "Analysis interval must be at least 5000 milliseconds",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    patch.cooldown !== undefined &&
    patch.cooldown < 0
  ) {
    throw new AppError(
      "Cooldown cannot be negative",
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
      "Selected market must be a valid symbol",
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
 * GET /settings/trading
 */
export async function get(req, res) {
  const userId = getUserId(req);

  let settings = await TradingSettings.findOne({
    userId,
  });

  /**
   * Safety: ensure every authenticated user has settings.
   */
  if (!settings) {
    settings = await TradingSettings.create(
      createDefaultSettings(userId),
    );
  }

  return res.json({
    success: true,
    data: settings,
  });
}

/**
 * PUT /settings/trading
 *
 * Only explicitly allowed risk/settings fields can be changed.
 * Security-sensitive fields such as autoTradingEnabled and
 * realTradingAuthorized are controlled by dedicated endpoints.
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

  const patch = Object.fromEntries(
    Object.entries(req.body).filter(([key]) =>
      ALLOWED_FIELDS.has(key),
    ),
  );

  if (Object.keys(patch).length === 0) {
    throw new AppError(
      "No valid settings were provided",
      400,
      "VALIDATION_ERROR",
    );
  }

  validatePatch(patch);

  /**
   * Protect against inconsistent stake limits.
   */
  const current = await TradingSettings.findOne({
    userId,
  });

  const effectiveStake =
    patch.stake ??
    current?.stake ??
    1;

  const effectiveMaxStake =
    patch.maxStake ??
    current?.maxStake ??
    10;

  if (effectiveStake > effectiveMaxStake) {
    throw new AppError(
      "Stake cannot be greater than maximum stake",
      400,
      "VALIDATION_ERROR",
    );
  }

  const settings =
    await TradingSettings.findOneAndUpdate(
      { userId },
      {
        $set: patch,
        $setOnInsert: createDefaultSettings(userId),
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

  return res.json({
    success: true,
    message: "Trading settings updated successfully",
    data: settings,
  });
}