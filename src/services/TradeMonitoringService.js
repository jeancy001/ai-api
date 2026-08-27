import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";

/**
 * TradeMonitoringService
 *
 * Responsible for monitoring contracts after execution and synchronizing
 * their lifecycle with the application's Trade records.
 *
 * This service does NOT authorize or execute trades.
 */
export class TradeMonitoringService {
  /**
   * Get the latest state of a contract.
   *
   * `subscribe` is disabled by default because a one-time status check
   * should not create an unmanaged long-lived subscription.
   */
  async getContract(
    accountId,
    token,
    contractId
  ) {
    if (!accountId) {
      throw new Error("accountId is required");
    }

    if (!contractId) {
      throw new Error("contractId is required");
    }

    const msg = await derivConnectionManager.request(
      accountId,
      token,
      {
        proposal_open_contract: 1,
        contract_id: Number(contractId),
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
   * A single request is safer than silently creating a subscription.
   */
  async monitor(
    accountId,
    token,
    contractId
  ) {
    return this.getContract(
      accountId,
      token,
      contractId
    );
  }

  /**
   * Apply the latest Deriv contract state to the local Trade record.
   *
   * This method is idempotent: applying the same contract update more
   * than once should not create additional trades or corrupt history.
   */
  async apply(contract) {
    if (
      !contract ||
      !contract.contract_id
    ) {
      return {
        updated: false,
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
        reason: "TRADE_NOT_FOUND",
        derivContractId,
      };
    }

    /**
     * Never reopen a locally closed trade because of an old
     * out-of-order WebSocket message.
     */
    if (trade.status === "closed") {
      return {
        updated: false,
        reason: "TRADE_ALREADY_CLOSED",
        derivContractId,
      };
    }

    const update = {};

    /**
     * Deriv may provide the current contract status in different fields
     * depending on the contract response. Preserve only meaningful values.
     */
    if (contract.status) {
      update.derivStatus = String(contract.status);
    }

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
     * Contract is finished/sold.
     */
    const isClosed =
      contract.is_sold === 1 ||
      contract.is_sold === true ||
      contract.is_expired === 1 ||
      contract.is_expired === true;

    if (isClosed) {
      update.status = "closed";

      const profit = Number(contract.profit);

      if (Number.isFinite(profit)) {
        update.profitLoss = profit;
      }

      /**
       * Use Deriv's sell time when available; otherwise use the time
       * the backend confirmed the closed state.
       */
      const exitEpoch =
        contract.sell_time ||
        contract.date_expiry;

      if (
        exitEpoch !== undefined &&
        Number.isFinite(Number(exitEpoch)) &&
        Number(exitEpoch) > 0
      ) {
        update.closedAt = new Date(
          Number(exitEpoch) * 1000
        );
      } else {
        update.closedAt = new Date();
      }

      /**
       * Store the final payout when available.
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
    } else if (
      trade.status === "pending"
    ) {
      /**
       * A contract exists and is being monitored.
       */
      update.status = "open";
    }

    if (Object.keys(update).length === 0) {
      return {
        updated: false,
        reason: "NO_CHANGES",
        derivContractId,
      };
    }

    await Trade.updateOne(
      {
        _id: trade._id,
        status: { $ne: "closed" },
      },
      {
        $set: update,
      }
    );

    return {
      updated: true,
      closed: isClosed,
      derivContractId,
      update,
    };
  }

  /**
   * Fetch the latest contract state and synchronize it locally.
   */
  async refresh(
    accountId,
    token,
    contractId
  ) {
    const contract = await this.getContract(
      accountId,
      token,
      contractId
    );

    const result = await this.apply(contract);

    return {
      contract,
      ...result,
    };
  }
}

export const tradeMonitoringService =
  new TradeMonitoringService();