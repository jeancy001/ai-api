import WebSocket from "ws";
import { EventEmitter } from "events";

import { derivService } from "./DerivService.js";
import { AppError } from "../utils/AppError.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * DerivConnectionManager
 *
 * Responsibilities:
 * - Maintain authenticated WebSocket connections per Deriv account.
 * - Correlate requests with responses using req_id.
 * - Forward subscription messages through EventEmitter.
 * - Reject pending requests when a connection closes or fails.
 *
 * IMPORTANT:
 * This manager does not decide whether a trade is allowed.
 * Trading authorization and risk checks remain in the trading services.
 */
export class DerivConnectionManager extends EventEmitter {
  constructor() {
    super();

    /**
     * accountId -> WebSocket
     */
    this.connections = new Map();

    /**
     * accountId -> Promise<WebSocket>
     *
     * Prevents multiple simultaneous connection attempts for the
     * same account.
     */
    this.connecting = new Map();

    /**
     * `${accountId}:${reqId}` -> { resolve, reject, timer }
     */
    this.requests = new Map();

    /**
     * Monotonically increasing request sequence.
     *
     * Date.now() alone can theoretically collide when requests are
     * generated within the same millisecond.
     */
    this.requestSequence = 0;
  }

  /**
   * Generate a unique request ID for this process.
   */
  nextRequestId() {
    this.requestSequence =
      (this.requestSequence + 1) % 1_000_000;

    return (
      Date.now() * 1_000_000 +
      this.requestSequence
    );
  }

  /**
   * Get a currently usable connection.
   */
  getConnection(accountId) {
    const ws = this.connections.get(String(accountId));

    if (!ws) return null;

    if (ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    return ws;
  }

  /**
   * Connect to Deriv for a specific account.
   *
   * Multiple callers for the same account share one connection attempt.
   */
  async connect(accountId, accessToken) {
    const normalizedAccountId = String(accountId);

    if (!normalizedAccountId) {
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

    const existing = this.getConnection(
      normalizedAccountId
    );

    if (existing) {
      return existing;
    }

    const connecting = this.connecting.get(
      normalizedAccountId
    );

    if (connecting) {
      return connecting;
    }

    const connectionTask = this.createConnection(
      normalizedAccountId,
      accessToken
    );

    this.connecting.set(
      normalizedAccountId,
      connectionTask
    );

    try {
      return await connectionTask;
    } finally {
      this.connecting.delete(
        normalizedAccountId
      );
    }
  }

  /**
   * Create and initialize a WebSocket connection.
   */
  async createConnection(accountId, accessToken) {
    const websocketUrl =
      await derivService.websocketUrl(
        accountId,
        accessToken
      );

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;

      const connectTimer = setTimeout(() => {
        if (settled) return;

        settled = true;

        try {
          ws?.terminate();
        } catch {
          // Ignore cleanup errors.
        }

        reject(
          new AppError(
            "Timed out while connecting to Deriv",
            504,
            "DERIV_CONNECTION_TIMEOUT"
          )
        );
      }, CONNECT_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) return;

        settled = true;
        clearTimeout(connectTimer);

        reject(
          error instanceof AppError
            ? error
            : new AppError(
                error?.message ||
                  "Unable to connect to Deriv",
                502,
                "DERIV_CONNECTION_ERROR"
              )
        );
      };

      try {
        ws = new WebSocket(websocketUrl);

        ws.once("open", () => {
          if (settled) return;

          settled = true;
          clearTimeout(connectTimer);

          this.connections.set(accountId, ws);

          this.emit("connected", accountId);

          resolve(ws);
        });

        /**
         * A connection error before opening rejects connect().
         * Errors after opening are handled by the persistent listener.
         */
        ws.once("error", fail);

        ws.on("message", (raw) => {
          try {
            const message = JSON.parse(
              raw.toString()
            );

            this.onMessage(accountId, message);
          } catch (error) {
            this.emit(
              "protocolError",
              accountId,
              error
            );
          }
        });

        ws.on("close", (code, reasonBuffer) => {
          const current =
            this.connections.get(accountId);

          /**
           * Do not delete a newer connection accidentally.
           */
          if (current === ws) {
            this.connections.delete(accountId);
          }

          const reason =
            reasonBuffer?.toString() ||
            `WebSocket closed (${code})`;

          this.rejectAccountRequests(
            accountId,
            new AppError(
              reason,
              502,
              "DERIV_CONNECTION_CLOSED"
            )
          );

          this.emit(
            "disconnected",
            accountId,
            { code, reason }
          );
        });

        ws.on("error", (error) => {
          this.emit(
            "connectionError",
            accountId,
            error
          );
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * Process a message received from Deriv.
   */
  onMessage(accountId, message) {
    /**
     * First resolve/reject the matching request.
     */
    if (
      message.req_id !== undefined &&
      message.req_id !== null
    ) {
      const key =
        `${accountId}:${message.req_id}`;

      const pending = this.requests.get(key);

      if (pending) {
        this.requests.delete(key);
        clearTimeout(pending.timer);

        if (message.error) {
          pending.reject(
            new AppError(
              message.error.message ||
                "Deriv request failed",
              400,
              message.error.code ||
                "DERIV_REQUEST_ERROR"
            )
          );
        } else {
          pending.resolve(message);
        }
      }
    }

    /**
     * Forward streaming/subscription data.
     */
    switch (message.msg_type) {
      case "balance":
        if (message.balance) {
          this.emit(
            "balance",
            accountId,
            message.balance
          );
        }
        break;

      case "tick":
        if (message.tick) {
          /**
           * Generic tick event.
           */
          this.emit(
            "tick",
            accountId,
            message.tick
          );

          /**
           * Symbol-specific event.
           */
          this.emit(
            `tick:${accountId}:${message.tick.symbol}`,
            message.tick
          );
        }
        break;

      case "proposal_open_contract":
        if (message.proposal_open_contract) {
          this.emit(
            "contract",
            accountId,
            message.proposal_open_contract
          );

          const contractId =
            message.proposal_open_contract
              .contract_id;

          if (contractId) {
            this.emit(
              `contract:${accountId}:${contractId}`,
              message.proposal_open_contract
            );
          }
        }
        break;

      default:
        /**
         * Allow future Deriv message types to be consumed without
         * changing this connection manager.
         */
        this.emit(
          "message",
          accountId,
          message
        );
    }
  }

  /**
   * Send one request and wait for the matching response.
   */
  async request(
    accountId,
    accessToken,
    payload,
    timeout = DEFAULT_TIMEOUT_MS
  ) {
    const normalizedAccountId =
      String(accountId);

    if (
      !payload ||
      typeof payload !== "object"
    ) {
      throw new AppError(
        "Deriv request payload is required",
        400,
        "DERIV_REQUEST_REQUIRED"
      );
    }

    const ws = await this.connect(
      normalizedAccountId,
      accessToken
    );

    if (ws.readyState !== WebSocket.OPEN) {
      throw new AppError(
        "Deriv connection is not ready",
        503,
        "DERIV_CONNECTION_NOT_READY"
      );
    }

    const reqId = this.nextRequestId();

    const key =
      `${normalizedAccountId}:${reqId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending =
          this.requests.get(key);

        if (!pending) return;

        this.requests.delete(key);

        reject(
          new AppError(
            "Deriv request timed out",
            504,
            "DERIV_REQUEST_TIMEOUT"
          )
        );
      }, timeout);

      this.requests.set(key, {
        resolve,
        reject,
        timer,
      });

      try {
        ws.send(
          JSON.stringify({
            ...payload,
            req_id: reqId,
          }),
          (error) => {
            if (!error) return;

            const pending =
              this.requests.get(key);

            if (!pending) return;

            this.requests.delete(key);
            clearTimeout(timer);

            reject(
              new AppError(
                error.message ||
                  "Failed to send request to Deriv",
                502,
                "DERIV_SEND_ERROR"
              )
            );
          }
        );
      } catch (error) {
        this.requests.delete(key);
        clearTimeout(timer);

        reject(
          new AppError(
            error?.message ||
              "Failed to send request to Deriv",
            502,
            "DERIV_SEND_ERROR"
          )
        );
      }
    });
  }

  /**
   * Reject all requests associated with one account.
   *
   * This prevents requests from waiting until their timeout after
   * the WebSocket has already disconnected.
   */
  rejectAccountRequests(accountId, error) {
    const prefix = `${accountId}:`;

    for (const [key, pending] of this.requests) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      this.requests.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * Close one account connection.
   *
   * This is safer than closing every user's connection when a single
   * user disconnects or stops trading.
   */
  close(accountId, reason = "Connection closed") {
    const normalizedAccountId =
      String(accountId);

    const ws =
      this.connections.get(normalizedAccountId);

    this.rejectAccountRequests(
      normalizedAccountId,
      new AppError(
        reason,
        503,
        "DERIV_CONNECTION_CLOSED"
      )
    );

    if (!ws) {
      return;
    }

    this.connections.delete(
      normalizedAccountId
    );

    try {
      ws.close();
    } catch {
      try {
        ws.terminate();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  /**
   * Close every active connection.
   *
   * Use only during graceful application shutdown.
   */
  closeAll(reason = "Application shutdown") {
    for (const accountId of [
      ...this.connections.keys(),
    ]) {
      this.close(accountId, reason);
    }

    for (const [key, pending] of this.requests) {
      this.requests.delete(key);
      clearTimeout(pending.timer);

      pending.reject(
        new AppError(
          reason,
          503,
          "DERIV_APPLICATION_SHUTDOWN"
        )
      );
    }
  }
}

export const derivConnectionManager =
  new DerivConnectionManager();