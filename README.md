# Deriv AI Trading Backend

Production-oriented Node.js, Express and MongoDB backend for a user-authorized real Deriv Options account.

## Important
This project never invents balances, markets, proposals, or trades. Real account data comes from Deriv. Gemini produces structured analysis only; deterministic backend checks control execution.

## Current Deriv architecture used
1. OAuth 2.0 Authorization Code + PKCE.
2. `GET /trading/v1/options/accounts` to list available Options accounts.
3. User explicitly selects an account whose API metadata says `account_type: real`.
4. `POST /trading/v1/options/accounts/{accountId}/otp` obtains a short-lived authenticated WebSocket URL.
5. The authenticated WebSocket is used for `balance`, `portfolio`, proposals, buys and contract monitoring.
6. `active_symbols` and public/authenticated market-data WebSocket calls supply live market information.

Deriv APIs evolve. Before production deployment, review the current schemas/docs and test with the exact account and contract types you intend to support.

## Setup
```bash
cp .env.example .env
npm install
npm run dev
```

Create a MongoDB database and register a Deriv OAuth application. Configure the exact registered redirect URI.

## Security
Never put Deriv OAuth tokens, PATs, OTP URLs, SMTP passwords, Gemini keys, or JWT secrets in the frontend or source control.

## Trading
Auto-trading starts only after:
- a real account is selected,
- real trading is explicitly authorized,
- auto-trading is explicitly enabled,
- emergency stop is off,
- deterministic risk checks approve,
- a fresh Gemini response passes schema validation,
- Deriv returns a valid proposal.

The default strategy intentionally returns HOLD unless a deterministic signal is present.
# api-ai
# ai-api
