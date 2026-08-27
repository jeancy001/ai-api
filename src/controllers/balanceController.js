import { DerivAccount } from "../models/DerivAccount.js";
import { decrypt } from "../utils/crypto.js";
import { derivBalanceService } from "../services/DerivBalanceService.js";
import { AppError } from "../utils/AppError.js";
import { logActivitySafe } from "../services/ActivityService.js";

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
 * Get the selected, connected, verified real Deriv account.
 *
 * The encrypted access token is explicitly selected because it
 * should normally be excluded from API queries and responses.
 */
async function getSelectedRealAccount(userId) {
  const account = await DerivAccount.findOne({
    userId,
    selected: true,
    connected: true,
  }).select("+encryptedAccessToken");

  if (!account) {
    throw new AppError(
      "No selected and connected Deriv account was found",
      404,
      "DERIV_ACCOUNT_NOT_SELECTED"
    );
  }

  const accountType = String(
    account.accountType || ""
  )
    .trim()
    .toLowerCase();

  if (accountType !== "real") {
    throw new AppError(
      "The selected Deriv account is not a verified real account",
      403,
      "REAL_ACCOUNT_REQUIRED"
    );
  }

  if (!account.encryptedAccessToken) {
    throw new AppError(
      "The selected Deriv account does not have valid credentials. Please reconnect your account.",
      401,
      "DERIV_TOKEN_MISSING"
    );
  }

  return account;
}

/**
 * Decrypt the Deriv access token safely.
 *
 * Never return the token or include it in logs.
 */
function getAccessToken(account) {
  try {
    const token = decrypt(
      account.encryptedAccessToken
    );

    if (!token) {
      throw new Error("Empty access token");
    }

    return token;
  } catch (error) {
    throw new AppError(
      "Unable to access Deriv credentials. Please reconnect your Deriv account.",
      401,
      "DERIV_TOKEN_INVALID"
    );
  }
}

/**
 * Build a consistent balance response.
 */
function serializeBalance(account, balance, source) {
  if (!balance) {
    throw new AppError(
      "Deriv did not return account balance information",
      502,
      "DERIV_BALANCE_UNAVAILABLE"
    );
  }

  const amount = Number(balance.balance);

  if (!Number.isFinite(amount)) {
    throw new AppError(
      "Deriv returned an invalid balance",
      502,
      "DERIV_INVALID_BALANCE"
    );
  }

  return {
    balance: amount,
    currency:
      balance.currency ||
      account.currency ||
      null,

    accountId: account.derivAccountId,
    derivAccountId: account.derivAccountId,
    accountType: account.accountType,

    source,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Fetch the current balance from Deriv.
 */
async function fetchDerivBalance(userId) {
  const account =
    await getSelectedRealAccount(userId);

  const accessToken =
    getAccessToken(account);

  /**
   * For a normal HTTP request we do NOT subscribe.
   *
   * A persistent subscription is useful for a WebSocket-powered
   * dashboard or the auto-trading engine, but an HTTP GET should
   * simply fetch the current balance.
   */
  const balance =
    await derivBalanceService.get(
      account.derivAccountId,
      accessToken,
      { subscribe: false }
    );

  return {
    account,
    balance,
  };
}

/**
 * GET /account/deriv/balance
 *
 * Get the current balance. The service may also update the cached
 * balance in MongoDB as part of its normal persistence behavior.
 */
export async function getBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchDerivBalance(userId);

  return res.status(200).json({
    success: true,
    data: serializeBalance(
      account,
      balance,
      "deriv"
    ),
  });
}

/**
 * POST /account/deriv/balance/refresh
 *
 * Explicitly refresh the balance directly from Deriv.
 */
export async function refreshBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchDerivBalance(userId);

  await logActivitySafe({
    userId,
    type: "DERIV_BALANCE_REFRESHED",
    title: "Deriv balance refreshed",
    description:
      "The selected Deriv account balance was refreshed successfully.",
    metadata: {
      accountId: account.derivAccountId,
      currency:
        balance?.currency ||
        account.currency ||
        null,
    },
  });

  return res.status(200).json({
    success: true,
    message: "Balance refreshed successfully",
    data: serializeBalance(
      account,
      balance,
      "deriv"
    ),
  });
}