import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**

* TradeExecutionService
*
* Responsible only for execution-related operations:
*
* * Requesting a validated Deriv proposal
* * Purchasing an already-approved proposal
* * Persisting successful purchases
*
* IMPORTANT SECURITY ARCHITECTURE:
*
* This service does NOT decide whether a trade should happen.
* Gemini/AI analysis, strategy validation, authorization, emergency
* stop checks, and risk management must happen BEFORE this service
* is allowed to execute a purchase.
*
* Gemini must never receive direct authority over the Deriv API.
  */
  export class TradeExecutionService {
  constructor() {
  /**

  * Prevent accidental duplicate purchase requests for the same
  * Deriv proposal inside this application instance.
  *
  * Database-level idempotency is still handled separately when
  * recording the resulting contract.
    */
    this.purchaseLocks = new Set();
    }

/* ============================================================
PROPOSAL
============================================================ */

/**

* Request a proposal from Deriv.
*
* Contract parameters must already have been generated and
* validated by trusted backend code.
*
* @param {string} accountId
* @param {string} token
* @param {object} params
  */
  async proposal(accountId, token, params) {
  const normalizedAccountId = String(
  accountId || ""
  ).trim();


if (!normalizedAccountId) {



  throw new AppError(
    "Deriv account ID is required",
    400,
    "ACCOUNT_ID_REQUIRED"
  );
}

if (
  typeof token !== "string" ||
  !token.trim()
) {
  throw new AppError(
    "Deriv access token is required",
    401,
    "DERIV_TOKEN_REQUIRED"
  );
}

if (
  !params ||
  typeof params !== "object" ||
  Array.isArray(params)
) {
  throw new AppError(
    "Validated contract parameters are required",
    400,
    "CONTRACT_PARAMETERS_REQUIRED"
  );
}

/**
 * Never allow callers to override the proposal command.
 */
const {
  proposal: _ignoredProposal,
  ...contractParameters
} = params;

const msg =
  await derivConnectionManager.request(
    normalizedAccountId,
    token,
    {
      proposal: 1,
      ...contractParameters,
    }
  );

if (msg?.error) {
  throw new AppError(
    msg.error.message ||
      "Deriv rejected the trading proposal",
    502,
    msg.error.code || "DERIV_PROPOSAL_REJECTED"
  );
}

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

return {
  ...proposal,
  id: String(proposal.id),
  ask_price: askPrice,
};


}

/* ============================================================
PURCHASE
============================================================ */

/**

* Purchase an existing Deriv proposal.
*
* `price` represents the maximum price the backend is willing
* to pay. It must come from trusted backend proposal data and
* must never be supplied directly by Gemini or the frontend.
  */
  async buy({
  accountId,
  token,
  proposalId,
  price,
  }) {
  const normalizedAccountId = String(
  accountId || ""
  ).trim();


const normalizedProposalId = String(



  proposalId || ""
).trim();

if (!normalizedAccountId) {
  throw new AppError(
    "Deriv account ID is required",
    400,
    "ACCOUNT_ID_REQUIRED"
  );
}

if (
  typeof token !== "string" ||
  !token.trim()
) {
  throw new AppError(
    "Deriv access token is required",
    401,
    "DERIV_TOKEN_REQUIRED"
  );
}

if (!normalizedProposalId) {
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

/**
 * A proposal should only be purchased once by this backend
 * instance. This protects against overlapping scheduler cycles.
 */
const lockKey =
  `${normalizedAccountId}:${normalizedProposalId}`;

if (this.purchaseLocks.has(lockKey)) {
  throw new AppError(
    "A purchase for this proposal is already in progress",
    409,
    "PURCHASE_ALREADY_IN_PROGRESS"
  );
}

this.purchaseLocks.add(lockKey);

try {
  const msg =
    await derivConnectionManager.request(
      normalizedAccountId,
      token,
      {
        buy: normalizedProposalId,
        price: maximumPrice,
      }
    );

  if (msg?.error) {
    throw new AppError(
      msg.error.message ||
        "Deriv rejected the contract purchase",
      502,
      msg.error.code || "DERIV_PURCHASE_REJECTED"
    );
  }

  if (!msg?.buy) {
    throw new AppError(
      "Deriv did not confirm the contract purchase",
      502,
      "DERIV_PURCHASE_MISSING"
    );
  }

  const purchase = msg.buy;

  const contractId =
    purchase.contract_id ||
    purchase.contractId;

  if (!contractId) {
    throw new AppError(
      "Deriv purchase does not contain a contract ID",
      502,
      "DERIV_PURCHASE_INVALID"
    );
  }

  return {
    ...purchase,
    contract_id: String(contractId),
  };
} finally {
  this.purchaseLocks.delete(lockKey);
}


}

/* ============================================================
TRADE RECORDING
============================================================ */

/**

* Persist a purchased trade.
*
* Deriv contract IDs are treated as the broker-level source of
* truth. Recording is idempotent to safely handle retries after
* network or application failures.
  */
  async record(input) {
  if (
  !input ||
  typeof input !== "object" ||
  Array.isArray(input)
  ) {
  throw new AppError(
  "Trade data is required",
  400,
  "TRADE_DATA_REQUIRED"
  );
  }


const userId = String(



  input.userId || ""
).trim();

const derivAccountId = String(
  input.derivAccountId || ""
).trim();

const derivContractId = String(
  input.derivContractId || ""
).trim();

if (!userId) {
  throw new AppError(
    "Trade user ID is required",
    400,
    "TRADE_USER_REQUIRED"
  );
}

if (!derivAccountId) {
  throw new AppError(
    "Deriv account ID is required",
    400,
    "TRADE_ACCOUNT_REQUIRED"
  );
}

if (!derivContractId) {
  throw new AppError(
    "Deriv contract ID is required",
    400,
    "TRADE_CONTRACT_REQUIRED"
  );
}

/**
 * Check for an existing record before creating one.
 */
const existing = await Trade.findOne({
  derivContractId,
  derivAccountId,
});

if (existing) {
  return existing;
}

try {
  return await Trade.create({
    ...input,
    userId,
    derivAccountId,
    derivContractId,
    status: input.status || "open",
  });
} catch (error) {
  /**
   * Protect against concurrent inserts when MongoDB has a unique
   * compound index on derivContractId + derivAccountId.
   */
  if (error?.code === 11000) {
    const duplicate = await Trade.findOne({
      derivContractId,
      derivAccountId,
    });

    if (duplicate) {
      return duplicate;
    }
  }

  throw error;
}


}

/* ============================================================
RECORD SUCCESSFUL PURCHASE
============================================================ */

/**

* Convenience method for recording a successful Deriv purchase.
*
* This method is called only AFTER Deriv confirms the purchase.
* Financial values are taken from trusted Deriv responses where
* possible.
  */
  async recordPurchase({
  userId,
  accountId,
  purchase,
  proposal,
  contractParameters = {},
  analysis = null,
  strategy = null,
  entryPrice = null,
  }) {
  const contractId =
  purchase?.contract_id ||
  purchase?.contractId;


if (!contractId) {



  throw new AppError(
    "Cannot record a purchase without a contract ID",
    400,
    "PURCHASE_CONTRACT_REQUIRED"
  );
}

const buyPrice = Number(
  purchase?.buy_price ??
  proposal?.ask_price ??
  0
);

const normalizedBuyPrice =
  Number.isFinite(buyPrice) && buyPrice > 0
    ? buyPrice
    : null;

const market =
  contractParameters.symbol ||
  proposal?.underlying ||
  proposal?.symbol ||
  null;

return this.record({
  userId: String(userId),
  derivAccountId: String(accountId),
  derivContractId: String(contractId),

  status: "open",

  /**
   * Keep both names compatible if your Trade model uses either
   * `market` or `symbol`. Remove one if your schema strictly
   * defines only one of them.
   */
  market,
  symbol: market,

  action:
    analysis?.action ||
    null,

  stake: normalizedBuyPrice,
  buyPrice: normalizedBuyPrice,

  entryPrice:
    Number.isFinite(Number(entryPrice))
      ? Number(entryPrice)
      : null,

  currency:
    purchase?.currency ||
    proposal?.currency ||
    contractParameters.currency ||
    null,

  contractType:
    contractParameters.contract_type ||
    contractParameters.contractType ||
    null,

  openedAt: new Date(),

  metadata: {
    proposalId:
      proposal?.id
        ? String(proposal.id)
        : null,

    /**
     * Gemini information is stored as analysis metadata only.
     * It never represents execution authority.
     */
    aiConfidence:
      Number.isFinite(
        Number(analysis?.confidence)
      )
        ? Number(analysis.confidence)
        : null,

    aiReason:
      analysis?.reason || null,

    strategyReasons:
      Array.isArray(strategy?.reasons)
        ? strategy.reasons
        : [],
  },
});


}
}

export const tradeExecutionService =
new TradeExecutionService();
