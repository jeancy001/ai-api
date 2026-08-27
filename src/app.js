import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";

import authRoutes from "./routes/authRoutes.js";
import derivRoutes from "./routes/derivRoutes.js";
import marketRoutes from "./routes/marketRoutes.js";
import tradingRoutes from "./routes/tradingRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";

export const app = express();

/* ============================================================
   APPLICATION LOCALS
============================================================ */

/**
 * Temporary OAuth PKCE state storage.
 *
 * This is suitable for local development and a single Node.js
 * instance. For multi-instance/serverless production deployments,
 * use MongoDB with a TTL index.
 */
app.locals.oauthStates = new Map();

/* ============================================================
   SECURITY
============================================================ */

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

/**
 * CORS configuration.
 *
 * Supports the configured frontend and common local development
 * origins. Requests without an Origin header (health checks,
 * server-to-server requests) are also allowed.
 */
const allowedOrigins = new Set(
  [
    env.FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter(Boolean),
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server requests and configured frontends.
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS origin not allowed: ${origin}`),
      );
    },
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  }),
);

/* ============================================================
   BODY PARSING
============================================================ */

app.use(
  express.json({
    limit: "100kb",
  }),
);

/* ============================================================
   RATE LIMITING
============================================================ */

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message:
        "Too many requests. Please try again later.",
    },
  }),
);

/* ============================================================
   HEALTH CHECK
============================================================ */

app.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      status: "ok",
      time: new Date().toISOString(),
    },
  });
});

/* ============================================================
   API ROUTES
============================================================ */

app.use("/api/v1/auth", authRoutes);

app.use(
  "/api/v1/account/deriv",
  derivRoutes,
);

app.use("/api/v1/markets", marketRoutes);

app.use("/api/v1/trading", tradingRoutes);

app.use("/api/v1/settings", settingsRoutes);

app.use("/api/v1/dashboard", dashboardRoutes);

/* ============================================================
   404 HANDLER
============================================================ */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(errorHandler);