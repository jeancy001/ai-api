import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development","test","production"]).default("development"),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("7d"),
  DERIV_CLIENT_ID: z.string().min(1),
  DERIV_APP_ID: z.string().min(1),
  DERIV_REDIRECT_URI: z.string().url(),
  DERIV_API_BASE_URL: z.string().url().default("https://api.derivws.com"),
  DERIV_OAUTH_AUTHORIZE_URL: z.string().url().default("https://auth.deriv.com/oauth2/auth"),
  DERIV_OAUTH_TOKEN_URL: z.string().url().default("https://auth.deriv.com/oauth2/token"),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().default("false").transform(v => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(16),
  FRONTEND_URL: z.string().url(),
  OAUTH_SCOPES: z.string().default("trade")
});
export const env = schema.parse(process.env);
