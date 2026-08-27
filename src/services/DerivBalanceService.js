import { derivConnectionManager } from "./DerivConnectionManager.js";
import { DerivAccount } from "../models/DerivAccount.js";
import { AppError } from "../utils/AppError.js";

/**
 * DerivBalanceService
 *
 * Responsibilities:
 * - Retrieve the current account balance from Deriv.
 * - Optionally subscribe to balance updates.
 * - Persist the latest known balance in MongoDB.
 *
 * IMPORTANT:
 * The cached balance is informational. The trading engine should always
 * obtain a fresh balance before authorizing a real-money trade when
 * risk decisions depend on the current available funds.
 */
export class DerivBalanceService {
  constructor() {
    /**
     * Persist balance updates received through the persistent
     * Deriv WebSocket connection.
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
   * Get the latest balance for a Deriv account.
   *
   * @param {string} accountId
   * @param {string} accessToken
   * @param {{ subscribe?: boolean }} options
   */
  async get(
    accountId,
    accessToken,
    { subscribe = false } = {}
  ) {
    if (!accountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "DERIV_ACCOUNT_ID_REQUIRED"
      );
    }

    if (!accessToken) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_ACCESS_TOKEN_REQUIRED"
      );
    }

    const payload = {
      balance: 1,
    };

    /**
     * Only include subscribe when explicitly requested.
     * This avoids sending undefined values to Deriv.
     */
    if (subscribe) {
      payload.subscribe = 1;
    }

    let message;

    try {
      message =
        await derivConnectionManager.request(
          String(accountId),
          accessToken,
          payload
        );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        error?.message ||
          "Unable to retrieve Deriv account balance",
        502,
        "DERIV_BALANCE_REQUEST_FAILED"
      );
    }

    const balance = message?.balance;

    if (!balance) {
      throw new AppError(
        "Deriv did not return account balance data",
        502,
        "DERIV_BALANCE_RESPONSE_INVALID"
      );
    }

    const numericBalance = Number(balance.balance);

    if (!Number.isFinite(numericBalance)) {
      throw new AppError(
        "Deriv returned an invalid account balance",
        502,
        "DERIV_BALANCE_INVALID"
      );
    }

    /**
     * Persist asynchronously as part of the successful balance refresh.
     */
    await this.persist(accountId, balance);

    return {
      ...balance,
      balance: numericBalance,
      currency: balance.currency || null,
    };
  }

  /**
   * Persist a balance update received from Deriv.
   *
   * This method intentionally does not create a new account record.
   * An account must already exist and have been connected through OAuth.
   */
  async persist(accountId, balance) {
    if (!accountId || !balance) {
      return null;
    }

    const numericBalance = Number(balance.balance);

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
      update.currency = String(balance.currency);
    }

    /**
     * Do not use upsert here.
     *
     * A balance WebSocket event must never accidentally create a
     * Deriv account record without verified OAuth account information.
     */
    const result = await DerivAccount.updateOne(
      {
        derivAccountId: String(accountId),
        connected: true,
      },
      {
        $set: update,
      }
    );

    return result;
  }

  /**
   * Return the last cached balance from MongoDB.
   *
   * Useful for dashboards and as a fallback display value.
   * This should not replace a fresh balance for critical trade approval.
   */
  async getCached(accountId) {
    if (!accountId) {
      return null;
    }

    return DerivAccount.findOne({
      derivAccountId: String(accountId),
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