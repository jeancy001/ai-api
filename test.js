import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**

* ============================================================
* GEMINI CONNECTION TEST
* ============================================================
*
* Run:
* node test.js
*
* Required in .env:
* GEMINI_API_KEY=your_gemini_api_key
* GEMINI_MODEL=gemini-3.6-flash
  */

async function testGemini() {
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
console.error("❌ GEMINI_API_KEY is missing in your .env file.");
process.exitCode = 1;
return;
}

try {
console.log("🔄 Testing Gemini connection...\n");


const genAI = new GoogleGenerativeAI(apiKey);

const modelName =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

console.log(`🤖 Using model: ${modelName}`);

const model = genAI.getGenerativeModel({
  model: modelName,
});

const result = await model.generateContent(
  "Reply with exactly: Gemini connection is working."
);

const response = await result.response;
const text = response.text();

if (!text?.trim()) {
  throw new Error("Gemini returned an empty response.");
}

console.log("\n✅ Gemini is connected and working!");
console.log(`🤖 Response: ${text.trim()}`);


} catch (error) {
console.error("\n❌ Gemini connection test failed.");


if (error instanceof Error) {
  console.error(`Message: ${error.message}`);
} else {
  console.error(error);
}

process.exitCode = 1;


}
}

testGemini();
