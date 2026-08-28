import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";

/**
 * TradeMonitoringService
 *
 * Responsible for monitoring Deriv contracts after execution and
 * synchronizing their lifecycle with the application's Trade records.
 *
 * IMPORTANT:
 * This service does NOT:
 * - authorize trades
 * - execute trades
 * - start or stop the trading engine
 * - activate Emergency Stop
 *
 * A monitoring failure is NOT automatically an emergency. Callers may
 * log the failure and retry according to their own retry policy.
 */
export class TradeMonitoringService {
  /**
   * Get the latest state of a contract from Deriv.
   *
   * `subscribe` is disabled because this is a one-time status request.
   * Long-lived subscriptions must be managed explicitly elsewhere.
   */
  async getContract(accountId, token, contractId) {
    if (!accountId) {
      throw new Error("accountId is required");
    }

    if (!token) {
      throw new Error("Deriv token is required");
    }

    const normalizedContractId = Number(contractId);

    if (
      !Number.isFinite(normalizedContractId) ||
      normalizedContractId <= 0
    ) {
      throw new Error("A valid contractId is required");
    }

    const msg = await derivConnectionManager.request(
      accountId,
      token,
      {
        proposal_open_contract: 1,
        contract_id: normalizedContractId,
        subscribe: 0,
      }
    );

    if (!msg?.proposal_open_contract) {
      throw new Error(
        "Deriv did not return contract information"
      );
    }

    return msg.proposal_open_contract;
  }

  /**
   * Backward-compatible monitor method.
   *
   * A monitoring request is a normal status check and never changes
   * trading settings or Emergency Stop state.
   */
  async monitor(accountId, token, contractId) {
    return this.getContract(
      accountId,
      token,
      contractId
    );
  }

  /**
   * Apply the latest Deriv contract state to the local Trade record.
   *
   * This method is idempotent and never creates additional Trade records.
   * Applying the same update multiple times is safe.
   *
   * A synchronization failure must NOT activate Emergency Stop.
   */
  async apply(contract) {
    if (
      !contract ||
      typeof contract !== "object" ||
      !contract.contract_id
    ) {
      return {
        updated: false,
        closed: false,
        emergencyStopRequested: false,
        reason: "INVALID_CONTRACT",
      };
    }

    const derivContractId = String(
      contract.contract_id
    );

    const trade = await Trade.findOne({
      derivContractId,
    });

    if (!trade) {
      return {
        updated: false,
        closed: false,
        emergencyStopRequested: false,
        reason: "TRADE_NOT_FOUND",
        derivContractId,
      };
    }

    /**
     * Never reopen a locally closed trade because an old or out-of-order
     * Deriv response arrived after the final contract update.
     */
    if (trade.status === "closed") {
      return {
        updated: false,
        closed: true,
        emergencyStopRequested: false,
        reason: "TRADE_ALREADY_CLOSED",
        derivContractId,
      };
    }

    const update = {};

    /**
     * Preserve Deriv's contract status when available.
     */
    if (
      contract.status !== undefined &&
      contract.status !== null &&
      String(contract.status).trim()
    ) {
      update.derivStatus = String(
        contract.status
      ).trim();
    }

    /**
     * Update the current spot without requiring it to be positive.
     * Some financial instruments can theoretically have values where
     * positivity should not be assumed by this monitoring layer.
     */
    if (
      contract.current_spot !== undefined &&
      contract.current_spot !== null
    ) {
      const currentPrice = Number(
        contract.current_spot
      );

      if (Number.isFinite(currentPrice)) {
        update.currentPrice = currentPrice;
      }
    }

    /**
     * Deriv considers the contract finished when it has been sold or
     * expired. Normalize both boolean and numeric representations.
     */
    const isClosed =
      contract.is_sold === 1 ||
      contract.is_sold === true ||
      contract.is_expired === 1 ||
      contract.is_expired === true;

    if (isClosed) {
      update.status = "closed";

      /**
       * Profit can be negative, zero, or positive.
       */
      const profit = Number(contract.profit);

      if (Number.isFinite(profit)) {
        update.profitLoss = profit;
      }

      /**
       * Store the final payout when supplied by Deriv.
       */
      if (
        contract.payout !== undefined &&
        contract.payout !== null
      ) {
        const payout = Number(contract.payout);

        if (Number.isFinite(payout)) {
          update.payout = payout;
        }
      }

      /**
       * Prefer Deriv's final sell time, then expiry time. Fall back to
       * the backend confirmation time only when Deriv provides neither.
       */
      const exitEpoch =
        contract.sell_time ??
        contract.date_expiry;

      if (
        exitEpoch !== undefined &&
        exitEpoch !== null &&
        Number.isFinite(Number(exitEpoch)) &&
        Number(exitEpoch) > 0
      ) {
        update.closedAt = new Date(
          Number(exitEpoch) * 1000
        );
      } else {
        update.closedAt = new Date();
      }
    } else if (trade.status === "pending") {
      /**
       * The contract is confirmed by Deriv and remains open.
       */
      update.status = "open";
    }

    if (Object.keys(update).length === 0) {
      return {
        updated: false,
        closed: false,
        emergencyStopRequested: false,
        reason: "NO_CHANGES",
        derivContractId,
      };
    }

    /**
     * The status condition prevents a race where another process closes
     * the trade between findOne() and updateOne().
     */
    const writeResult = await Trade.updateOne(
      {
        _id: trade._id,
        status: { $ne: "closed" },
      },
      {
        $set: update,
      }
    );

    if (writeResult.matchedCount === 0) {
      return {
        updated: false,
        closed: isClosed,
        emergencyStopRequested: false,
        reason: "TRADE_CLOSED_DURING_UPDATE",
        derivContractId,
      };
    }

    return {
      updated:
        writeResult.modifiedCount > 0,
      closed: isClosed,
      emergencyStopRequested: false,
      derivContractId,
      update,
    };
  }

  /**
   * Fetch the latest contract state and synchronize it locally.
   *
   * Errors are deliberately propagated to the caller so they can be
   * logged and retried. This service does not convert a temporary Deriv
   * connection problem into an Emergency Stop.
   */
  async refresh(accountId, token, contractId) {
    const contract = await this.getContract(
      accountId,
      token,
      contractId
    );

    const result = await this.apply(contract);

    return {
      contract,
      ...result,

      /**
       * Monitoring never requests an emergency state.
       */
      emergencyStopRequested: false,
    };
  }
}

export const tradeMonitoringService =
  new TradeMonitoringService();