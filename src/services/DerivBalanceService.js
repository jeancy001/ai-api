import { derivConnectionManager } from "./DerivConnectionManager.js";
import { DerivAccount } from "../models/DerivAccount.js";
export class DerivBalanceService {
 constructor(){derivConnectionManager.on("balance",(id,b)=>this.persist(id,b).catch(()=>{}))}
 async get(accountId,token,{subscribe=false}={}){const msg=await derivConnectionManager.request(accountId,token,{balance:1,subscribe:subscribe?1:undefined});
   if(msg.balance) await this.persist(accountId,msg.balance); return msg.balance;}
 async persist(accountId,balance){await DerivAccount.updateOne({derivAccountId:accountId},{lastKnownBalance:Number(balance.balance),lastBalanceUpdatedAt:new Date(),currency:balance.currency,connectionStatus:"connected"});}
}
export const derivBalanceService=new DerivBalanceService();
