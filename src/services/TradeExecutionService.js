import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**
 * TradeExecutionService
 *
 * Responsible only for:
 * - Requesting a validated Deriv proposal
 * - Purchasing an approved proposal
 * - Persisting the resulting trade
 *
 * IMPORTANT:
 * This service does NOT decide whether a trade should happen.
 * Authorization, strategy validation, and risk management must be
 * completed before calling these methods.
 */
export class TradeExecutionService {
  /**
   * Request a proposal from Deriv.
   *
   * Contract parameters must already have been validated by the
   * calling service. This service intentionally does not ask AI
   * to generate or modify contract parameters.
   */
  async proposal(accountId, token, params) {
    if (!accountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "ACCOUNT_ID_REQUIRED"
      );
    }

    if (!token) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_TOKEN_REQUIRED"
      );
    }

    if (!params || typeof params !== "object") {
      throw new AppError(
        "Validated contract parameters are required",
        400,
        "CONTRACT_PARAMETERS_REQUIRED"
      );
    }

    const msg = await derivConnectionManager.request(
      accountId,
      token,
      {
        proposal: 1,
        ...params,
      }
    );

    if (!msg?.proposal) {
      throw new AppError(
        "Deriv did not return a trading proposal",
        502,
        "DERIV_PROPOSAL_MISSING"
      );
    }

    const proposal = msg.proposal;

    if (!proposal.id) {
      throw new AppError(
        "Deriv proposal does not contain an ID",
        502,
        "DERIV_PROPOSAL_INVALID"
      );
    }

    const askPrice = Number(proposal.ask_price);

    if (
      !Number.isFinite(askPrice) ||
      askPrice <= 0
    ) {
      throw new AppError(
        "Deriv proposal contains an invalid price",
        502,
        "DERIV_PROPOSAL_INVALID_PRICE"
      );
    }

    return proposal;
  }

  /**
   * Purchase an existing Deriv proposal.
   *
   * `price` is the maximum amount the backend is willing to pay.
   * It should normally come from the validated proposal, not from
   * uncontrolled frontend or AI input.
   */
  async buy({
    accountId,
    token,
    proposalId,
    price,
  }) {
    if (!accountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "ACCOUNT_ID_REQUIRED"
      );
    }

    if (!token) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_TOKEN_REQUIRED"
      );
    }

    if (!proposalId) {
      throw new AppError(
        "Deriv proposal ID is required",
        400,
        "PROPOSAL_ID_REQUIRED"
      );
    }

    const maximumPrice = Number(price);

    if (
      !Number.isFinite(maximumPrice) ||
      maximumPrice <= 0
    ) {
      throw new AppError(
        "A valid maximum purchase price is required",
        400,
        "INVALID_PURCHASE_PRICE"
      );
    }

    const msg = await derivConnectionManager.request(
      accountId,
      token,
      {
        buy: proposalId,
        price: maximumPrice,
      }
    );

    if (!msg?.buy) {
      throw new AppError(
        "Deriv did not confirm the contract purchase",
        502,
        "DERIV_PURCHASE_MISSING"
      );
    }

    const purchase = msg.buy;

    if (!purchase.contract_id) {
      throw new AppError(
        "Deriv purchase does not contain a contract ID",
        502,
        "DERIV_PURCHASE_INVALID"
      );
    }

    return purchase;
  }

  /**
   * Persist a purchased trade.
   *
   * A contract ID is unique at the broker level, so avoid creating
   * duplicate local records when a retry occurs after a network error.
   */
  async record(input) {
    if (!input || typeof input !== "object") {
      throw new AppError(
        "Trade data is required",
        400,
        "TRADE_DATA_REQUIRED"
      );
    }

    if (!input.userId) {
      throw new AppError(
        "Trade user ID is required",
        400,
        "TRADE_USER_REQUIRED"
      );
    }

    if (!input.derivAccountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "TRADE_ACCOUNT_REQUIRED"
      );
    }

    if (!input.derivContractId) {
      throw new AppError(
        "Deriv contract ID is required",
        400,
        "TRADE_CONTRACT_REQUIRED"
      );
    }

    const derivContractId = String(
      input.derivContractId
    );

    /**
     * Idempotent recording prevents duplicate Trade documents when
     * the application retries after a timeout.
     */
    const existing = await Trade.findOne({
      derivContractId,
      derivAccountId: String(input.derivAccountId),
    });

    if (existing) {
      return existing;
    }

    try {
      return await Trade.create({
        ...input,
        derivAccountId: String(input.derivAccountId),
        derivContractId,
        status: input.status || "open",
      });
    } catch (error) {
      /**
       * If a unique index exists, a concurrent request may have
       * created the record between findOne() and create().
       */
      if (error?.code === 11000) {
        const duplicate = await Trade.findOne({
          derivContractId,
          derivAccountId: String(
            input.derivAccountId
          ),
        });

        if (duplicate) {
          return duplicate;
        }
      }

      throw error;
    }
  }

  /**
   * Convenience method for recording a successful purchase.
   *
   * The caller supplies only already-validated values.
   */
  async recordPurchase({
    userId,
    accountId,
    purchase,
    proposal,
    contractParameters = {},
  }) {
    if (!purchase?.contract_id) {
      throw new AppError(
        "Cannot record a purchase without a contract ID",
        400,
        "PURCHASE_CONTRACT_REQUIRED"
      );
    }

    return this.record({
      userId,
      derivAccountId: String(accountId),
      derivContractId: String(
        purchase.contract_id
      ),
      status: "open",

      /**
       * Financial values are taken from Deriv responses where possible.
       */
      stake: Number(
        purchase.buy_price ??
          proposal?.ask_price ??
          0
      ),

      buyPrice: Number(
        purchase.buy_price ??
          proposal?.ask_price ??
          0
      ),

      currency:
        purchase.currency ||
        proposal?.currency ||
        null,

      contractType:
        contractParameters.contract_type ||
        contractParameters.contractType ||
        null,

      symbol:
        contractParameters.symbol ||
        proposal?.underlying ||
        null,

      openedAt: new Date(),
    });
  }
}

export const tradeExecutionService =
  new TradeExecutionService();