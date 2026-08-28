import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";
import { AppError } from "../utils/AppError.js";

/**

* TradeExecutionService
*
* Responsible only for broker execution:
* * requesting validated proposals
* * purchasing approved proposals
* * recording confirmed purchases
*
* IMPORTANT:
* This service does NOT decide whether trading is allowed.
* Authorization, Emergency Stop, AI analysis, strategy validation,
* risk management, and final safety checks must happen before calling
* the purchase methods.
  */
  export class TradeExecutionService {
  constructor() {
  /**

  * Prevent duplicate purchase requests for the same proposal inside
  * this Node.js process.
  *
  * Database idempotency is still required because multiple processes
  * or deployment instances can exist.
    */
    this.purchaseLocks = new Set();
    }

/* ============================================================
PROPOSAL
============================================================ */

async proposal(accountId, token, params) {
const normalizedAccountId = String(accountId || "").trim();


if (!normalizedAccountId) {
  throw new AppError(
    "Deriv account ID is required",
    400,
    "ACCOUNT_ID_REQUIRED"
  );
}

if (typeof token !== "string" || !token.trim()) {
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
 * Prevent callers from overriding the Deriv command itself.
 */
const {
  proposal: _ignoredProposal,
  ...contractParameters
} = params;

const msg = await derivConnectionManager.request(
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

if (typeof token !== "string" || !token.trim()) {
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


const userId = String(input.userId || "").trim();
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
 * Fast path for normal retries.
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
   * A unique compound index is required for this to protect
   * against concurrent application instances.
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
RECORD CONFIRMED PURCHASE
============================================================ */

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

/**
 * buy_price is the actual broker-confirmed purchase amount when
 * available. proposal.ask_price is only the proposal price.
 */
const actualBuyPrice = Number(
  purchase?.buy_price ??
  proposal?.ask_price ??
  0
);

const normalizedBuyPrice =
  Number.isFinite(actualBuyPrice) &&
  actualBuyPrice > 0
    ? actualBuyPrice
    : null;

const configuredStake = Number(
  contractParameters.amount
);

const normalizedStake =
  Number.isFinite(configuredStake) &&
  configuredStake > 0
    ? configuredStake
    : normalizedBuyPrice;

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

  market,
  symbol: market,

  action: analysis?.action || null,

  stake: normalizedStake,
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
    proposalId: proposal?.id
      ? String(proposal.id)
      : null,

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
