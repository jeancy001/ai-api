import { derivAuthService } from "../services/DerivAuthService.js";
import { derivService } from "../services/DerivService.js";

import { encrypt, decrypt } from "../utils/crypto.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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
      "UNAUTHORIZED"
    );
  }

  return String(userId);
}

/**
 * Normalize account type for comparisons.
 */
function normalizeAccountType(type) {
  const value = String(type || "")
    .trim()
    .toLowerCase();

  if (
    value === "real" ||
    value === "live" ||
    value === "real_money"
  ) {
    return "real";
  }

  if (
    value === "demo" ||
    value === "virtual" ||
    value === "practice"
  ) {
    return "demo";
  }

  return value || "unknown";
}

/**
 * Build a safe frontend URL.
 */
function getFrontendUrl() {
  const frontendUrl = process.env.FRONTEND_URL;

  if (!frontendUrl) {
    throw new AppError(
      "FRONTEND_URL is not configured",
      503,
      "FRONTEND_NOT_CONFIGURED"
    );
  }

  return frontendUrl.replace(/\/+$/, "");
}

/**
 * Remove sensitive credentials before returning an account.
 */
function sanitizeAccount(account) {
  if (!account) return null;

  const data =
    typeof account.toObject === "function"
      ? account.toObject()
      : { ...account };

  delete data.encryptedAccessToken;
  delete data.encryptedRefreshToken;
  delete data.tokenExpiresAt;

  return data;
}

/**
 * Safely decrypt an account access token.
 *
 * Never return this token to the frontend.
 */
function getAccessToken(account) {
  try {
    const token = decrypt(
      account.encryptedAccessToken
    );

    if (
      typeof token !== "string" ||
      token.trim().length === 0
    ) {
      throw new Error("Empty token");
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
   OAUTH STATE STORE

   IMPORTANT:
   This in-memory implementation is suitable only for a single
   persistent Node.js process.

   For Vercel/serverless or multiple instances, replace this with
   MongoDB or Redis so the callback can access the PKCE verifier.
============================================================ */

function getOAuthStates(req) {
  if (!req.app.locals.oauthStates) {
    req.app.locals.oauthStates = new Map();
  }

  return req.app.locals.oauthStates;
}

function cleanupExpiredStates(store) {
  const now = Date.now();

  for (const [state, value] of store.entries()) {
    if (!value?.expires || value.expires <= now) {
      store.delete(state);
    }
  }
}

/* ============================================================
   START DERIV OAUTH
============================================================ */

export async function connect(req, res) {
  const userId = getUserId(req);

  const authorization =
    await derivAuthService.createAuthorization();

  if (
    !authorization?.state ||
    !authorization?.verifier ||
    !authorization?.url
  ) {
    throw new AppError(
      "Unable to create Deriv authorization request",
      500,
      "DERIV_AUTH_INITIALIZATION_FAILED"
    );
  }

  const oauthStates = getOAuthStates(req);

  cleanupExpiredStates(oauthStates);

  oauthStates.set(authorization.state, {
    userId,
    verifier: authorization.verifier,
    createdAt: Date.now(),
    expires: Date.now() + OAUTH_STATE_TTL_MS,
  });

  return res.status(200).json({
    success: true,
    data: {
      authorizationUrl: authorization.url,
    },
  });
}

/* ============================================================
   DERIV OAUTH CALLBACK
============================================================ */

export async function callback(req, res) {
  const code =
    typeof req.query.code === "string"
      ? req.query.code
      : null;

  const state =
    typeof req.query.state === "string"
      ? req.query.state
      : null;

  const frontendUrl = getFrontendUrl();

  if (!code || !state) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=invalid_response`
    );
  }

  const oauthStates = getOAuthStates(req);

  cleanupExpiredStates(oauthStates);

  const savedState = oauthStates.get(state);

  /**
   * Consume the state before token exchange.
   * It cannot be reused.
   */
  oauthStates.delete(state);

  if (!savedState || savedState.expires <= Date.now()) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=state_expired`
    );
  }

  if (
    !savedState.userId ||
    !savedState.verifier
  ) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=invalid_state`
    );
  }

  let token;

  try {
    token = await derivAuthService.exchange(
      code,
      savedState.verifier
    );
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error },
      "Deriv OAuth token exchange failed"
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=authorization_failed`
    );
  }

  if (
    !token?.access_token ||
    typeof token.access_token !== "string"
  ) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=token_missing`
    );
  }

  const userId = String(savedState.userId);

  let derivAccounts;

  try {
    /**
     * Accounts are obtained directly from Deriv.
     * MongoDB is not treated as the source of account truth.
     */
    derivAccounts = await derivService.listAccounts(
      token.access_token
    );
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error, userId },
      "Failed to retrieve live Deriv accounts"
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=accounts_failed`
    );
  }

  if (
    !Array.isArray(derivAccounts) ||
    derivAccounts.length === 0
  ) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=no_accounts`
    );
  }

  const encryptedAccessToken = encrypt(
    token.access_token
  );

  const encryptedRefreshToken =
    typeof token.refresh_token === "string" &&
    token.refresh_token.trim()
      ? encrypt(token.refresh_token)
      : null;

  const expiresIn = Number(token.expires_in);

  const tokenExpiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

  const now = new Date();

  const operations = derivAccounts
    .map((derivAccount) => {
      const derivAccountId =
        derivAccount.account_id ||
        derivAccount.loginid ||
        derivAccount.login_id;

      if (!derivAccountId) {
        return null;
      }

      const accountType = normalizeAccountType(
        derivAccount.account_type ||
          derivAccount.accountType ||
          derivAccount.type
      );

      return {
        updateOne: {
          filter: {
            userId,
            derivAccountId: String(derivAccountId),
          },

          update: {
            $set: {
              userId,
              derivAccountId: String(derivAccountId),

              /**
               * Connection metadata only.
               * Balances are NEVER stored or used here.
               */
              connected: true,
              connectionStatus: "connected",

              accountType,
              currency:
                derivAccount.currency || null,

              status:
                derivAccount.status || "active",

              group:
                derivAccount.group || null,

              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,

              lastVerifiedAt: now,

              /**
               * Preserve the original connection time when possible.
               */
              connectedAt: now,
            },

            $setOnInsert: {
              selected: false,
            },
          },

          upsert: true,
        },
      };
    })
    .filter(Boolean);

  if (operations.length === 0) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=no_valid_accounts`
    );
  }

  try {
    await DerivAccount.bulkWrite(operations, {
      ordered: false,
    });
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error, userId },
      "Failed to save Deriv connection metadata"
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=save_failed`
    );
  }

  return res.redirect(
    `${frontendUrl}/accounts?deriv=connected`
  );
}

/* ============================================================
   GET CONNECTED DERIV ACCOUNTS
============================================================ */

/**
 * Returns connection metadata.
 *
 * For production, you can optionally verify accounts against Deriv
 * here. Credentials and balances are never returned.
 */
export async function accounts(req, res) {
  const userId = getUserId(req);

  const data = await DerivAccount.find({
    userId,
    connected: true,
  })
    .select(
      "-encryptedAccessToken -encryptedRefreshToken -tokenExpiresAt"
    )
    .sort({
      selected: -1,
      accountType: 1,
      derivAccountId: 1,
    })
    .lean();

  return res.status(200).json({
    success: true,
    data,
  });
}

/* ============================================================
   SELECT REAL DERIV ACCOUNT
============================================================ */

export async function select(req, res) {
  const userId = getUserId(req);

  const derivAccountId =
    req.body?.derivAccountId ||
    req.body?.accountId;

  if (
    typeof derivAccountId !== "string" ||
    !derivAccountId.trim()
  ) {
    throw new AppError(
      "Deriv account ID is required",
      400,
      "ACCOUNT_ID_REQUIRED"
    );
  }

  const account = await DerivAccount.findOne({
    userId,
    derivAccountId: derivAccountId.trim(),
    connected: true,
  }).select("+encryptedAccessToken");

  if (!account) {
    throw new AppError(
      "Connected Deriv account not found",
      404,
      "ACCOUNT_NOT_FOUND"
    );
  }

  if (
    normalizeAccountType(account.accountType) !==
    "real"
  ) {
    throw new AppError(
      "Only a real Deriv account can be selected for real-money auto-trading",
      400,
      "NOT_REAL_ACCOUNT"
    );
  }

  /**
   * Verify the account against Deriv before selecting it.
   *
   * This prevents selecting an account solely based on stale MongoDB
   * metadata.
   */
  const accessToken = getAccessToken(account);

  let liveAccounts;

  try {
    liveAccounts = await derivService.listAccounts(
      accessToken
    );
  } catch {
    throw new AppError(
      "Unable to verify the selected account with Deriv. Please reconnect your account.",
      502,
      "DERIV_ACCOUNT_VERIFICATION_FAILED"
    );
  }

  const liveAccount = Array.isArray(liveAccounts)
    ? liveAccounts.find((item) => {
        const id =
          item.account_id ||
          item.loginid ||
          item.login_id;

        return String(id || "") ===
          String(account.derivAccountId);
      })
    : null;

  if (!liveAccount) {
    throw new AppError(
      "The selected account is no longer available on Deriv",
      404,
      "DERIV_ACCOUNT_NOT_AVAILABLE"
    );
  }

  const liveType = normalizeAccountType(
    liveAccount.account_type ||
      liveAccount.accountType ||
      liveAccount.type
  );

  if (liveType !== "real") {
    throw new AppError(
      "Deriv did not verify this account as a real account",
      403,
      "DERIV_REAL_ACCOUNT_REQUIRED"
    );
  }

  /**
   * Only one selected account per user.
   */
  await DerivAccount.updateMany(
    {
      userId,
      selected: true,
      _id: { $ne: account._id },
    },
    {
      $set: {
        selected: false,
      },
    }
  );

  /**
   * Update only connection metadata from the live Deriv response.
   * Do NOT store or copy any balance.
   */
  account.selected = true;
  account.connected = true;
  account.connectionStatus = "connected";
  account.accountType = "real";
  account.currency =
    liveAccount.currency ||
    account.currency ||
    null;
  account.lastVerifiedAt = new Date();

  await account.save();

  return res.status(200).json({
    success: true,
    message:
      "Deriv real account selected and verified successfully",
    data: sanitizeAccount(account),
  });
}

/* ============================================================
   GET SELECTED CONNECTION STATUS
============================================================ */

export async function connection(req, res) {
  const userId = getUserId(req);

  const account = await DerivAccount.findOne({
    userId,
    selected: true,
    connected: true,
  })
    .select(
      "-encryptedAccessToken -encryptedRefreshToken -tokenExpiresAt"
    )
    .lean();

  return res.status(200).json({
    success: true,
    data: account
      ? sanitizeAccount(account)
      : null,
  });
}