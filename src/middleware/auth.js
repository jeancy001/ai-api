import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/**
 * Authenticate requests using a JWT access token.
 *
 * Expected header:
 * Authorization: Bearer <access_token>
 */
export function auth(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization) {
      throw new AppError(
        "Authentication required",
        401,
        "UNAUTHORIZED",
      );
    }

    const [scheme, token] = authorization.trim().split(/\s+/);

    if (
      scheme?.toLowerCase() !== "bearer" ||
      !token
    ) {
      throw new AppError(
        "A valid Bearer authentication token is required",
        401,
        "UNAUTHORIZED",
      );
    }

    const payload = jwt.verify(
      token,
      env.JWT_SECRET,
    );

    /**
     * Only access tokens may authenticate API requests.
     *
     * This prevents a refresh token or another JWT type from being
     * accidentally accepted by protected routes.
     */
    if (
      payload.type &&
      payload.type !== "access"
    ) {
      throw new AppError(
        "Invalid authentication token",
        401,
        "UNAUTHORIZED",
      );
    }

    /**
     * Normalize the user identity for all Express controllers.
     *
     * Supports JWTs using either `id` or `sub`, but controllers can
     * consistently use `req.user.id`.
     */
    const userId = payload.id || payload.sub;

    if (!userId) {
      throw new AppError(
        "Invalid authentication token",
        401,
        "UNAUTHORIZED",
      );
    }

    req.user = {
      ...payload,
      id: String(userId),
    };

    return next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }

    if (
      error instanceof jwt.TokenExpiredError
    ) {
      return next(
        new AppError(
          "Authentication token has expired",
          401,
          "TOKEN_EXPIRED",
        ),
      );
    }

    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.NotBeforeError
    ) {
      return next(
        new AppError(
          "Invalid authentication token",
          401,
          "UNAUTHORIZED",
        ),
      );
    }

    return next(
      new AppError(
        "Authentication failed",
        401,
        "UNAUTHORIZED",
      ),
    );
  }
}