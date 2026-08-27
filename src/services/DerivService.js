import WebSocket from "ws";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

export class DerivService {
  async listAccounts(accessToken) {
    const r=await fetch(`${env.DERIV_API_BASE_URL}/trading/v1/options/accounts`,{headers:{
      "Deriv-App-ID":env.DERIV_APP_ID,Authorization:`Bearer ${accessToken}`}});
    const body=await r.json();
    if(!r.ok) throw new AppError(body?.errors?.[0]?.message||"Unable to retrieve Deriv accounts",r.status,"DERIV_ACCOUNTS_ERROR");
    return Array.isArray(body.data)?body.data:[body.data].filter(Boolean);
  }
  async websocketUrl(accountId,accessToken) {
    const r=await fetch(`${env.DERIV_API_BASE_URL}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,{
      method:"POST",headers:{"Deriv-App-ID":env.DERIV_APP_ID,Authorization:`Bearer ${accessToken}`}});
    const body=await r.json();
    if(!r.ok||!body?.data?.url) throw new AppError(body?.errors?.[0]?.message||"Unable to create Deriv WebSocket session",r.status||502,"DERIV_OTP_ERROR");
    return body.data.url;
  }
  async request(wsUrl,payload,timeout=15000) {
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(wsUrl); const timer=setTimeout(()=>{ws.close();reject(new AppError("Deriv WebSocket timeout",504,"DERIV_TIMEOUT"))},timeout);
      ws.on("open",()=>ws.send(JSON.stringify({...payload,req_id:Date.now()})));
      ws.on("message",raw=>{const msg=JSON.parse(raw.toString()); if(msg.error){clearTimeout(timer);ws.close();return reject(new AppError(msg.error.message,400,msg.error.code||"DERIV_ERROR"))} clearTimeout(timer);ws.close();resolve(msg)});
      ws.on("error",e=>{clearTimeout(timer);reject(e)});
    });
  }
}
export const derivService=new DerivService();
