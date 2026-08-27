import { env } from "../config/env.js";
import { pkceChallenge,randomUrlSafe } from "../utils/crypto.js";
import { AppError } from "../utils/AppError.js";
export class DerivAuthService {
 createAuthorization(){const state=randomUrlSafe(32),verifier=randomUrlSafe(64),challenge=pkceChallenge(verifier);
  const url=new URL(env.DERIV_OAUTH_AUTHORIZE_URL);Object.entries({response_type:"code",client_id:env.DERIV_CLIENT_ID,redirect_uri:env.DERIV_REDIRECT_URI,scope:env.OAUTH_SCOPES,state,code_challenge:challenge,code_challenge_method:"S256",app_id:env.DERIV_APP_ID}).forEach(([k,v])=>url.searchParams.set(k,v));return{state,verifier,url:url.toString()}}
 async exchange(code,verifier){const body=new URLSearchParams({grant_type:"authorization_code",client_id:env.DERIV_CLIENT_ID,code,code_verifier:verifier,redirect_uri:env.DERIV_REDIRECT_URI});
  const r=await fetch(env.DERIV_OAUTH_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data=await r.json();if(!r.ok||!data.access_token)throw new AppError("Deriv OAuth token exchange failed",400,"DERIV_OAUTH_ERROR");return data;}
}
export const derivAuthService=new DerivAuthService();
