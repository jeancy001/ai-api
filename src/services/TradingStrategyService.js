export class TradingStrategyService {
 validate(signal,market){if(!market?.quote)return {approved:false,reasons:["NO_FRESH_MARKET_DATA"]};if(signal.action==="HOLD")return {approved:false,reasons:["AI_HOLD"]};return {approved:true,reasons:[]};}
}
export const tradingStrategyService=new TradingStrategyService();
