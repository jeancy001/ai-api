import { derivConnectionManager } from "./DerivConnectionManager.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";

/**
 * DerivBalanceService
 *
 * LIVE BALANCE SOURCE OF TRUTH:
 * Deriv is the only source of truth for the current account balance.
 *
 * MongoDB may store the last balance observed from Deriv for diagnostics,
 * but MongoDB is NEVER read by get() and is NEVER used as a fallback for
 * live balance requests or real-money trading decisions.
 */
export class DerivBalanceService {
  constructor() {
    /**
     * Balance events received from the persistent Deriv connection are
     * persisted only as informational/operational history.
     */
    derivConnectionManager.on(
      "balance",
      (accountId, balance) => {
        this.persist(accountId, balance).catch((error) => {
          console.error(
            "Failed to persist observed Deriv balance:",
            error?.message || error
          );
        });
      }
    );
  }

  /**
   * Normalize an account ID safely.
   */
  normalizeAccountId(accountId) {
    return String(accountId || "").trim();
  }

  /**
   * Extract the balance payload from the actual Deriv/connection-manager
   * response without inventing or estimating any values.
   */
  extractBalancePayload(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    // Standard Deriv WebSocket response:
    // { balance: { balance, currency, loginid, ... } }
    if (
      message.balance &&
      typeof message.balance === "object" &&
      !Array.isArray(message.balance)
    ) {
      return message.balance;
    }

    // Some wrappers return:
    // { data: { balance: { ... } } }
    if (
      message.data &&
      typeof message.data === "object" &&
      !Array.isArray(message.data)
    ) {
      const data = message.data;

      if (
        data.balance &&
        typeof data.balance === "object" &&
        !Array.isArray(data.balance)
      ) {
        return data.balance;
      }
    }

    return null;
  }

  /**
   * Get the CURRENT LIVE balance directly from Deriv.
   *
   * This method:
   * 1. Validates the selected account and credentials provided by the caller.
   * 2. Sends a balance request directly to Deriv.
   * 3. Validates the account identity returned by Deriv when available.
   * 4. Returns only data obtained from the live Deriv response.
   *
   * MongoDB is NOT queried for the balance.
   *
   * @param {string} accountId
   * @param {string} accessToken
   * @param {{ subscribe?: boolean }} options
   * @returns {Promise<object>}
   */
  async get(
    accountId,
    accessToken,
    { subscribe = false } = {}
  ) {
    const normalizedAccountId =
      this.normalizeAccountId(accountId);

    const normalizedAccessToken =
      typeof accessToken === "string"
        ? accessToken.trim()
        : "";

    if (!normalizedAccountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "DERIV_ACCOUNT_ID_REQUIRED"
      );
    }

    if (!normalizedAccessToken) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_ACCESS_TOKEN_REQUIRED"
      );
    }

    const payload = {
      balance: 1,
    };

    if (subscribe === true) {
      payload.subscribe = 1;
    }

    let message;

    try {
      /**
       * This must send the request through an authenticated Deriv
       * connection associated with this exact account/token.
       */
      message = await derivConnectionManager.request(
        normalizedAccountId,
        normalizedAccessToken,
        payload
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        error?.message ||
          "Unable to retrieve the live balance from Deriv",
        502,
        "DERIV_LIVE_BALANCE_REQUEST_FAILED"
      );
    }

    const liveBalance =
      this.extractBalancePayload(message);

    if (!liveBalance) {
      throw new AppError(
        "Deriv did not return live account balance data",
        502,
        "DERIV_LIVE_BALANCE_RESPONSE_INVALID"
      );
    }

    /**
     * Do not use `|| 0` here.
     *
     * A missing balance and an actual balance of zero are completely
     * different situations.
     */
    const rawBalance = liveBalance.balance;

    if (
      rawBalance === null ||
      rawBalance === undefined ||
      rawBalance === ""
    ) {
      throw new AppError(
        "Deriv did not return a balance value",
        502,
        "DERIV_LIVE_BALANCE_MISSING"
      );
    }

    const numericBalance = Number(rawBalance);

    if (!Number.isFinite(numericBalance)) {
      throw new AppError(
        "Deriv returned an invalid live account balance",
        502,
        "DERIV_LIVE_BALANCE_INVALID"
      );
    }

    /**
     * Deriv commonly identifies the account as `loginid`.
     * Validate it whenever it is present.
     */
    const responseAccountId =
      liveBalance.loginid ||
      liveBalance.account_id ||
      liveBalance.accountId ||
      liveBalance.login_id ||
      null;

    if (
      responseAccountId &&
      String(responseAccountId).trim() !==
        normalizedAccountId
    ) {
      throw new AppError(
        "Deriv returned balance data for a different account",
        403,
        "DERIV_BALANCE_ACCOUNT_MISMATCH"
      );
    }

    /**
     * This object is built exclusively from the live Deriv response.
     */
    const result = {
      balance: numericBalance,

      currency:
        typeof liveBalance.currency === "string" &&
        liveBalance.currency.trim()
          ? liveBalance.currency.trim().toUpperCase()
          : null,

      accountId: String(
        responseAccountId || normalizedAccountId
      ),

      derivAccountId: String(
        responseAccountId || normalizedAccountId
      ),

      source: "deriv_live",

      updatedAt: new Date().toISOString(),
    };

    /**
     * Optional best-effort persistence.
     *
     * This is deliberately asynchronous and cannot affect the live
     * response returned to the caller.
     */
    this.persist(
      normalizedAccountId,
      result
    ).catch((error) => {
      console.error(
        "Failed to persist observed live Deriv balance:",
        error?.message || error
      );
    });

    return result;
  }

  /**
   * Persist a balance that was already received from Deriv.
   *
   * This is NOT part of the live balance source-of-truth path.
   */
  async persist(accountId, balance) {
    const normalizedAccountId =
      this.normalizeAccountId(accountId);

    if (!normalizedAccountId || !balance) {
      return null;
    }

    const rawBalance = balance.balance;

    if (
      rawBalance === null ||
      rawBalance === undefined ||
      rawBalance === ""
    ) {
      return null;
    }

    const numericBalance = Number(rawBalance);

    if (!Number.isFinite(numericBalance)) {
      console.warn(
        "Ignoring invalid observed Deriv balance value"
      );

      return null;
    }

    const update = {
      lastKnownBalance: numericBalance,
      lastBalanceUpdatedAt: new Date(),
      connectionStatus: "connected",
    };

    if (
      typeof balance.currency === "string" &&
      balance.currency.trim()
    ) {
      update.currency =
        balance.currency.trim().toUpperCase();
    }

    /**
     * Never create an account document from a balance response.
     */
    return DerivAccount.updateOne(
      {
        derivAccountId: normalizedAccountId,
        connected: true,
      },
      {
        $set: update,
      }
    );
  }

  /**
   * Diagnostic/history method only.
   *
   * NEVER use this as a fallback for get() or for approving a live trade.
   */
  async getLastKnown(accountId) {
    const normalizedAccountId =
      this.normalizeAccountId(accountId);

    if (!normalizedAccountId) {
      return null;
    }

    return DerivAccount.findOne({
      derivAccountId: normalizedAccountId,
      connected: true,
    })
      .select(
        "derivAccountId lastKnownBalance lastBalanceUpdatedAt currency"
      )
      .lean();
  }
}

export const derivBalanceService =
  new DerivBalanceService();