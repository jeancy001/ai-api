import { DerivAccount } from "../models/DerivAccount.js";
import { TradingSettings } from "../models/TradingSettings.js";

import { derivBalanceService } from "./DerivBalanceService.js";
import { derivMarketService } from "./DerivMarketService.js";
import { marketDataService } from "./MarketDataService.js";
import { geminiTradingService } from "./GeminiTradingService.js";

import { tradingStrategyService } from "./TradingStrategyService.js";
import { riskManagementService } from "./RiskManagementService.js";
import { tradeExecutionService } from "./TradeExecutionService.js";

import { decrypt } from "../utils/crypto.js";

const MIN_INTERVAL = 5_000;
const DEFAULT_INTERVAL = 15_000;

export class AutoTradingService {
constructor() {
/**
* Prevents overlapping executions for the same user.
*/
this.locks = new Set();


/**
 * Active trading engines.
 *
 * Map<userId, {
 *   timer: NodeJS.Timeout | null,
 *   running: boolean,
 *   stopped: boolean,
 *   interval: number,
 * }>
 */
this.engines = new Map();


}

/* ============================================================
ENGINE LIFECYCLE
============================================================ */

/**

* Start the user's trading engine.
*
* This starts only the scheduler. Every cycle independently
* validates the account, authorization, emergency-stop state,
* market availability, and risk rules.
  */
  async start(userId) {
  const id = String(userId);


const existingEngine = this.engines.get(id);



if (existingEngine && !existingEngine.stopped) {
  return {
    started: false,
    reason: "ALREADY_RUNNING",
    interval: existingEngine.interval,
  };
}

const settings = await TradingSettings.findOne({
  userId: id,
});

if (!settings) {
  throw new Error("Trading settings were not found");
}

if (!settings.autoTradingEnabled) {
  throw new Error(
    "Auto-trading is not enabled in the database"
  );
}

if (!settings.realTradingAuthorized) {
  throw new Error(
    "Real-money trading has not been authorized"
  );
}

if (settings.emergencyStop) {
  throw new Error(
    "Emergency Stop is active. Reset it before starting trading."
  );
}

if (!settings.selectedMarket?.trim()) {
  throw new Error(
    "A Deriv market must be selected before trading can start"
  );
}

/**
 * Support both the newer tradingIntervalMs field and the
 * existing analysisInterval field.
 */
const configuredInterval = Number(
  settings.tradingIntervalMs ??
    settings.analysisInterval
);

const interval = Number.isFinite(configuredInterval)
  ? Math.max(configuredInterval, MIN_INTERVAL)
  : DEFAULT_INTERVAL;

const engine = {
  timer: null,
  running: false,
  stopped: false,
  interval,
};

this.engines.set(id, engine);

const executeCycle = async () => {
  /**
   * The engine may have been stopped while this callback was
   * waiting in the event loop.
   */
  if (engine.stopped || engine.running) {
    return;
  }

  engine.running = true;

  try {
    await this.runUserCycle(id);
  } catch (error) {
    console.error(
      `Auto-trading cycle failed for user ${id}:`,
      error?.message || error
    );
  } finally {
    engine.running = false;
  }
};

/**
 * Run the first cycle immediately so the user does not have to
 * wait for the first interval.
 */
void executeCycle();

engine.timer = setInterval(() => {
  void executeCycle();
}, interval);

return {
  started: true,
  interval,
};


}

/**

* Stop the user's local trading engine immediately.
*
* Controllers should persist the appropriate database state
* before or alongside calling this method.
  */
  async stop(userId, reason = "STOPPED") {
  const id = String(userId);
  const engine = this.engines.get(id);


if (!engine) {



  return {
    stopped: false,
    reason: "NOT_RUNNING",
  };
}

/**
 * Mark stopped before clearing the timer. This prevents an
 * already queued callback from beginning a new cycle.
 */
engine.stopped = true;

if (engine.timer) {
  clearInterval(engine.timer);
  engine.timer = null;
}

this.engines.delete(id);

return {
  stopped: true,
  reason,
};


}

/**

* Immediately stop the local engine after Emergency Stop.
*
* The controller is responsible for setting emergencyStop=true
* in the database. This method ensures the in-memory scheduler
* is also terminated immediately.
  */
  async emergencyStop(
  userId,
  reason = "EMERGENCY_STOP_ACTIVE"
  ) {
  return this.stop(userId, reason);
  }

/**

* Returns whether this application instance currently has an
* active engine for the user.
  */
  isRunning(userId) {
  const engine = this.engines.get(String(userId));


return Boolean(engine && !engine.stopped);


}

/* ============================================================
USER CYCLE
============================================================ */

/**

* Execute one cycle using the selected account's stored token.
  */
  async runUserCycle(userId) {
  const id = String(userId);


/**



 * Recheck engine state before doing account or token work.
 */
if (!this.isRunning(id)) {
  return {
    skipped: true,
    reason: "ENGINE_NOT_RUNNING",
  };
}

const account = await DerivAccount.findOne({
  userId: id,
  selected: true,
  connected: true,
});

if (!account) {
  return {
    skipped: true,
    reason: "DERIV_ACCOUNT_NOT_SELECTED",
  };
}

if (
  String(account.accountType || "")
    .trim()
    .toLowerCase() !== "real"
) {
  return {
    skipped: true,
    reason: "NOT_REAL_ACCOUNT",
  };
}

if (!account.derivAccountId) {
  return {
    skipped: true,
    reason: "DERIV_ACCOUNT_ID_MISSING",
  };
}

if (!account.encryptedAccessToken) {
  return {
    skipped: true,
    reason: "DERIV_ACCESS_TOKEN_MISSING",
  };
}

let accessToken;

try {
  accessToken = decrypt(account.encryptedAccessToken);
} catch (error) {
  console.error(
    `Unable to decrypt Deriv access token for user ${id}:`,
    error?.message || error
  );

  return {
    skipped: true,
    reason: "DERIV_ACCESS_TOKEN_INVALID",
  };
}

return this.runOnce({
  userId: id,
  accessToken,
});


}

/* ============================================================
PROTECTED TRADING CYCLE
============================================================ */

/**

* Execute one protected trading cycle.
  */
  async runOnce({ userId, accessToken }) {
  const id = String(userId);


if (this.locks.has(id)) {



  return {
    skipped: true,
    reason: "RUN_ALREADY_IN_PROGRESS",
  };
}

this.locks.add(id);

try {
  /**
   * An engine may have been stopped immediately after the cycle
   * was scheduled.
   */
  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason: "ENGINE_STOPPED",
    };
  }

  const [account, settings] = await Promise.all([
    DerivAccount.findOne({
      userId: id,
      selected: true,
      connected: true,
    }),

    TradingSettings.findOne({
      userId: id,
    }),
  ]);

  if (!account || !settings) {
    return {
      skipped: true,
      reason: "ACCOUNT_OR_SETTINGS_MISSING",
    };
  }

  /* --------------------------------------------------------
     SAFETY CHECKS — EVERY CYCLE
  -------------------------------------------------------- */

  if (!settings.autoTradingEnabled) {
    return {
      skipped: true,
      reason: "AUTO_TRADING_DISABLED",
    };
  }

  if (!settings.realTradingAuthorized) {
    return {
      skipped: true,
      reason: "REAL_TRADING_NOT_AUTHORIZED",
    };
  }

  if (settings.emergencyStop) {
    /**
     * Stop the local scheduler too. Future cycles should not
     * continue running while the emergency state is active.
     */
    await this.stop(id, "EMERGENCY_STOP_ACTIVE");

    return {
      skipped: true,
      reason: "EMERGENCY_STOP_ACTIVE",
    };
  }

  if (
    String(account.accountType || "")
      .trim()
      .toLowerCase() !== "real"
  ) {
    return {
      skipped: true,
      reason: "NOT_REAL_ACCOUNT",
    };
  }

  if (!account.derivAccountId) {
    return {
      skipped: true,
      reason: "DERIV_ACCOUNT_ID_MISSING",
    };
  }

  const selectedMarket =
    settings.selectedMarket?.trim();

  if (!selectedMarket) {
    return {
      skipped: true,
      reason: "MARKET_NOT_SELECTED",
    };
  }

  /**
   * Verify the market against the real Deriv market catalogue.
   */
  const symbol =
    await derivMarketService.symbol(selectedMarket);

  if (!symbol?.symbol) {
    return {
      skipped: true,
      reason: "MARKET_UNAVAILABLE",
    };
  }

  /**
   * Do not continue if the engine was stopped while awaiting
   * the market validation request.
   */
  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason: "ENGINE_STOPPED",
    };
  }

  const [balance, market] = await Promise.all([
    derivBalanceService.get(
      account.derivAccountId,
      accessToken
    ),

    marketDataService.latest(
      account.derivAccountId,
      accessToken,
      selectedMarket
    ),
  ]);

  /**
   * Never use `!balance.balance`: a numeric zero is valid data,
   * even though it will normally fail the later risk checks.
   */
  const numericBalance = Number(balance?.balance);

  if (!Number.isFinite(numericBalance)) {
    return {
      skipped: true,
      reason: "BALANCE_UNAVAILABLE",
    };
  }

  const currentPrice = Number(market?.quote);

  if (!Number.isFinite(currentPrice)) {
    return {
      skipped: true,
      reason: "MARKET_DATA_UNAVAILABLE",
    };
  }

  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason: "ENGINE_STOPPED",
    };
  }

  /* --------------------------------------------------------
     AI ANALYSIS
  -------------------------------------------------------- */

  /**
   * AI is analysis only.
   *
   * Gemini never receives direct authority to place trades.
   * Contract parameters and execution remain backend-controlled.
   */
  const analysis =
    await geminiTradingService.analyze({
      symbol: selectedMarket,
      currentPrice,
      currency: balance?.currency || null,
      timestamp: new Date().toISOString(),
    });

  const confidenceThreshold = Number(
    settings.aiConfidenceThreshold ?? 0.7
  );

  if (
    !Number.isFinite(Number(analysis?.confidence)) ||
    Number(analysis.confidence) < confidenceThreshold
  ) {
    return {
      skipped: true,
      reason: "AI_CONFIDENCE_TOO_LOW",
      analysis,
    };
  }

  /* --------------------------------------------------------
     STRATEGY VALIDATION
  -------------------------------------------------------- */

  const strategy =
    tradingStrategyService.validate(
      analysis,
      market
    );

  if (!strategy?.approved) {
    return {
      skipped: true,
      reason:
        strategy?.reasons?.[0] ||
        "STRATEGY_REJECTED",
      analysis,
    };
  }

  const stake = Number(settings.stake);

  if (
    !Number.isFinite(stake) ||
    stake <= 0
  ) {
    return {
      skipped: true,
      reason: "INVALID_STAKE",
    };
  }

  /* --------------------------------------------------------
     RISK GATE
  -------------------------------------------------------- */

  const risk =
    await riskManagementService.evaluate({
      settings,
      balance: numericBalance,
      userId: id,
      accountId: account.derivAccountId,
      stake,
    });

  if (!risk?.approved) {
    return {
      skipped: true,
      reason:
        risk?.reasons?.[0] ||
        "RISK_REJECTED",
      risk,
    };
  }

  /**
   * The engine could have been stopped during AI analysis,
   * strategy validation, or risk evaluation.
   */
  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason: "ENGINE_STOPPED",
    };
  }

  /* --------------------------------------------------------
     BACKEND-CONTROLLED CONTRACT PARAMETERS
  -------------------------------------------------------- */

  const contractParameters =
    this.buildContractParameters({
      settings,
      analysis,
      symbol,
    });

  if (!contractParameters) {
    return {
      skipped: true,
      reason: "CONTRACT_PARAMETERS_REQUIRED",
      analysis,
      risk,
    };
  }

  /* --------------------------------------------------------
     PROPOSAL
  -------------------------------------------------------- */

  const proposal =
    await tradeExecutionService.proposal(
      account.derivAccountId,
      accessToken,
      contractParameters
    );

  if (!proposal?.id) {
    return {
      skipped: true,
      reason: "PROPOSAL_NOT_AVAILABLE",
    };
  }

  const proposalPrice = Number(proposal.ask_price);

  if (
    !Number.isFinite(proposalPrice) ||
    proposalPrice <= 0
  ) {
    return {
      skipped: true,
      reason: "INVALID_PROPOSAL_PRICE",
    };
  }

  /* --------------------------------------------------------
     FINAL SAFETY CHECK — IMMEDIATELY BEFORE PURCHASE
  -------------------------------------------------------- */

  const [finalSettings, finalAccount] =
    await Promise.all([
      TradingSettings.findOne({
        userId: id,
      }).lean(),

      DerivAccount.findOne({
        userId: id,
        selected: true,
        connected: true,
      }).lean(),
    ]);

  if (
    !finalSettings?.autoTradingEnabled ||
    !finalSettings?.realTradingAuthorized ||
    finalSettings?.emergencyStop
  ) {
    return {
      skipped: true,
      reason: "TRADING_STATE_CHANGED_BEFORE_EXECUTION",
    };
  }

  if (
    !finalAccount ||
    String(finalAccount.accountType || "")
      .trim()
      .toLowerCase() !== "real" ||
    String(finalAccount.derivAccountId) !==
      String(account.derivAccountId)
  ) {
    return {
      skipped: true,
      reason: "ACCOUNT_STATE_CHANGED_BEFORE_EXECUTION",
    };
  }

  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason: "ENGINE_STOPPED_BEFORE_EXECUTION",
    };
  }

  /* --------------------------------------------------------
     REAL PURCHASE
  -------------------------------------------------------- */

  const purchase =
    await tradeExecutionService.buy({
      accountId: account.derivAccountId,
      token: accessToken,
      proposalId: proposal.id,
      price: proposalPrice,
    });

  const derivContractId =
    purchase?.contract_id ||
    purchase?.contractId ||
    "";

  if (!derivContractId) {
    /**
     * A successful purchase response without an identifiable
     * contract should be treated as an execution inconsistency.
     *
     * Do not fabricate a contract ID.
     */
    throw new Error(
      "Deriv purchase completed without a contract identifier"
    );
  }

  /**
   * Record the trade only after the real purchase succeeds.
   */
  const trade =
    await tradeExecutionService.record({
      userId: id,
      derivAccountId: account.derivAccountId,
      derivContractId: String(derivContractId),
      market: selectedMarket,
      action: analysis.action,
      stake,
      currency: balance?.currency || null,
      status: "open",
      entryPrice: currentPrice,
      openedAt: new Date(),
      metadata: {
        aiConfidence: Number(analysis.confidence),
        aiReason: analysis.reason || null,
        strategyReasons: strategy.reasons || [],
        proposalId: proposal.id,
      },
    });

  return {
    skipped: false,
    executed: true,
    tradeId: trade?._id || null,
    derivContractId: String(derivContractId),
    analysis,
    risk,
  };
} finally {
  this.locks.delete(id);
}


}

/* ============================================================
CONTRACT CONFIGURATION
============================================================ */

/**

* Build contract parameters exclusively from explicitly configured
* and backend-approved settings.
*
* AI analysis can influence the strategy decision, but it must not
* be allowed to invent arbitrary Deriv API parameters.
  */
  buildContractParameters({
  settings,
  analysis,
  symbol,
  }) {
  const contractType =
  String(settings.contractType || "")
  .trim()
  .toUpperCase();


const duration = Number(



  settings.contractDuration
);

const durationUnit =
  String(
    settings.contractDurationUnit || ""
  )
    .trim()
    .toLowerCase();

const amount = Number(settings.stake);

const basis =
  String(settings.stakeBasis || "stake")
    .trim()
    .toLowerCase();

if (
  !contractType ||
  !Number.isFinite(duration) ||
  duration <= 0 ||
  !durationUnit ||
  !symbol?.symbol ||
  !Number.isFinite(amount) ||
  amount <= 0
) {
  return null;
}

/**
 * Basic defensive validation.
 *
 * Your backend should maintain an allowlist that matches the
 * contract types and duration units your application supports.
 */
const allowedDurationUnits = new Set([
  "s",
  "m",
  "h",
  "d",
  "t",
]);

if (!allowedDurationUnits.has(durationUnit)) {
  return null;
}

if (
  basis !== "stake" &&
  basis !== "payout"
) {
  return null;
}

const parameters = {
  amount,
  basis,
  contract_type: contractType,
  currency:
    String(settings.currency || "")
      .trim()
      .toUpperCase() || undefined,
  duration,
  duration_unit: durationUnit,
  symbol: symbol.symbol,
};

/**
 * Remove undefined values before sending the request.
 */
return Object.fromEntries(
  Object.entries(parameters).filter(
    ([, value]) => value !== undefined
  )
);


}

/* ============================================================
APPLICATION SHUTDOWN
============================================================ */

/**

* Stop every local engine.
*
* Useful during graceful application shutdown. This only stops
* local timers; persistent trading state should be managed by
* your shutdown policy/controllers.
  */
  async stopAll(reason = "APPLICATION_SHUTDOWN") {
  const userIds = [...this.engines.keys()];


await Promise.all(



  userIds.map((userId) =>
    this.stop(userId, reason)
  )
);

return {
  stopped: userIds.length,
  reason,
};


}
}

export const autoTradingService =
new AutoTradingService();
