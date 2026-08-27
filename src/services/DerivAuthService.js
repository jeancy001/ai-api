import { env } from "../config/env.js";
import {
  pkceChallenge,
  randomUrlSafe,
} from "../utils/crypto.js";
import { AppError } from "../utils/AppError.js";

/**
 * Deriv OAuth authentication service.
 *
 * Responsibilities:
 * - Create a secure OAuth authorization URL using PKCE.
 * - Exchange an authorization code for access/refresh tokens.
 *
 * OAuth state storage and validation belongs to the controller because
 * it is tied to the authenticated application user and callback flow.
 */
export class DerivAuthService {
  /**
   * Create a new OAuth authorization request.
   *
   * PKCE protects the authorization code exchange, while `state`
   * protects against cross-site request forgery when it is validated
   * by the callback controller.
   */
  createAuthorization() {
    this.validateAuthorizationConfig();

    const state = randomUrlSafe(32);
    const verifier = randomUrlSafe(64);
    const challenge = pkceChallenge(verifier);

    if (!state || !verifier || !challenge) {
      throw new AppError(
        "Unable to initialize secure Deriv authorization",
        500,
        "DERIV_OAUTH_INITIALIZATION_FAILED"
      );
    }

    let url;

    try {
      url = new URL(env.DERIV_OAUTH_AUTHORIZE_URL);
    } catch {
      throw new AppError(
        "Deriv OAuth authorization URL is invalid",
        500,
        "DERIV_OAUTH_CONFIG_INVALID"
      );
    }

    /**
     * Required OAuth parameters.
     */
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "client_id",
      String(env.DERIV_CLIENT_ID)
    );
    url.searchParams.set(
      "redirect_uri",
      String(env.DERIV_REDIRECT_URI)
    );
    url.searchParams.set(
      "state",
      state
    );
    url.searchParams.set(
      "code_challenge",
      challenge
    );
    url.searchParams.set(
      "code_challenge_method",
      "S256"
    );

    /**
     * Add scopes only when configured.
     */
    if (env.OAUTH_SCOPES) {
      url.searchParams.set(
        "scope",
        String(env.OAUTH_SCOPES)
      );
    }

    /**
     * Keep app_id separate because some Deriv endpoints require it.
     * Only include it when configured.
     */
    if (env.DERIV_APP_ID) {
      url.searchParams.set(
        "app_id",
        String(env.DERIV_APP_ID)
      );
    }

    return {
      state,
      verifier,
      url: url.toString(),
    };
  }

  /**
   * Exchange a Deriv authorization code for OAuth tokens.
   */
  async exchange(code, verifier) {
    this.validateTokenConfig();

    if (
      typeof code !== "string" ||
      code.trim().length === 0
    ) {
      throw new AppError(
        "Authorization code is required",
        400,
        "DERIV_AUTHORIZATION_CODE_REQUIRED"
      );
    }

    if (
      typeof verifier !== "string" ||
      verifier.trim().length === 0
    ) {
      throw new AppError(
        "PKCE verifier is required",
        400,
        "DERIV_PKCE_VERIFIER_REQUIRED"
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: String(env.DERIV_CLIENT_ID),
      code: code.trim(),
      code_verifier: verifier,
      redirect_uri: String(env.DERIV_REDIRECT_URI),
    });

    let response;

    try {
      response = await fetch(
        env.DERIV_OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: body.toString(),
        }
      );
    } catch (error) {
      throw new AppError(
        "Unable to connect to Deriv authorization service",
        502,
        "DERIV_OAUTH_NETWORK_ERROR"
      );
    }

    /**
     * Safely parse the response. Do not assume every error response
     * is valid JSON.
     */
    let data;

    try {
      data = await response.json();
    } catch {
      throw new AppError(
        "Deriv returned an invalid OAuth response",
        502,
        "DERIV_OAUTH_INVALID_RESPONSE"
      );
    }

    if (!response.ok || !data?.access_token) {
      /**
       * Do not expose raw provider responses containing potentially
       * sensitive information.
       */
      const providerMessage =
        typeof data?.error_description === "string"
          ? data.error_description
          : typeof data?.error?.message === "string"
            ? data.error.message
            : typeof data?.message === "string"
              ? data.message
              : "Deriv OAuth token exchange failed";

      throw new AppError(
        providerMessage,
        response.status >= 400 &&
        response.status < 500
          ? 400
          : 502,
        "DERIV_OAUTH_ERROR"
      );
    }

    const expiresIn = Number(data.expires_in);

    return {
      access_token: data.access_token,

      refresh_token:
        data.refresh_token || null,

      token_type:
        data.token_type || "Bearer",

      expires_in:
        Number.isFinite(expiresIn) &&
        expiresIn > 0
          ? expiresIn
          : null,

      scope:
        data.scope || null,
    };
  }

  /**
   * Validate configuration required to create an authorization URL.
   */
  validateAuthorizationConfig() {
    const required = [
      "DERIV_OAUTH_AUTHORIZE_URL",
      "DERIV_CLIENT_ID",
      "DERIV_REDIRECT_URI",
    ];

    this.validateConfig(required);
  }

  /**
   * Validate configuration required to exchange an authorization code.
   */
  validateTokenConfig() {
    const required = [
      "DERIV_OAUTH_TOKEN_URL",
      "DERIV_CLIENT_ID",
      "DERIV_REDIRECT_URI",
    ];

    this.validateConfig(required);
  }

  /**
   * Fail early when production configuration is incomplete.
   */
  validateConfig(keys) {
    const missing = keys.filter(
      (key) =>
        env[key] === undefined ||
        env[key] === null ||
        String(env[key]).trim() === ""
    );

    if (missing.length > 0) {
      console.error(
        "Missing Deriv OAuth configuration:",
        missing.join(", ")
      );

      throw new AppError(
        "Deriv OAuth service is not configured correctly",
        500,
        "DERIV_OAUTH_CONFIG_MISSING"
      );
    }
  }
}

export const derivAuthService =
  new DerivAuthService();