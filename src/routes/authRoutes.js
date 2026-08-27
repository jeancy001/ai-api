import { Router } from "express";
import * as authController from "../controllers/authController.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { auth } from "../middleware/auth.js";

const router = Router();

/* ============================================================
   AUTHENTICATION
============================================================ */

// Create account
router.post(
  "/register",
  asyncHandler(authController.register),
);

// Verify email address
router.post(
  "/verify-email",
  asyncHandler(authController.verifyEmail),
);

// Login
router.post(
  "/login",
  asyncHandler(authController.login),
);

// Refresh access token
router.post(
  "/refresh",
  asyncHandler(authController.refresh),
);

// Logout and revoke the current session
router.post(
  "/logout",
  auth,
  asyncHandler(authController.logout),
);

/* ============================================================
   PASSWORD RECOVERY
============================================================ */

// Request password reset code
router.post(
  "/forgot-password",
  asyncHandler(authController.forgotPassword),
);

// Reset password using verification code
router.post(
  "/reset-password",
  asyncHandler(authController.resetPassword),
);

/* ============================================================
   CURRENT USER
============================================================ */

router.get(
  "/me",
  auth,
  asyncHandler(authController.me),
);

export default router;