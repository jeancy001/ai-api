import { derivConnectionManager } from "./DerivConnectionManager.js";
import { Trade } from "../models/Trade.js";
export class TradeMonitoringService {
 async monitor(accountId,token,contractId){const msg=await derivConnectionManager.request(accountId,token,{proposal_open_contract:1,contract_id:contractId,subscribe:1});return msg.proposal_open_contract}
 async apply(contract){if(!contract?.contract_id)return;const update={};if(contract.is_sold){update.status="closed";update.profitLoss=Number(contract.profit);update.closedAt=new Date();}await Trade.updateOne({derivContractId:String(contract.contract_id)},{$set:update});}
}
export const tradeMonitoringService=new TradeMonitoringService();
