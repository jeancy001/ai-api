import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { User } from "../models/User.js";
import { TradingSettings } from "../models/TradingSettings.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { emailService } from "../services/EmailService.js";
import { logActivity } from "../services/ActivityService.js";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Create a JWT access token.
 */
function createAccessToken(user) {
  return jwt.sign(
    {
      id: String(user._id),
      sub: String(user._id),
      email: user.email,
      type: "access",
    },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_EXPIRES_IN || "15m",
    },
  );
}

/**
 * Normalize an email address before database operations.
 */
function normalizeEmail(email) {
  if (typeof email !== "string") return "";

  return email.trim().toLowerCase();
}

/**
 * Never send sensitive database fields to the frontend.
 */
function serializeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * REGISTER
 */
export async function register(req, res) {
  const {
    name,
    email,
    password,
  } = req.body || {};

  const normalizedEmail = normalizeEmail(email);
  const normalizedName =
    typeof name === "string" ? name.trim() : "";

  if (!normalizedName) {
    throw new AppError(
      "Name is required",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (!normalizedEmail) {
    throw new AppError(
      "A valid email address is required",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH
  ) {
    throw new AppError(
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`,
      400,
      "VALIDATION_ERROR",
    );
  }

  const existingUser = await User.exists({
    email: normalizedEmail,
  });

  if (existingUser) {
    throw new AppError(
      "Email already registered",
      409,
      "EMAIL_EXISTS",
    );
  }

  const passwordHash = await bcrypt.hash(
    password,
    12,
  );

  const user = await User.create({
    name: normalizedName,
    email: normalizedEmail,
    passwordHash,
  });

  /**
   * Every user should receive their own trading settings.
   */
  await TradingSettings.findOneAndUpdate(
    { userId: user._id },
    {
      $setOnInsert: {
        userId: user._id,
        autoTradingEnabled: false,
        realTradingAuthorized: false,
        emergencyStop: false,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  await logActivity({
    userId: user._id,
    type: "USER_REGISTERED",
    title: "Account created",
    description: "User registered successfully",
  }).catch((error) => {
    console.error(
      "Failed to log registration activity:",
      error,
    );
  });

  /**
   * Email failures should not delete a successfully created account.
   */
  emailService
    .welcome({
      userId: user._id,
      to: user.email,
      name: user.name,
    })
    .catch((error) => {
      console.error(
        "Failed to send welcome email:",
        error,
      );
    });

  const accessToken = createAccessToken(user);

  return res.status(201).json({
    success: true,
    message: "Account created successfully",
    data: {
      user: serializeUser(user),

      // Keep both temporarily if your frontend currently supports either.
      accessToken,
      token: accessToken,
    },
  });
}

/**
 * LOGIN
 */
export async function login(req, res) {
  const {
    email,
    password,
  } = req.body || {};

  const normalizedEmail = normalizeEmail(email);

  if (
    !normalizedEmail ||
    typeof password !== "string" ||
    !password
  ) {
    throw new AppError(
      "Email and password are required",
      400,
      "VALIDATION_ERROR",
    );
  }

  const user = await User.findOne({
    email: normalizedEmail,
  }).select("+passwordHash");

  if (!user) {
    throw new AppError(
      "Invalid credentials",
      401,
      "INVALID_CREDENTIALS",
    );
  }

  const passwordValid = await bcrypt.compare(
    password,
    user.passwordHash,
  );

  if (!passwordValid) {
    throw new AppError(
      "Invalid credentials",
      401,
      "INVALID_CREDENTIALS",
    );
  }

  const accessToken = createAccessToken(user);

  await logActivity({
    userId: user._id,
    type: "LOGIN_SUCCESS",
    title: "Login successful",
    description: "User logged in successfully",
  }).catch((error) => {
    console.error(
      "Failed to log login activity:",
      error,
    );
  });

  return res.json({
    success: true,
    message: "Login successful",
    data: {
      user: serializeUser(user),
      accessToken,
      token: accessToken,
    },
  });
}

/**
 * CURRENT USER
 *
 * Requires your authentication middleware to attach
 * the authenticated user to req.user.
 */
export async function me(req, res) {
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

  const user = await User.findById(userId);

  if (!user) {
    throw new AppError(
      "User not found",
      404,
      "USER_NOT_FOUND",
    );
  }

  return res.json({
    success: true,
    data: {
      user: serializeUser(user),
    },
  });
}