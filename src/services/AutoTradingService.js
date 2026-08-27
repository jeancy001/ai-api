import { DerivAccount } from "../models/DerivAccount.js";
import { TradingSettings } from "../models/TradingSettings.js";
import { derivBalanceService } from "./DerivBalanceService.js";
import { derivMarketService } from "./DerivMarketService.js";
import { marketDataService } from "./MarketDataService.js";
import { geminiTradingService } from "./GeminiTradingService.js";
import { tradingStrategyService } from "./TradingStrategyService.js";
import { riskManagementService } from "./RiskManagementService.js";
import { tradeExecutionService } from "./TradeExecutionService.js";
export class AutoTradingService {
 constructor(){this.locks=new Set()}
 async runOnce({userId,accessToken}){
  if(this.locks.has(String(userId)))return {skipped:true,reason:"RUN_ALREADY_IN_PROGRESS"};this.locks.add(String(userId));
  try{const account=await DerivAccount.findOne({userId,selected:true,accountType:"real"});const settings=await TradingSettings.findOne({userId});if(!account||!settings)return {skipped:true,reason:"ACCOUNT_OR_SETTINGS_MISSING"};
   const balance=await derivBalanceService.get(account.derivAccountId,accessToken);const market=await marketDataService.latest(account.derivAccountId,accessToken,settings.selectedMarket);
   const analysis=await geminiTradingService.analyze({symbol:settings.selectedMarket,currentPrice:market?.quote,currency:balance.currency,timestamp:new Date().toISOString()});
   if(analysis.confidence<settings.aiConfidenceThreshold)return {skipped:true,reason:"AI_CONFIDENCE_TOO_LOW",analysis};
   const strategy=tradingStrategyService.validate(analysis,market);if(!strategy.approved)return {skipped:true,reason:strategy.reasons[0],analysis};
   const symbol=await derivMarketService.symbol(settings.selectedMarket);if(!symbol)return {skipped:true,reason:"MARKET_UNAVAILABLE"};
   const risk=await riskManagementService.evaluate({settings,balance:Number(balance.balance),userId,accountId:account.derivAccountId,stake:settings.stake});if(!risk.approved)return {skipped:true,reason:risk.reasons[0],risk};
   // Contract parameters are intentionally explicit and must be configured by the caller/UI; no hidden strategy assumptions.
   return {skipped:true,reason:"CONTRACT_PARAMETERS_REQUIRED",analysis,risk};
  }finally{this.locks.delete(String(userId))}}
}
export const autoTradingService=new AutoTradingService();
