import { derivAuthService } from "../services/DerivAuthService.js";
import { derivService } from "../services/DerivService.js";
import { encrypt } from "../utils/crypto.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Get the authenticated user ID.
 */
function getUserId(req) {
  const userId = req.user?.id || req.user?.sub;

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
 * Normalize Deriv account types for consistent comparisons.
 */
function normalizeAccountType(type) {
  return String(type || "")
    .trim()
    .toLowerCase();
}

/**
 * Get the application's in-memory OAuth state store.
 *
 * NOTE:
 * This works for a single Node.js process.
 * For multi-instance/serverless deployments, use a persistent
 * database-backed OAuth state store instead.
 */
function getOAuthStates(req) {
  if (!req.app.locals.oauthStates) {
    req.app.locals.oauthStates = new Map();
  }

  return req.app.locals.oauthStates;
}

/**
 * Remove expired OAuth states to prevent memory growth.
 */
function cleanupExpiredStates(store) {
  const now = Date.now();

  for (const [state, value] of store.entries()) {
    if (!value?.expires || value.expires <= now) {
      store.delete(state);
    }
  }
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
      "FRONTEND_NOT_CONFIGURED",
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

  return data;
}

/**
 * START DERIV OAUTH CONNECTION
 */
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
      "DERIV_AUTH_INITIALIZATION_FAILED",
    );
  }

  const oauthStates = getOAuthStates(req);

  cleanupExpiredStates(oauthStates);

  /**
   * Store only temporarily.
   * The verifier is required later for PKCE token exchange.
   */
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

/**
 * DERIV OAUTH CALLBACK
 *
 * The OAuth state is consumed exactly once.
 * Access tokens are encrypted and stored server-side only.
 */
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
      `${frontendUrl}/accounts?deriv=error&reason=invalid_response`,
    );
  }

  const oauthStates = getOAuthStates(req);

  cleanupExpiredStates(oauthStates);

  const savedState = oauthStates.get(state);

  /**
   * OAuth state must be used only once.
   * Delete it before exchanging the authorization code.
   */
  oauthStates.delete(state);

  if (!savedState || savedState.expires <= Date.now()) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=state_expired`,
    );
  }

  if (!savedState.userId || !savedState.verifier) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=invalid_state`,
    );
  }

  let token;

  try {
    token = await derivAuthService.exchange(
      code,
      savedState.verifier,
    );
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error },
      "Deriv OAuth token exchange failed",
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=authorization_failed`,
    );
  }

  if (!token?.access_token) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=token_missing`,
    );
  }

  const userId = String(savedState.userId);

  let derivAccounts;

  try {
    derivAccounts =
      await derivService.listAccounts(
        token.access_token,
      );
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error, userId },
      "Failed to retrieve Deriv accounts",
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=accounts_failed`,
    );
  }

  if (!Array.isArray(derivAccounts)) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=invalid_accounts`,
    );
  }

  const encryptedAccessToken = encrypt(
    token.access_token,
  );

  const encryptedRefreshToken =
    token.refresh_token
      ? encrypt(token.refresh_token)
      : null;

  const tokenExpiresAt = token.expires_in
    ? new Date(
        Date.now() +
          Number(token.expires_in) * 1000,
      )
    : null;

  const now = new Date();

  const operations = derivAccounts
    .map((account) => {
      const derivAccountId =
        account.account_id ||
        account.loginid ||
        account.login_id;

      if (!derivAccountId) {
        return null;
      }

      return {
        updateOne: {
          filter: {
            userId,
            derivAccountId: String(derivAccountId),
          },
          update: {
            $set: {
              connected: true,
              derivAccountId: String(derivAccountId),
              accountType: normalizeAccountType(
                account.account_type ||
                  account.accountType,
              ),
              currency: account.currency || null,
              status: account.status || "active",
              group: account.group || null,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt,
              connectionStatus: "connected",
              lastVerifiedAt: now,
              connectedAt: now,
            },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);

  if (operations.length === 0) {
    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=no_accounts`,
    );
  }

  try {
    await DerivAccount.bulkWrite(operations);
  } catch (error) {
    req.app.locals.logger?.error?.(
      { err: error, userId },
      "Failed to save Deriv accounts",
    );

    return res.redirect(
      `${frontendUrl}/accounts?deriv=error&reason=save_failed`,
    );
  }

  return res.redirect(
    `${frontendUrl}/accounts?deriv=connected`,
  );
}

/**
 * GET CONNECTED DERIV ACCOUNTS
 *
 * Sensitive encrypted credentials are never returned.
 */
export async function accounts(req, res) {
  const userId = getUserId(req);

  const data = await DerivAccount.find({
    userId,
    connected: true,
  })
    .select(
      "-encryptedAccessToken -encryptedRefreshToken",
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

/**
 * SELECT A REAL DERIV ACCOUNT
 *
 * Only REAL accounts can be selected for live auto-trading.
 */
export async function select(req, res) {
  const userId = getUserId(req);

  const derivAccountId =
    req.body?.derivAccountId ||
    req.body?.accountId;

  if (!derivAccountId) {
    throw new AppError(
      "Deriv account ID is required",
      400,
      "ACCOUNT_ID_REQUIRED",
    );
  }

  const account = await DerivAccount.findOne({
    userId,
    derivAccountId: String(derivAccountId),
    connected: true,
  });

  if (!account) {
    throw new AppError(
      "Account not found",
      404,
      "ACCOUNT_NOT_FOUND",
    );
  }

  if (
    normalizeAccountType(account.accountType) !==
    "real"
  ) {
    throw new AppError(
      "Only a real account can be selected for live trading",
      400,
      "NOT_REAL_ACCOUNT",
    );
  }

  /**
   * Clear every previous account selection for this user.
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
    },
  );

  account.selected = true;
  account.lastVerifiedAt = new Date();

  await account.save();

  return res.status(200).json({
    success: true,
    message:
      "Deriv real account selected successfully",
    data: sanitizeAccount(account),
  });
}