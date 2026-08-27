import { DerivAccount } from "../models/DerivAccount.js";
import { decrypt } from "../utils/crypto.js";
import { derivBalanceService } from "../services/DerivBalanceService.js";
import { AppError } from "../utils/AppError.js";
import { logActivitySafe } from "../services/ActivityService.js";

/* ============================================================
   AUTHENTICATED USER
============================================================ */

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

/* ============================================================
   SELECTED REAL DERIV ACCOUNT

   MongoDB is used ONLY for:
   - verifying account ownership
   - determining the selected account
   - storing encrypted credentials

   MongoDB is NEVER used as the balance source.
============================================================ */

async function getSelectedRealAccount(userId) {
  const account = await DerivAccount.findOne({
    userId,
    selected: true,
    connected: true,
  }).select("+encryptedAccessToken");

  if (!account) {
    throw new AppError(
      "No selected and connected REAL Deriv account was found",
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
      "A selected REAL Deriv account is required",
      403,
      "REAL_ACCOUNT_REQUIRED"
    );
  }

  const derivAccountId = String(
    account.derivAccountId || ""
  ).trim();

  if (!derivAccountId) {
    throw new AppError(
      "The selected Deriv account is missing its account ID. Please reconnect your account.",
      400,
      "DERIV_ACCOUNT_ID_MISSING"
    );
  }

  if (
    typeof account.encryptedAccessToken !== "string" ||
    !account.encryptedAccessToken.trim()
  ) {
    throw new AppError(
      "The selected Deriv account does not have valid credentials. Please reconnect your account.",
      401,
      "DERIV_TOKEN_MISSING"
    );
  }

  return account;
}

/* ============================================================
   DERIV ACCESS TOKEN
============================================================ */

function getAccessToken(account) {
  try {
    const token = decrypt(
      account.encryptedAccessToken
    );

    if (
      typeof token !== "string" ||
      !token.trim()
    ) {
      throw new Error("Invalid access token");
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
   SERIALIZE VERIFIED LIVE DERIV BALANCE

   IMPORTANT:
   - Zero is valid ONLY if Deriv explicitly returns zero.
   - Missing balance is an error.
   - No MongoDB balance field is ever read here.
============================================================ */

function serializeLiveBalance(account, liveBalance) {
  if (
    !liveBalance ||
    typeof liveBalance !== "object"
  ) {
    throw new AppError(
      "Deriv did not return live balance information",
      502,
      "DERIV_LIVE_BALANCE_UNAVAILABLE"
    );
  }

  const rawBalance = liveBalance.balance;

  /*
   * Do NOT do:
   *
   * Number(rawBalance || 0)
   *
   * because a missing balance would incorrectly become $0.00.
   */
  if (
    rawBalance === undefined ||
    rawBalance === null ||
    rawBalance === ""
  ) {
    throw new AppError(
      "Deriv did not return a balance for the selected account",
      502,
      "DERIV_LIVE_BALANCE_MISSING"
    );
  }

  const amount = Number(rawBalance);

  if (!Number.isFinite(amount)) {
    throw new AppError(
      "Deriv returned an invalid live balance",
      502,
      "DERIV_LIVE_BALANCE_INVALID"
    );
  }

  /*
   * Deriv's Balance API identifies the authorized account with
   * loginid. Our service may normalize it as accountId.
   */
  const responseAccountId =
    liveBalance.accountId ??
    liveBalance.loginid ??
    liveBalance.loginId ??
    liveBalance.account_id ??
    null;

  /*
   * Security check: never display a balance belonging to another
   * Deriv account.
   */
  if (
    responseAccountId !== null &&
    String(responseAccountId).trim() !==
      String(account.derivAccountId).trim()
  ) {
    throw new AppError(
      "Deriv returned balance information for a different account",
      403,
      "DERIV_BALANCE_ACCOUNT_MISMATCH"
    );
  }

  const currency =
    typeof liveBalance.currency === "string" &&
    liveBalance.currency.trim()
      ? liveBalance.currency.trim().toUpperCase()
      : typeof account.currency === "string" &&
          account.currency.trim()
        ? account.currency.trim().toUpperCase()
        : null;

  return {
    /*
     * This amount comes directly from Deriv.
     */
    balance: amount,

    currency,

    /*
     * Explicitly return the verified account.
     */
    accountId: String(account.derivAccountId),
    derivAccountId: String(account.derivAccountId),

    /*
     * This controller only permits real accounts.
     */
    accountType: "real",

    /*
     * Allows the frontend to clearly identify the source.
     */
    source: "deriv_live",

    updatedAt:
      typeof liveBalance.updatedAt === "string"
        ? liveBalance.updatedAt
        : new Date().toISOString(),
  };
}

/* ============================================================
   FETCH CURRENT LIVE BALANCE FROM DERIV

   Flow:

   MongoDB
      ↓
   selected REAL account + encrypted token
      ↓
   decrypt token server-side
      ↓
   Deriv Balance API / authenticated WebSocket
      ↓
   verified live balance

   MongoDB balance fields are NEVER read.
============================================================ */

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

  if (!balance) {
    throw new AppError(
      "Deriv did not return the current account balance",
      502,
      "DERIV_LIVE_BALANCE_UNAVAILABLE"
    );
  }

  return {
    account,
    balance,
  };
}

/* ============================================================
   GET CURRENT LIVE BALANCE

   GET /api/v1/account/deriv/balance
============================================================ */

export async function getBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchLiveDerivBalance(userId);

  const data = serializeLiveBalance(
    account,
    balance
  );

  return res.status(200).json({
    success: true,
    data,
  });
}

/* ============================================================
   REFRESH CURRENT LIVE BALANCE

   POST /api/v1/account/deriv/balance/refresh
============================================================ */

export async function refreshBalance(req, res) {
  const userId = getUserId(req);

  const { account, balance } =
    await fetchLiveDerivBalance(userId);

  const data = serializeLiveBalance(
    account,
    balance
  );

  /*
   * Best-effort activity logging.
   * It must never block or modify the Deriv balance response.
   */
  Promise.resolve(
    logActivitySafe({
      userId,
      type: "DERIV_BALANCE_REFRESHED",
      title: "Live Deriv balance refreshed",
      description:
        "The current balance was retrieved directly from the selected REAL Deriv account.",
      metadata: {
        derivAccountId: String(
          account.derivAccountId
        ),
        accountType: "real",
        currency: data.currency,
        source: "deriv_live",
      },
    })
  ).catch(() => {});

  return res.status(200).json({
    success: true,
    message:
      "Live Deriv balance retrieved successfully",
    data,
  });
}