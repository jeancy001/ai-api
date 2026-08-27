import { derivConnectionManager } from "./DerivConnectionManager.js";
export class MarketDataService {
 constructor(){this.ticks=new Map();derivConnectionManager.on("tick",(accountId,tick)=>{this.ticks.set(`${accountId}:${tick.symbol}`,tick)})}
 async latest(accountId,token,symbol){const msg=await derivConnectionManager.request(accountId,token,{ticks:symbol,subscribe:1});const tick=msg.tick;if(tick)this.ticks.set(`${accountId}:${symbol}`,tick);return tick;}
}
export const marketDataService=new MarketDataService();
