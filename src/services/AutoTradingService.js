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

* Confidence is stored and displayed as a percentage.
*
* Example:
* 80 = 80%
*
* AI providers may return either:
* 0.8 = 80%
* 80  = 80%
*
* normalizeConfidencePercentage() converts both formats to 80.
  */
  const DEFAULT_AI_CONFIDENCE_THRESHOLD = 80;

export class AutoTradingService {
constructor() {
/**
* Prevent overlapping executions for the same user.
*/
this.locks = new Set();


/**
 * Prevent duplicate engine creation while start() is resolving.
 */
this.starting = new Set();

/**
 * Active local engines.
 */
this.engines = new Map();


}

/* ============================================================
HELPERS
============================================================ */

normalizeText(value) {
return String(value || "").trim().toLowerCase();
}

/**

* Normalize confidence to a percentage between 0 and 100.
*
* 0.8  -> 80
* 0.75 -> 75
* 80   -> 80
  */
  normalizeConfidencePercentage(value) {
  const confidence = Number(value);


if (!Number.isFinite(confidence)) {



  return NaN;
}

if (confidence >= 0 && confidence <= 1) {
  return confidence * 100;
}

return confidence;


}

/**

* Always use percentage format internally.
* Supports old database values such as 0.8 for backward compatibility.
  */
  getConfidenceThreshold(settings) {
  const rawValue =
  settings?.aiConfidenceThreshold ??
  DEFAULT_AI_CONFIDENCE_THRESHOLD;


const normalized =



  this.normalizeConfidencePercentage(rawValue);

if (!Number.isFinite(normalized)) {
  return DEFAULT_AI_CONFIDENCE_THRESHOLD;
}

return Math.min(
  100,
  Math.max(0, normalized)
);


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
const cooldown = Number(
settings?.cooldown ?? MIN_COOLDOWN
);


if (!Number.isFinite(cooldown)) {
  return MIN_COOLDOWN;
}

return Math.max(
  Math.floor(cooldown),
  MIN_COOLDOWN
);


}

/**

* Log every skipped/executed cycle.
*
* This is critical for debugging real trading. Previously the
* scheduler could silently skip every cycle.
  */
  logCycleResult(userId, result) {
  if (!result) return;


if (result.executed) {



  console.log(
    `[AUTO-TRADE] REAL TRADE EXECUTED | user=${userId} | contract=${result.derivContractId} | recorded=${result.recorded}`
  );
  return;
}

if (result.skipped) {
  console.log(
    `[AUTO-TRADE] Cycle skipped | user=${userId} | reason=${result.reason || "UNKNOWN"}`
  );
}


}

/* ============================================================
ENGINE LIFECYCLE
============================================================ */

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
  const settings =
    await TradingSettings.findOne({
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
   * Register before the first cycle.
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
      const result =
        await this.runUserCycle(id);

      this.logCycleResult(id, result);
    } catch (error) {
      console.error(
        `[AUTO-TRADE] Cycle failed | user=${id}:`,
        error?.message || error
      );
    } finally {
      engine.running = false;
    }
  };

  /**
   * Execute immediately, then continue on the configured interval.
   */
  void executeCycle();

  engine.timer = setInterval(() => {
    void executeCycle();
  }, interval);

  console.log(
    `[AUTO-TRADE] Engine started | user=${id} | interval=${interval}ms | confidence=${this.getConfidenceThreshold(settings)}%`
  );

  return {
    started: true,
    interval,
    confidenceThreshold:
      this.getConfidenceThreshold(settings),
  };
} finally {
  this.starting.delete(id);
}


}

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

if (this.engines.get(id) === engine) {
  this.engines.delete(id);
}

console.log(
  `[AUTO-TRADE] Engine stopped | user=${id} | reason=${reason}`
);

return {
  stopped: true,
  reason,
};


}

async emergencyStop(
userId,
reason = "EMERGENCY_STOP_ACTIVE"
) {
return this.stop(userId, reason);
}

isRunning(userId) {
const engine =
this.engines.get(String(userId));


return Boolean(
  engine &&
  engine.stopped !== true
);


}

/* ============================================================
USER CYCLE
============================================================ */

async runUserCycle(userId) {
const id = String(userId);


if (!this.isRunning(id)) {
  return {
    skipped: true,
    reason: "ENGINE_NOT_RUNNING",
  };
}

const account =
  await DerivAccount.findOne({
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
    `[AUTO-TRADE] Unable to decrypt token | user=${id}:`,
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
PROTECTED REAL TRADING CYCLE
============================================================ */

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

  const [account, settings] =
    await Promise.all([
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
     SAFETY + REAL ACCOUNT CHECKS
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

  /* --------------------------------------------------------
     LIVE BALANCE + LIVE MARKET DATA
  -------------------------------------------------------- */

  const [balance, market] =
    await Promise.all([
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

  const numericBalance =
    Number(balance?.balance);

  if (
    !Number.isFinite(numericBalance) ||
    numericBalance < 0
  ) {
    return {
      skipped: true,
      reason: "BALANCE_UNAVAILABLE",
    };
  }

  const currentPrice =
    Number(market?.quote);

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return {
      skipped: true,
      reason: "MARKET_DATA_UNAVAILABLE",
    };
  }

  /* --------------------------------------------------------
     AI ANALYSIS
  -------------------------------------------------------- */

  const analysis =
    await geminiTradingService.analyze({
      symbol: selectedMarket,
      currentPrice,
      currency:
        balance?.currency || null,
      timestamp:
        new Date().toISOString(),
    });

  /**
   * IMPORTANT:
   * Threshold is now 80 (80%), not 0.8.
   * Both AI formats 0.8 and 80 are normalized correctly.
   */
  const confidenceThreshold =
    this.getConfidenceThreshold(settings);

  const aiConfidence =
    this.normalizeConfidencePercentage(
      analysis?.confidence
    );

  if (!Number.isFinite(aiConfidence)) {
    return {
      skipped: true,
      reason: "AI_CONFIDENCE_INVALID",
      analysis,
    };
  }

  if (aiConfidence < confidenceThreshold) {
    return {
      skipped: true,
      reason: "AI_CONFIDENCE_TOO_LOW",
      analysis: {
        ...analysis,
        confidence: aiConfidence,
      },
    };
  }

  /**
   * Do not trade when the AI explicitly says HOLD.
   */
  if (
    this.normalizeText(analysis?.action) === "hold"
  ) {
    return {
      skipped: true,
      reason: "AI_HOLD",
      analysis,
    };
  }

  /* --------------------------------------------------------
     STRATEGY VALIDATION
  -------------------------------------------------------- */

  const normalizedAnalysis = {
    ...analysis,
    confidence: aiConfidence,
  };

  const strategy =
    tradingStrategyService.validate(
      normalizedAnalysis,
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
      analysis: normalizedAnalysis,
      strategy,
    };
  }

  /* --------------------------------------------------------
     STAKE VALIDATION
  -------------------------------------------------------- */

  const stake = Number(settings.stake);
  const maxStake =
    Number(settings.maxStake);

  if (
    !Number.isFinite(stake) ||
    stake <= 0
  ) {
    return {
      skipped: true,
      reason: "INVALID_STAKE",
    };
  }

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
      accountId:
        account.derivAccountId,
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

  /* --------------------------------------------------------
     CONTRACT PARAMETERS
  -------------------------------------------------------- */

  const contractParameters =
    this.buildContractParameters({
      settings,
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
      analysis: normalizedAnalysis,
      risk,
    };
  }

  /* --------------------------------------------------------
     GET REAL DERIV PROPOSAL
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

  const proposalPrice =
    Number(proposal.ask_price);

  if (
    !Number.isFinite(proposalPrice) ||
    proposalPrice <= 0
  ) {
    return {
      skipped: true,
      reason:
        "INVALID_PROPOSAL_PRICE",
    };
  }

  /**
   * For stake-based contracts, Deriv's proposal must not
   * require more than the configured stake.
   */
  if (
    contractParameters.basis === "stake" &&
    proposalPrice > stake
  ) {
    return {
      skipped: true,
      reason:
        "PROPOSAL_PRICE_EXCEEDS_STAKE",
    };
  }

  /* --------------------------------------------------------
     FINAL DATABASE CHECK BEFORE REAL PURCHASE
  -------------------------------------------------------- */

  const [
    finalSettings,
    finalAccount,
  ] = await Promise.all([
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
      reason:
        "EMERGENCY_STOP_ACTIVE",
    };
  }

  if (
    !finalAccount ||
    !this.isAccountConnected(finalAccount) ||
    !this.isRealAccount(finalAccount) ||
    String(finalAccount.derivAccountId) !==
      String(account.derivAccountId)
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

  /* ========================================================
     REAL DERIV PURCHASE
     ======================================================== */

  console.log(
    `[AUTO-TRADE] Purchasing REAL contract | user=${id} | account=${account.derivAccountId} | proposal=${proposal.id} | price=${proposalPrice}`
  );

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
    throw new Error(
      "Deriv purchase response did not contain a contract identifier"
    );
  }

  /**
   * The purchase succeeded. Update cooldown immediately.
   */
  const activeEngine =
    this.engines.get(id);

  if (activeEngine) {
    activeEngine.lastExecutionAt =
      Date.now();
  }

  console.log(
    `[AUTO-TRADE] REAL PURCHASE SUCCESS | user=${id} | contract=${derivContractId}`
  );

  /* --------------------------------------------------------
     RECORD THE REAL TRADE
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
        action:
          normalizedAnalysis.action,
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
          aiConfidence,
          aiReason:
            normalizedAnalysis.reason || null,
          strategyReasons:
            strategy.reasons || [],
          proposalId: proposal.id,
          proposalPrice,
          realAccount: true,
        },
      });
  } catch (recordError) {
    /**
     * The real trade already exists at Deriv.
     * Never purchase again here.
     */
    console.error(
      `[AUTO-TRADE] Real trade purchased but database recording failed | contract=${derivContractId}:`,
      recordError?.message || recordError
    );

    return {
      skipped: false,
      executed: true,
      recorded: false,
      reconciliationRequired: true,
      derivContractId:
        String(derivContractId),
      analysis: normalizedAnalysis,
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
    analysis: normalizedAnalysis,
    risk,
  };
} finally {
  this.locks.delete(id);
}


}

/* ============================================================
CONTRACT CONFIGURATION
============================================================ */

buildContractParameters({
settings,
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

const allowedDurationUnits =
  new Set([
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
  duration,
  duration_unit: durationUnit,
  symbol: symbol.symbol,
};

/**
 * Currency is intentionally only included when available.
 */
if (normalizedCurrency) {
  parameters.currency =
    normalizedCurrency;
}

return parameters;


}

/* ============================================================
APPLICATION SHUTDOWN
============================================================ */

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
