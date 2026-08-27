import { Trade } from "../models/Trade.js";
export class RiskManagementService {
 async evaluate({settings,balance,userId,accountId,stake}){
  const reasons=[];if(!settings.autoTradingEnabled)reasons.push("AUTO_TRADING_DISABLED");
  if(!settings.realTradingAuthorized)reasons.push("REAL_TRADING_NOT_AUTHORIZED");
  if(settings.emergencyStop)reasons.push("EMERGENCY_STOP_ACTIVE");
  if(balance<settings.minimumBalance)reasons.push("MINIMUM_BALANCE_PROTECTION");
  if(stake>settings.maxStake)reasons.push("MAX_STAKE_EXCEEDED");
  const start=new Date();start.setHours(0,0,0,0);
  const trades=await Trade.find({userId,derivAccountId:accountId,createdAt:{$gte:start}});
  if(trades.length>=settings.maxDailyTrades)reasons.push("MAX_DAILY_TRADES_REACHED");
  const dailyLoss=trades.filter(t=>(t.profitLoss??0)<0).reduce((n,t)=>n+Math.abs(t.profitLoss),0);
  if(dailyLoss>=settings.maxDailyLoss)reasons.push("DAILY_LOSS_LIMIT_REACHED");
  let losses=0;for(const t of [...trades].reverse()){if((t.profitLoss??0)<0)losses++;else if(t.status==="closed")break;}
  if(losses>=settings.maxConsecutiveLosses)reasons.push("MAX_CONSECUTIVE_LOSSES_REACHED");
  const open=await Trade.exists({userId,derivAccountId:accountId,status:{$in:["pending","open"]}});
  if(open)reasons.push("CONFLICTING_OPEN_TRADE");
  return {approved:reasons.length===0,reasons,limits:{dailyLoss,tradeCount:trades.length,consecutiveLosses:losses}};
 }
}
export const riskManagementService=new RiskManagementService();
