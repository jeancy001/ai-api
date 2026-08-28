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

/**

* AutoTradingService
*
* IMPORTANT EMERGENCY-STOP POLICY:
*
* This service NEVER sets `TradingSettings.emergencyStop` to true.
*
* Ordinary conditions such as:
* * AI HOLD or low confidence
* * strategy rejection
* * risk rejection
* * stale/unavailable market data
* * temporary Deriv/API errors
* * proposal rejection
* * a failed cycle
*
* must NOT automatically activate Emergency Stop.
*
* Emergency Stop is an explicit persistent safety state managed by
* a dedicated controller/service. When an emergency state already
* exists, this service respects it and stops its local scheduler.
  */
  export class AutoTradingService {
  constructor() {
  /**

  * Prevent overlapping executions for the same user.
    */
    this.locks = new Set();

  /**

  * Active trading engines.
  *
  * Map<userId, {
  * timer: NodeJS.Timeout | null,
  * running: boolean,
  * stopped: boolean,
  * interval: number,
  * }>
    */
    this.engines = new Map();
    }

/* ============================================================
ENGINE LIFECYCLE
============================================================ */

/**

* Start the user's local trading engine.
*
* This method starts only the scheduler. Every cycle independently
* validates the current database state before a trade can proceed.
*
* This method NEVER clears or activates Emergency Stop.
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

/**
 * Respect an existing emergency state, but never modify it here.
 */
if (settings.emergencyStop === true) {
  throw new Error(
    "Emergency Stop is active. Reset it before starting trading."
  );
}

if (!settings.selectedMarket?.trim()) {
  throw new Error(
    "A Deriv market must be selected before trading can start"
  );
}

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
  if (engine.stopped || engine.running) {
    return;
  }

  engine.running = true;

  try {
    /**
     * A failed cycle is logged and skipped.
     *
     * DO NOT activate Emergency Stop automatically here.
     * The next scheduled cycle may continue normally.
     */
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
 * Run the first cycle immediately.
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
* IMPORTANT:
* This only stops the in-memory scheduler. It does NOT activate
* Emergency Stop and does NOT modify persistent settings.
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

* Backward-compatible method used when another trusted part of the
* backend has ALREADY activated Emergency Stop.
*
* This method only stops the local scheduler.
* It NEVER writes emergencyStop=true to the database.
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
*
* Rejections and ordinary failures skip the current cycle.
* They do NOT activate Emergency Stop.
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

  /**
   * Respect a persistent emergency state if one was explicitly
   * activated elsewhere.
   *
   * We stop only the local scheduler. This service does not create,
   * reset, or modify the emergency state.
   */
  if (settings.emergencyStop === true) {
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

  const symbol =
    await derivMarketService.symbol(selectedMarket);

  if (!symbol?.symbol) {
    return {
      skipped: true,
      reason: "MARKET_UNAVAILABLE",
    };
  }

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

  const numericBalance = Number(balance?.balance);

  if (!Number.isFinite(numericBalance)) {
    return {
      skipped: true,
      reason: "BALANCE_UNAVAILABLE",
    };
  }

  const currentPrice = Number(market?.quote);

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
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
     AI ANALYSIS — ANALYSIS ONLY
  -------------------------------------------------------- */

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
      market,
      {
        minimumConfidence: confidenceThreshold,
        expectedSymbol: selectedMarket,
      }
    );

  if (!strategy?.approved) {
    return {
      skipped: true,
      reason:
        strategy?.reasons?.[0] ||
        "STRATEGY_REJECTED",
      analysis,
      strategy,
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
     FINAL SAFETY CHECK — BEFORE PURCHASE
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
    !finalSettings?.realTradingAuthorized
  ) {
    return {
      skipped: true,
      reason: "TRADING_STATE_CHANGED_BEFORE_EXECUTION",
    };
  }

  /**
   * An Emergency Stop activated by the user elsewhere is always
   * respected, but this cycle does not create that emergency state.
   */
  if (finalSettings.emergencyStop === true) {
    await this.stop(id, "EMERGENCY_STOP_ACTIVE");

    return {
      skipped: true,
      reason: "EMERGENCY_STOP_ACTIVE",
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
     * This is an execution inconsistency and should be logged by
     * the caller. It still does NOT automatically activate
     * Emergency Stop.
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
* AI analysis never receives authority to invent arbitrary Deriv
* API parameters.
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
* This only stops local timers and NEVER activates Emergency Stop.
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
