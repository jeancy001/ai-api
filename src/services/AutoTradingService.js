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
const MIN_COOLDOWN = 0;

/**

* AutoTradingService
*
* IMPORTANT EMERGENCY-STOP POLICY
* ============================================================
*
* This service NEVER sets TradingSettings.emergencyStop to true.
*
* The following conditions must only skip a cycle or stop the
* local scheduler when appropriate:
*
* * AI HOLD or low confidence
* * strategy rejection
* * risk rejection
* * unavailable/stale market data
* * temporary Deriv/API errors
* * proposal rejection
* * failed analysis cycles
*
* Emergency Stop is a persistent, explicit user safety action.
* When an emergency state already exists, this service respects it
* and stops its local scheduler.
*
* IMPORTANT DEPLOYMENT NOTE
* ============================================================
*
* Engine state is stored in memory. This is appropriate for a
* single long-running Node.js process.
*
* If the application runs multiple backend instances, use a
* distributed scheduler/queue and distributed lock so that the
* same user cannot receive multiple trading engines.
  */
  export class AutoTradingService {
  constructor() {
  /**

  * Prevent overlapping trading executions for the same user.
    */
    this.locks = new Set();

  /**

  * Prevent duplicate engine creation while start() is resolving.
    */
    this.starting = new Set();

  /**

  * Active local engines.
  *
  * Map<userId, {
  * timer: NodeJS.Timeout | null,
  * running: boolean,
  * stopped: boolean,
  * interval: number,
  * lastExecutionAt: number | null,
  * }>
    */
    this.engines = new Map();
    }

/* ============================================================
HELPERS
============================================================ */

normalizeText(value) {
return String(value || "").trim().toLowerCase();
}

isAccountConnected(account) {
if (!account) {
return false;
}


const status = this.normalizeText(
  account.connectionStatus
);

return (
  account.connected === true ||
  status === "connected" ||
  status === "active"
);


}

isRealAccount(account) {
return (
this.normalizeText(account?.accountType) === "real"
);
}

getConfiguredInterval(settings) {
const configuredInterval = Number(
settings?.tradingIntervalMs ??
settings?.analysisInterval
);


if (!Number.isFinite(configuredInterval)) {
  return DEFAULT_INTERVAL;
}

return Math.max(
  Math.floor(configuredInterval),
  MIN_INTERVAL
);


}

getConfiguredCooldown(settings) {
const cooldown = Number(settings?.cooldown ?? 0);


if (!Number.isFinite(cooldown)) {
  return MIN_COOLDOWN;
}

return Math.max(
  Math.floor(cooldown),
  MIN_COOLDOWN
);


}

/* ============================================================
ENGINE LIFECYCLE
============================================================ */

/**

* Start the user's local trading engine.
*
* Every cycle independently validates the persisted database
* state before any real trade can proceed.
*
* This method never clears or activates Emergency Stop.
  */
  async start(userId) {
  const id = String(userId);


const existingEngine = this.engines.get(id);



if (
  existingEngine &&
  existingEngine.stopped !== true
) {
  return {
    started: false,
    reason: "ALREADY_RUNNING",
    interval: existingEngine.interval,
  };
}

if (this.starting.has(id)) {
  return {
    started: false,
    reason: "START_IN_PROGRESS",
  };
}

this.starting.add(id);

try {
  const settings = await TradingSettings.findOne({
    userId: id,
  });

  if (!settings) {
    throw new Error(
      "Trading settings were not found"
    );
  }

  if (settings.autoTradingEnabled !== true) {
    throw new Error(
      "Auto-trading is not enabled in the database"
    );
  }

  if (settings.realTradingAuthorized !== true) {
    throw new Error(
      "Real-money trading has not been authorized"
    );
  }

  if (settings.emergencyStop === true) {
    throw new Error(
      "Emergency Stop is active. Release it before starting trading."
    );
  }

  if (!settings.selectedMarket?.trim()) {
    throw new Error(
      "A Deriv market must be selected before trading can start"
    );
  }

  const interval =
    this.getConfiguredInterval(settings);

  const engine = {
    timer: null,
    running: false,
    stopped: false,
    interval,
    lastExecutionAt: null,
  };

  /**
   * Register the engine before scheduling the first cycle.
   * This makes isRunning() immediately consistent.
   */
  this.engines.set(id, engine);

  const executeCycle = async () => {
    if (
      engine.stopped ||
      engine.running ||
      this.engines.get(id) !== engine
    ) {
      return;
    }

    engine.running = true;

    try {
      await this.runUserCycle(id);
    } catch (error) {
      /**
       * A failed cycle is isolated.
       *
       * Never activate Emergency Stop automatically.
       */
      console.error(
        `Auto-trading cycle failed for user ${id}:`,
        error?.message || error
      );
    } finally {
      engine.running = false;
    }
  };

  /**
   * Start immediately. Errors are contained inside executeCycle.
   */
  void executeCycle();

  engine.timer = setInterval(() => {
    void executeCycle();
  }, interval);

  return {
    started: true,
    interval,
  };
} finally {
  this.starting.delete(id);
}


}

/**

* Stop the user's local trading scheduler.
*
* This does not activate Emergency Stop and does not modify
* persistent database settings.
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

/**
 * Delete only if this is still the same engine instance.
 */
if (this.engines.get(id) === engine) {
  this.engines.delete(id);
}

return {
  stopped: true,
  reason,
};


}

/**

* Compatibility method.
*
* Another trusted controller may already have activated the
* persistent Emergency Stop. This method only stops the local
* scheduler and never writes emergencyStop=true.
  */
  async emergencyStop(
  userId,
  reason = "EMERGENCY_STOP_ACTIVE"
  ) {
  return this.stop(userId, reason);
  }

/**

* Returns whether this application instance currently has an
* active local engine for the user.
  */
  isRunning(userId) {
  const engine = this.engines.get(String(userId));


return Boolean(



  engine &&
  engine.stopped !== true
);


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
});

if (!account) {
  return {
    skipped: true,
    reason: "DERIV_ACCOUNT_NOT_SELECTED",
  };
}

if (!this.isAccountConnected(account)) {
  return {
    skipped: true,
    reason: "DERIV_ACCOUNT_NOT_CONNECTED",
  };
}

if (!this.isRealAccount(account)) {
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
  accessToken = decrypt(
    account.encryptedAccessToken
  );
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
* Ordinary failures and rejections skip only the current cycle.
* They never activate Emergency Stop automatically.
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

  const engine = this.engines.get(id);

  const [account, settings] = await Promise.all([
    DerivAccount.findOne({
      userId: id,
      selected: true,
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

  if (settings.autoTradingEnabled !== true) {
    return {
      skipped: true,
      reason: "AUTO_TRADING_DISABLED",
    };
  }

  if (
    settings.realTradingAuthorized !== true
  ) {
    return {
      skipped: true,
      reason: "REAL_TRADING_NOT_AUTHORIZED",
    };
  }

  /**
   * Respect an emergency state created explicitly elsewhere.
   */
  if (settings.emergencyStop === true) {
    await this.stop(
      id,
      "EMERGENCY_STOP_ACTIVE"
    );

    return {
      skipped: true,
      reason: "EMERGENCY_STOP_ACTIVE",
    };
  }

  if (!this.isAccountConnected(account)) {
    return {
      skipped: true,
      reason: "DERIV_ACCOUNT_NOT_CONNECTED",
    };
  }

  if (!this.isRealAccount(account)) {
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
   * Enforce cooldown between actual executions.
   */
  const cooldown =
    this.getConfiguredCooldown(settings);

  if (
    cooldown > 0 &&
    engine?.lastExecutionAt &&
    Date.now() - engine.lastExecutionAt < cooldown
  ) {
    return {
      skipped: true,
      reason: "COOLDOWN_ACTIVE",
    };
  }

  const symbol =
    await derivMarketService.symbol(
      selectedMarket
    );

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

  /* --------------------------------------------------------
     LIVE BALANCE + MARKET DATA
  -------------------------------------------------------- */

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

  const numericBalance = Number(
    balance?.balance
  );

  if (!Number.isFinite(numericBalance)) {
    return {
      skipped: true,
      reason: "BALANCE_UNAVAILABLE",
    };
  }

  const currentPrice = Number(
    market?.quote
  );

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
    !Number.isFinite(
      Number(analysis?.confidence)
    ) ||
    Number(analysis.confidence) <
      confidenceThreshold
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
        minimumConfidence:
          confidenceThreshold,
        expectedSymbol:
          selectedMarket,
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

  /* --------------------------------------------------------
     STAKE VALIDATION
  -------------------------------------------------------- */

  const stake = Number(settings.stake);
  const maxStake = Number(
    settings.maxStake
  );

  if (
    !Number.isFinite(stake) ||
    stake <= 0
  ) {
    return {
      skipped: true,
      reason: "INVALID_STAKE",
    };
  }

  /**
   * Defensive limit in the execution service.
   * RiskManagementService should also enforce limits.
   */
  if (
    Number.isFinite(maxStake) &&
    maxStake > 0 &&
    stake > maxStake
  ) {
    return {
      skipped: true,
      reason: "STAKE_EXCEEDS_MAX_STAKE",
    };
  }

  if (stake > numericBalance) {
    return {
      skipped: true,
      reason: "INSUFFICIENT_BALANCE",
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
      currency:
        balance?.currency ||
        account.currency ||
        null,
    });

  if (!contractParameters) {
    return {
      skipped: true,
      reason:
        "CONTRACT_PARAMETERS_REQUIRED",
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

  const proposalPrice = Number(
    proposal.ask_price
  );

  if (
    !Number.isFinite(proposalPrice) ||
    proposalPrice <= 0
  ) {
    return {
      skipped: true,
      reason: "INVALID_PROPOSAL_PRICE",
    };
  }

  /**
   * Never purchase above the configured stake limit when the
   * basis is stake.
   */
  if (
    contractParameters.basis === "stake" &&
    proposalPrice > stake
  ) {
    return {
      skipped: true,
      reason: "PROPOSAL_PRICE_EXCEEDS_STAKE",
    };
  }

  /* --------------------------------------------------------
     FINAL DATABASE SAFETY CHECK — BEFORE PURCHASE
  -------------------------------------------------------- */

  const [finalSettings, finalAccount] =
    await Promise.all([
      TradingSettings.findOne({
        userId: id,
      }).lean(),

      DerivAccount.findOne({
        userId: id,
        selected: true,
      }).lean(),
    ]);

  if (
    !finalSettings?.autoTradingEnabled ||
    !finalSettings?.realTradingAuthorized
  ) {
    return {
      skipped: true,
      reason:
        "TRADING_STATE_CHANGED_BEFORE_EXECUTION",
    };
  }

  if (
    finalSettings.emergencyStop === true
  ) {
    await this.stop(
      id,
      "EMERGENCY_STOP_ACTIVE"
    );

    return {
      skipped: true,
      reason: "EMERGENCY_STOP_ACTIVE",
    };
  }

  if (
    !finalAccount ||
    !this.isAccountConnected(finalAccount) ||
    !this.isRealAccount(finalAccount) ||
    String(
      finalAccount.derivAccountId
    ) !== String(account.derivAccountId)
  ) {
    return {
      skipped: true,
      reason:
        "ACCOUNT_STATE_CHANGED_BEFORE_EXECUTION",
    };
  }

  if (!this.isRunning(id)) {
    return {
      skipped: true,
      reason:
        "ENGINE_STOPPED_BEFORE_EXECUTION",
    };
  }

  /* --------------------------------------------------------
     REAL PURCHASE
  -------------------------------------------------------- */

  const purchase =
    await tradeExecutionService.buy({
      accountId:
        account.derivAccountId,
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
     * A purchase response without a contract ID is an execution
     * inconsistency. Do not activate Emergency Stop automatically.
     */
    throw new Error(
      "Deriv purchase completed without a contract identifier"
    );
  }

  /**
   * Mark execution time immediately after successful purchase.
   * This prevents the next cycle from executing again before
   * cooldown begins.
   */
  const activeEngine =
    this.engines.get(id);

  if (activeEngine) {
    activeEngine.lastExecutionAt = Date.now();
  }

  /* --------------------------------------------------------
     RECORD SUCCESSFUL REAL TRADE
  -------------------------------------------------------- */

  let trade;

  try {
    trade =
      await tradeExecutionService.record({
        userId: id,
        derivAccountId:
          account.derivAccountId,
        derivContractId:
          String(derivContractId),
        market: selectedMarket,
        action: analysis.action,
        contractType:
          contractParameters.contract_type,
        stake,
        currency:
          balance?.currency ||
          account.currency ||
          null,
        status: "open",
        entryPrice: currentPrice,
        openedAt: new Date(),
        metadata: {
          aiConfidence:
            Number(analysis.confidence),
          aiReason:
            analysis.reason || null,
          strategyReasons:
            strategy.reasons || [],
          proposalId: proposal.id,
        },
      });
  } catch (recordError) {
    /**
     * CRITICAL:
     * The real purchase has already happened.
     *
     * Do not retry the purchase and do not automatically activate
     * Emergency Stop. Surface the reconciliation issue clearly.
     */
    console.error(
      `Real trade ${derivContractId} was purchased but could not be recorded for user ${id}:`,
      recordError?.message || recordError
    );

    return {
      skipped: false,
      executed: true,
      recorded: false,
      reconciliationRequired: true,
      derivContractId:
        String(derivContractId),
      analysis,
      risk,
    };
  }

  return {
    skipped: false,
    executed: true,
    recorded: true,
    tradeId: trade?._id || null,
    derivContractId:
      String(derivContractId),
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
* backend settings.
*
* AI analysis never receives authority to invent arbitrary
* Deriv API parameters.
  */
  buildContractParameters({
  settings,
  analysis,
  symbol,
  currency,
  }) {
  const contractType = String(
  settings.contractType || ""
  )
  .trim()
  .toUpperCase();


const duration = Number(



  settings.contractDuration
);

const durationUnit = String(
  settings.contractDurationUnit || ""
)
  .trim()
  .toLowerCase();

const amount = Number(settings.stake);

const basis = String(
  settings.stakeBasis || "stake"
)
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
 * Keep duration units restricted to values supported by your
 * backend's Deriv contract configuration.
 */
const allowedDurationUnits = new Set([
  "s",
  "m",
  "h",
  "d",
  "t",
]);

if (
  !allowedDurationUnits.has(
    durationUnit
  )
) {
  return null;
}

if (
  basis !== "stake" &&
  basis !== "payout"
) {
  return null;
}

const normalizedCurrency = String(
  currency || ""
)
  .trim()
  .toUpperCase();

const parameters = {
  amount,
  basis,
  contract_type: contractType,
  currency:
    normalizedCurrency || undefined,
  duration,
  duration_unit: durationUnit,
  symbol: symbol.symbol,
};

return Object.fromEntries(
  Object.entries(parameters).filter(
    ([, value]) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  )
);


}

/* ============================================================
APPLICATION SHUTDOWN
============================================================ */

/**

* Stop every local engine.
*
* This only stops local timers and never activates Emergency Stop.
  */
  async stopAll(
  reason = "APPLICATION_SHUTDOWN"
  ) {
  const userIds = [
  ...this.engines.keys(),
  ];


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
