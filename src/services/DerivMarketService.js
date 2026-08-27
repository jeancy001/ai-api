import WebSocket from "ws";
import { AppError } from "../utils/AppError.js";
const PUBLIC="wss://api.derivws.com/trading/v1/options/ws/public";
function once(payload){return new Promise((resolve,reject)=>{const ws=new WebSocket(PUBLIC);const timer=setTimeout(()=>{ws.close();reject(new AppError("Market request timeout",504))},15000);
 ws.on("open",()=>ws.send(JSON.stringify(payload)));ws.on("message",raw=>{const msg=JSON.parse(raw);if(msg.error){clearTimeout(timer);ws.close();return reject(new AppError(msg.error.message,400,msg.error.code))}clearTimeout(timer);ws.close();resolve(msg)});ws.on("error",reject);});}
export class DerivMarketService {
 async activeSymbols(){return (await once({active_symbols:"full"})).active_symbols||[]}
 async symbol(symbol){const all=await this.activeSymbols();return all.find(s=>s.symbol===symbol)||null}
 async contractsFor(symbol){const all=await this.activeSymbols();return all.filter(s=>s.symbol===symbol)}
}
export const derivMarketService=new DerivMarketService();
