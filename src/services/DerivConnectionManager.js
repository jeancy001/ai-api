import WebSocket from "ws";
import { EventEmitter } from "events";
import { derivService } from "./DerivService.js";
export class DerivConnectionManager extends EventEmitter {
 constructor(){super();this.connections=new Map();this.pending=new Map();}
 async connect(accountId,accessToken){
   const existing=this.connections.get(accountId); if(existing?.readyState===WebSocket.OPEN)return existing;
   if(this.pending.has(accountId)) return this.pending.get(accountId);
   const task=(async()=>{const url=await derivService.websocketUrl(accountId,accessToken);const ws=new WebSocket(url);
     await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
     this.connections.set(accountId,ws);
     ws.on("message",raw=>this._onMessage(accountId,JSON.parse(raw.toString())));
     ws.on("close",()=>this.connections.delete(accountId));
     ws.on("error",()=>{});
     return ws;})();
   this.pending.set(accountId,task); try{return await task} finally{this.pending.delete(accountId)}
 }
 _onMessage(accountId,msg){
   if(msg.req_id&&this.pending.has(`${accountId}:${msg.req_id}`)){this.pending.get(`${accountId}:${msg.req_id}`)(msg);this.pending.delete(`${accountId}:${msg.req_id}`)}
   if(msg.msg_type==="balance") this.emit("balance",accountId,msg.balance);
   if(msg.msg_type==="tick") this.emit(`tick:${accountId}:${msg.echo_req?.ticks}`,msg.tick);
   if(msg.msg_type==="proposal_open_contract") this.emit("contract",accountId,msg.proposal_open_contract);
 }
 async request(accountId,accessToken,payload,timeout=15000){
   const ws=await this.connect(accountId,accessToken); const req_id=Date.now()+Math.floor(Math.random()*1000);
   return new Promise((resolve,reject)=>{const key=`${accountId}:${req_id}`;const timer=setTimeout(()=>{this.pending.delete(key);reject(new Error("Deriv request timeout"))},timeout);
     this.pending.set(key,msg=>{clearTimeout(timer);resolve(msg)}); ws.send(JSON.stringify({...payload,req_id}));
   });
 }
 closeAll(){for(const ws of this.connections.values())ws.close();this.connections.clear();}
}
export const derivConnectionManager=new DerivConnectionManager();
