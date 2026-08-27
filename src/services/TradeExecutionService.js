import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";
export class TradeExecutionService {
 async proposal(accountId,token,params){const msg=await derivConnectionManager.request(accountId,token,{proposal:1,...params});if(!msg.proposal)throw new Error("Deriv did not return a proposal");return msg.proposal}
 async buy({accountId,token,proposalId,price}){const msg=await derivConnectionManager.request(accountId,token,{buy:proposalId,price});if(!msg.buy)throw new Error("Deriv did not return a purchase");return msg.buy}
 async record(input){return Trade.create(input)}
}
export const tradeExecutionService=new TradeExecutionService();
