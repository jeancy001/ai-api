import crypto from "crypto";
import { env } from "../config/env.js";

const key = crypto.createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();
export const randomUrlSafe = (bytes=32) => crypto.randomBytes(bytes).toString("base64url");
export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
export function encrypt(value) {
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decrypt(value) {
  const [ivB,tagB,dataB]=value.split(".");
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(ivB,"base64url"));
  decipher.setAuthTag(Buffer.from(tagB,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB,"base64url")),decipher.final()]).toString("utf8");
}
