import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "../config/env.js";
const schema=z.object({action:z.enum(["BUY","SELL","HOLD"]),confidence:z.number().min(0).max(1),market:z.string(),reason:z.string().min(1).max(1000),recommendedParameters:z.record(z.any()).default({})});
export class GeminiTradingService {
 constructor(){this.client=new GoogleGenerativeAI(env.GEMINI_API_KEY)}
 async analyze(context){const model=this.client.getGenerativeModel({model:env.GEMINI_MODEL,generationConfig:{responseMimeType:"application/json"}});
 const prompt=`You are a market-analysis component. You DO NOT execute trades. Analyze only the supplied data and return JSON with action BUY, SELL, or HOLD; confidence 0..1; market; reason; recommendedParameters. Never claim certainty. Data: ${JSON.stringify(context)}`;
 const result=await model.generateContent(prompt);let parsed;try{parsed=JSON.parse(result.response.text())}catch{throw new Error("Gemini returned invalid JSON")}return schema.parse(parsed);}
}
export const geminiTradingService=new GeminiTradingService();
