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
 * Get the selected, connected, verified REAL Deriv account.
 *
 * MongoDB is used only for account ownership, connection metadata,
 * and the encrypted credential. It is NOT used as the balance source.
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

  if (
    typeof account.encryptedAccessToken !== "string" ||
    account.encryptedAccessToken.trim().length === 0
  ) {
    throw new AppError(
      "The selected Deriv account does not have valid credentials. Please reconnect your account.",
      401,
      "DERIV_TOKEN_MISSING"
    );
  }

  if (!account.derivAccountId) {
    throw new AppError(
      "The selected Deriv account is missing its account ID. Please reconnect your account.",
      400,
      "DERIV_ACCOUNT_ID_MISSING"
    );
  }

  return account;
}

/**
 * Decrypt the Deriv access token safely.
 *
 * The token must never be returned to the client or written to logs.
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
      throw new Error("Empty access token");
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

/**
 * Build a response exclusively from the LIVE Deriv response.
 *
 * IMPORTANT:
 * There is intentionally no fallback to account.lastKnownBalance,
 * account.balance, or any other MongoDB balance field.
 */
function serializeLiveBalance(account, liveBalance) {
  if (
    !liveBalance ||
    typeof liveBalance !== "object"
  ) {
    throw new AppError(
      "Deriv did not return live account balance information",
      502,
      "DERIV_LIVE_BALANCE_UNAVAILABLE"
    );
  }

  const amount = Number(
    liveBalance.balance
  );

  if (!Number.isFinite(amount)) {
    throw new AppError(
      "Deriv returned an invalid live balance",
      502,
      "DERIV_LIVE_BALANCE_INVALID"
    );
  }

  /**
   * The balance service should already validate this. We verify again
   * at the controller boundary as defense in depth.
   */
  const responseAccountId =
    liveBalance.accountId ||
    liveBalance.loginid ||
    liveBalance.account_id ||
    null;

  if (
    responseAccountId &&
    String(responseAccountId) !==
      String(account.derivAccountId)
  ) {
    throw new AppError(
      "Live balance was returned for a different Deriv account",
      403,
      "DERIV_BALANCE_ACCOUNT_MISMATCH"
    );
  }

  return {
    balance: amount,

    /**
     * Prefer the currency from the live Deriv response.
     * Account metadata is only used when Deriv does not include currency.
     */
    currency:
      liveBalance.currency ||
      account.currency ||
      null,

    accountId: String(
      account.derivAccountId
    ),
    derivAccountId: String(
      account.derivAccountId
    ),
    accountType: account.accountType,

    /**
     * Explicit proof for the frontend that this is not a cached balance.
     */
    source: "deriv_live",

    updatedAt:
      liveBalance.updatedAt ||
      new Date().toISOString(),
  };
}

/**
 * Fetch the CURRENT LIVE balance from Deriv.
 *
 * Flow:
 * MongoDB -> selected account + encrypted token
 * Decrypt token
 * Deriv -> LIVE balance
 *
 * MongoDB is never queried for the balance itself.
 */
async function fetchLiveDerivBalance(userId) {
  const account =
    await getSelectedRealAccount(userId);

  const accessToken =
    getAccessToken(account);

  const balance =
    await derivBalanceService.get(
      String(account.derivAccountId),
      accessToken,
      {
        subscribe: false,
      }
    );

  return {
    account,
    balance,
  };
}

/**
 * GET /account/deriv/balance
 *
 * Always fetches the current balance directly from Deriv.
 */
export async function getBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchLiveDerivBalance(userId);

  return res.status(200).json({
    success: true,
    data: serializeLiveBalance(
      account,
      balance
    ),
  });
}

/**
 * POST /account/deriv/balance/refresh
 *
 * Explicitly requests the latest balance directly from Deriv.
 *
 * This endpoint is functionally also live; it exists separately so
 * the frontend can expose a dedicated refresh action.
 */
export async function refreshBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchLiveDerivBalance(userId);

  /**
   * Activity logging is best-effort and must never affect the live
   * balance response.
   */
  logActivitySafe({
    userId,
    type: "DERIV_BALANCE_REFRESHED",
    title: "Deriv balance refreshed",
    description:
      "The selected Deriv account balance was refreshed directly from Deriv.",
    metadata: {
      accountId: String(account.derivAccountId),
      source: "deriv_live",
      currency:
        balance?.currency ||
        account.currency ||
        null,
    },
  }).catch?.(() => {});

  return res.status(200).json({
    success: true,
    message:
      "Live balance refreshed successfully",
    data: serializeLiveBalance(
      account,
      balance
    ),
  });
}