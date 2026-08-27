import { derivConnectionManager } from "./DerivConnectionManager.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";

/**
 * DerivBalanceService
 *
 * SOURCE OF TRUTH:
 * - Deriv is always the source of truth for account balances.
 *
 * Responsibilities:
 * - Retrieve the current balance directly from Deriv.
 * - Optionally subscribe to live balance updates.
 * - Optionally persist the latest observed balance for informational
 *   and operational purposes only.
 *
 * IMPORTANT:
 * MongoDB is NEVER used as a fallback for a live balance request.
 * If Deriv cannot provide a live balance, this service throws an error.
 */
export class DerivBalanceService {
  constructor() {
    /**
     * Persist balance updates received through the persistent Deriv
     * WebSocket connection.
     *
     * Persistence is best-effort only. A MongoDB failure must not change
     * the fact that the live balance was received from Deriv.
     */
    derivConnectionManager.on(
      "balance",
      (accountId, balance) => {
        this.persist(accountId, balance).catch((error) => {
          console.error(
            "Failed to persist Deriv balance update:",
            error?.message || error
          );
        });
      }
    );
  }

  /**
   * Get the CURRENT LIVE balance directly from Deriv.
   *
   * This method always makes a request to Deriv. It does not read or
   * return a cached MongoDB balance.
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
      typeof accountId === "string"
        ? accountId.trim()
        : String(accountId || "").trim();

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

    /**
     * This request is sent directly to Deriv through the authenticated
     * WebSocket connection. No MongoDB balance is involved.
     */
    const payload = {
      balance: 1,
    };

    if (subscribe === true) {
      payload.subscribe = 1;
    }

    let message;

    try {
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
          "Unable to retrieve live balance from Deriv",
        502,
        "DERIV_LIVE_BALANCE_REQUEST_FAILED"
      );
    }

    /**
     * Deriv's response should contain:
     *
     * {
     *   balance: {
     *     balance: "...",
     *     currency: "...",
     *     loginid: "..."
     *   }
     * }
     *
     * Check explicitly for null/undefined so a valid zero balance
     * is not treated as an invalid response.
     */
    const liveBalance = message?.balance;

    if (
      liveBalance === null ||
      liveBalance === undefined ||
      typeof liveBalance !== "object"
    ) {
      throw new AppError(
        "Deriv did not return live account balance data",
        502,
        "DERIV_LIVE_BALANCE_RESPONSE_INVALID"
      );
    }

    const numericBalance = Number(
      liveBalance.balance
    );

    if (!Number.isFinite(numericBalance)) {
      throw new AppError(
        "Deriv returned an invalid live account balance",
        502,
        "DERIV_LIVE_BALANCE_INVALID"
      );
    }

    /**
     * Security check: when Deriv identifies the account in its response,
     * make sure the response belongs to the account we requested.
     */
    const responseAccountId =
      liveBalance.loginid ||
      liveBalance.account_id ||
      liveBalance.accountId ||
      null;

    if (
      responseAccountId &&
      String(responseAccountId) !==
        normalizedAccountId
    ) {
      throw new AppError(
        "Deriv returned balance data for a different account",
        403,
        "DERIV_BALANCE_ACCOUNT_MISMATCH"
      );
    }

    const result = {
      ...liveBalance,

      /**
       * Normalize the amount to a number for the API/frontend.
       */
      balance: numericBalance,

      currency:
        liveBalance.currency || null,

      accountId:
        String(
          responseAccountId ||
          normalizedAccountId
        ),

      /**
       * Explicitly identify where this balance came from.
       */
      source: "deriv_live",

      updatedAt: new Date().toISOString(),
    };

    /**
     * Best-effort persistence.
     *
     * We intentionally do not await persistence before returning the
     * live balance. MongoDB is not part of the source-of-truth path.
     */
    this.persist(
      normalizedAccountId,
      result
    ).catch((error) => {
      console.error(
        "Failed to persist live Deriv balance:",
        error?.message || error
      );
    });

    return result;
  }

  /**
   * Persist an observed balance from Deriv.
   *
   * IMPORTANT:
   * This data is informational only and must never be used as a fallback
   * for get(). A failure here does not affect live trading data.
   */
  async persist(accountId, balance) {
    const normalizedAccountId =
      String(accountId || "").trim();

    if (
      !normalizedAccountId ||
      !balance
    ) {
      return null;
    }

    const numericBalance = Number(
      balance.balance
    );

    if (!Number.isFinite(numericBalance)) {
      console.warn(
        "Ignoring invalid Deriv balance value:",
        balance.balance
      );

      return null;
    }

    const update = {
      lastKnownBalance: numericBalance,
      lastBalanceUpdatedAt: new Date(),
      connectionStatus: "connected",
    };

    if (balance.currency) {
      update.currency = String(
        balance.currency
      );
    }

    /**
     * Never upsert from a balance event.
     *
     * The account must already have been verified and connected through
     * the OAuth/account connection flow.
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
   * Optional diagnostic/history method.
   *
   * This method is deliberately NOT used by get() and must not be used
   * by real-money trade approval or as a live balance fallback.
   */
  async getLastKnown(accountId) {
    const normalizedAccountId =
      String(accountId || "").trim();

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