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
    this.locks = new Set();

    /**
     * Active trading engines.
     *
     * Map<userId, {
     *   timer,
     *   running
     * }>
     */
    this.engines = new Map();
  }

  /**
   * Start the user's trading engine.
   *
   * This method only starts the scheduler.
   * Every individual cycle independently validates:
   * - account
   * - authorization
   * - emergency stop
   * - risk rules
   */
  async start(userId) {
    const id = String(userId);

    if (this.engines.has(id)) {
      return {
        started: false,
        reason: "ALREADY_RUNNING",
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
        "Emergency stop is active"
      );
    }

    const configuredInterval = Number(
      settings.tradingIntervalMs
    );

    const interval = Number.isFinite(configuredInterval)
      ? Math.max(configuredInterval, MIN_INTERVAL)
      : DEFAULT_INTERVAL;

    const engine = {
      timer: null,
      running: false,
    };

    this.engines.set(id, engine);

    const executeCycle = async () => {
      if (engine.running) return;

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
     * Run the first validation cycle immediately.
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
   * Stop the user's trading engine.
   *
   * Database safety flags are handled by the controller before
   * this method is called.
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

    if (engine.timer) {
      clearInterval(engine.timer);
    }

    this.engines.delete(id);

    return {
      stopped: true,
      reason,
    };
  }

  /**
   * Execute one cycle using the selected account's stored token.
   */
  async runUserCycle(userId) {
    const account = await DerivAccount.findOne({
      userId: String(userId),
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
        "Unable to decrypt Deriv access token:",
        error?.message || error
      );

      return {
        skipped: true,
        reason: "DERIV_ACCESS_TOKEN_INVALID",
      };
    }

    return this.runOnce({
      userId: String(userId),
      accessToken,
    });
  }

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

      /**
       * SAFETY CHECKS ON EVERY CYCLE.
       *
       * Never rely only on the controller's checks.
       */
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

      if (!settings.selectedMarket) {
        return {
          skipped: true,
          reason: "MARKET_NOT_SELECTED",
        };
      }

      /**
       * Verify that the market exists before requesting prices.
       */
      const symbol = await derivMarketService.symbol(
        settings.selectedMarket
      );

      if (!symbol) {
        return {
          skipped: true,
          reason: "MARKET_UNAVAILABLE",
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
          settings.selectedMarket
        ),
      ]);

      if (!balance?.balance) {
        return {
          skipped: true,
          reason: "BALANCE_UNAVAILABLE",
        };
      }

      if (!market?.quote) {
        return {
          skipped: true,
          reason: "MARKET_DATA_UNAVAILABLE",
        };
      }

      /**
       * AI is analysis only.
       * It does not receive authority to execute trades.
       */
      const analysis =
        await geminiTradingService.analyze({
          symbol: settings.selectedMarket,
          currentPrice: Number(market.quote),
          currency: balance.currency,
          timestamp: new Date().toISOString(),
        });

      const confidenceThreshold = Number(
        settings.aiConfidenceThreshold ?? 0.7
      );

      if (
        Number(analysis.confidence) <
        confidenceThreshold
      ) {
        return {
          skipped: true,
          reason: "AI_CONFIDENCE_TOO_LOW",
          analysis,
        };
      }

      /**
       * Independent strategy validation.
       */
      const strategy =
        tradingStrategyService.validate(
          analysis,
          market
        );

      if (!strategy.approved) {
        return {
          skipped: true,
          reason:
            strategy.reasons?.[0] ||
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

      /**
       * Final risk gate before any execution.
       */
      const risk =
        await riskManagementService.evaluate({
          settings,
          balance: Number(balance.balance),
          userId: id,
          accountId: account.derivAccountId,
          stake,
        });

      if (!risk.approved) {
        return {
          skipped: true,
          reason:
            risk.reasons?.[0] ||
            "RISK_REJECTED",
          risk,
        };
      }

      /**
       * IMPORTANT:
       *
       * Do not allow Gemini to invent arbitrary Deriv contract
       * parameters. The backend must explicitly define and validate
       * the contract configuration.
       *
       * Until your TradingSettings model contains validated contract
       * fields, no real trade should be executed.
       */
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

      /**
       * Final database safety check immediately before purchase.
       */
      const finalSettings =
        await TradingSettings.findOne({
          userId: id,
        }).lean();

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

      const purchase =
        await tradeExecutionService.buy({
          accountId: account.derivAccountId,
          token: accessToken,
          proposalId: proposal.id,
          price: Number(proposal.ask_price),
        });

      const trade =
        await tradeExecutionService.record({
          userId: id,
          derivAccountId: account.derivAccountId,
          derivContractId: String(
            purchase.contract_id ||
              purchase.contract_id ||
              ""
          ),
          market: settings.selectedMarket,
          action: analysis.action,
          stake,
          currency: balance.currency,
          status: "open",
          entryPrice: Number(market.quote),
          openedAt: new Date(),
          metadata: {
            aiConfidence: analysis.confidence,
            aiReason: analysis.reason,
          },
        });

      return {
        skipped: false,
        executed: true,
        tradeId: trade._id,
        analysis,
        risk,
      };
    } finally {
      this.locks.delete(id);
    }
  }

  /**
   * Build contract parameters only from explicitly configured,
   * backend-approved settings.
   *
   * Return null if the configuration is incomplete.
   */
  buildContractParameters({
    settings,
    analysis,
    symbol,
  }) {
    const contractType =
      settings.contractType;

    const duration = Number(
      settings.contractDuration
    );

    const durationUnit =
      settings.contractDurationUnit;

    if (
      !contractType ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !durationUnit
    ) {
      return null;
    }

    /**
     * These values must correspond to the fields supported by
     * your Deriv contract configuration.
     */
    return {
      amount: Number(settings.stake),
      basis: settings.stakeBasis || "stake",
      contract_type: contractType,
      currency: settings.currency || "USD",
      duration,
      duration_unit: durationUnit,
      symbol: symbol.symbol,
    };
  }

  /**
   * Stop every local engine.
   * Useful during graceful application shutdown.
   */
  async stopAll(reason = "APPLICATION_SHUTDOWN") {
    const userIds = [...this.engines.keys()];

    await Promise.all(
      userIds.map((userId) =>
        this.stop(userId, reason)
      )
    );
  }
}

export const autoTradingService =
  new AutoTradingService();