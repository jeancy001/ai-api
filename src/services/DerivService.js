import WebSocket from "ws";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

const HTTP_TIMEOUT_MS = 15_000;
const WS_TIMEOUT_MS = 15_000;

/**
 * Safely parse a JSON HTTP response.
 */
async function parseJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Extract a useful error message from Deriv responses.
 */
function getDerivErrorMessage(
  body,
  fallback
) {
  return (
    body?.errors?.[0]?.message ||
    body?.error?.message ||
    body?.message ||
    fallback
  );
}

/**
 * Create an HTTP request with a timeout.
 */
async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = HTTP_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(
        "Deriv API request timed out",
        504,
        "DERIV_HTTP_TIMEOUT"
      );
    }

    throw new AppError(
      error?.message ||
        "Unable to connect to the Deriv API",
      502,
      "DERIV_NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a request ID suitable for matching one request
 * to one WebSocket response.
 */
function createRequestId() {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Deriv API Service
 *
 * Responsibilities:
 * - Retrieve authorized Deriv accounts.
 * - Create short-lived WebSocket session URLs.
 * - Perform one-off WebSocket requests.
 *
 * Persistent WebSocket connections should normally be handled by
 * DerivConnectionManager, not by this service.
 */
export class DerivService {
  /**
   * Retrieve accounts available to the OAuth access token.
   */
  async listAccounts(accessToken) {
    if (!accessToken) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_ACCESS_TOKEN_REQUIRED"
      );
    }

    const response = await fetchWithTimeout(
      `${env.DERIV_API_BASE_URL}/trading/v1/options/accounts`,
      {
        headers: {
          "Deriv-App-ID": env.DERIV_APP_ID,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    const body =
      await parseJsonResponse(response);

    if (!response.ok) {
      throw new AppError(
        getDerivErrorMessage(
          body,
          "Unable to retrieve Deriv accounts"
        ),
        response.status || 502,
        "DERIV_ACCOUNTS_ERROR"
      );
    }

    const accounts = body?.data;

    if (!accounts) {
      return [];
    }

    return Array.isArray(accounts)
      ? accounts
      : [accounts];
  }

  /**
   * Create a temporary WebSocket URL for a specific account.
   *
   * The returned URL must be treated as sensitive and should never
   * be returned to the frontend or written to normal application logs.
   */
  async websocketUrl(accountId, accessToken) {
    if (!accountId) {
      throw new AppError(
        "Deriv account ID is required",
        400,
        "DERIV_ACCOUNT_ID_REQUIRED"
      );
    }

    if (!accessToken) {
      throw new AppError(
        "Deriv access token is required",
        401,
        "DERIV_ACCESS_TOKEN_REQUIRED"
      );
    }

    const encodedAccountId =
      encodeURIComponent(String(accountId));

    const response = await fetchWithTimeout(
      `${env.DERIV_API_BASE_URL}/trading/v1/options/accounts/${encodedAccountId}/otp`,
      {
        method: "POST",

        headers: {
          "Deriv-App-ID": env.DERIV_APP_ID,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    const body =
      await parseJsonResponse(response);

    const url = body?.data?.url;

    if (!response.ok || !url) {
      throw new AppError(
        getDerivErrorMessage(
          body,
          "Unable to create Deriv WebSocket session"
        ),
        response.status || 502,
        "DERIV_OTP_ERROR"
      );
    }

    try {
      const parsedUrl = new URL(url);

      if (
        parsedUrl.protocol !== "wss:" &&
        parsedUrl.protocol !== "ws:"
      ) {
        throw new Error(
          "Invalid WebSocket protocol"
        );
      }
    } catch {
      throw new AppError(
        "Deriv returned an invalid WebSocket URL",
        502,
        "DERIV_INVALID_WS_URL"
      );
    }

    return url;
  }

  /**
   * Perform a single WebSocket request.
   *
   * For streaming data or multiple requests, use
   * DerivConnectionManager instead.
   */
  async request(
    wsUrl,
    payload,
    timeoutMs = WS_TIMEOUT_MS
  ) {
    if (!wsUrl) {
      throw new AppError(
        "WebSocket URL is required",
        400,
        "DERIV_WS_URL_REQUIRED"
      );
    }

    if (
      !payload ||
      typeof payload !== "object"
    ) {
      throw new AppError(
        "Deriv request payload is required",
        400,
        "DERIV_REQUEST_INVALID"
      );
    }

    const requestId = createRequestId();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let ws = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        if (
          ws &&
          (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
          )
        ) {
          try {
            ws.close();
          } catch {
            // Ignore cleanup errors.
          }
        }
      };

      const finish = (error, value) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      try {
        ws = new WebSocket(wsUrl);

        timer = setTimeout(() => {
          finish(
            new AppError(
              "Deriv WebSocket request timed out",
              504,
              "DERIV_TIMEOUT"
            )
          );
        }, timeoutMs);

        ws.once("open", () => {
          if (settled) {
            return;
          }

          try {
            ws.send(
              JSON.stringify({
                ...payload,
                req_id: requestId,
              })
            );
          } catch (error) {
            finish(
              new AppError(
                error?.message ||
                  "Unable to send Deriv request",
                502,
                "DERIV_WS_SEND_ERROR"
              )
            );
          }
        });

        ws.on("message", (raw) => {
          if (settled) {
            return;
          }

          let message;

          try {
            message = JSON.parse(
              raw.toString()
            );
          } catch {
            return finish(
              new AppError(
                "Deriv returned invalid WebSocket data",
                502,
                "DERIV_INVALID_WS_RESPONSE"
              )
            );
          }

          /**
           * Ignore messages belonging to another request.
           */
          if (
            message.req_id !== undefined &&
            String(message.req_id) !==
              String(requestId)
          ) {
            return;
          }

          if (message.error) {
            return finish(
              new AppError(
                message.error.message ||
                  "Deriv request failed",
                400,
                message.error.code ||
                  "DERIV_ERROR"
              )
            );
          }

          return finish(null, message);
        });

        ws.once("error", (error) => {
          finish(
            new AppError(
              error?.message ||
                "Deriv WebSocket connection failed",
              502,
              "DERIV_WS_ERROR"
            )
          );
        });

        ws.once("close", () => {
          if (!settled) {
            finish(
              new AppError(
                "Deriv WebSocket connection closed unexpectedly",
                502,
                "DERIV_WS_CLOSED"
              )
            );
          }
        });
      } catch (error) {
        finish(
          error instanceof AppError
            ? error
            : new AppError(
                error?.message ||
                  "Unable to initialize Deriv WebSocket",
                502,
                "DERIV_WS_INITIALIZATION_ERROR"
              )
        );
      }
    });
  }
}

export const derivService = new DerivService();