import { ActivityLog } from "../models/ActivityLog.js";

const MAX_TYPE_LENGTH = 100;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 2_000;

/**
 * Convert values into JSON-safe data.
 *
 * This prevents logging failures caused by undefined values,
 * Error objects, MongoDB documents, BigInt values, or other
 * non-serializable metadata.
 */
function sanitizeMetadata(value, depth = 0) {
  if (depth > 5) {
    return "[MAX_DEPTH_REACHED]";
  }

  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
    };
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) =>
        sanitizeMetadata(item, depth + 1)
      );
  }

  if (typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      /**
       * Never accidentally store secrets in activity logs.
       */
      if (
        /token|password|secret|authorization|cookie/i.test(
          key
        )
      ) {
        result[key] = "[REDACTED]";
        continue;
      }

      const sanitized = sanitizeMetadata(
        item,
        depth + 1
      );

      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }

    return result;
  }

  return String(value);
}

/**
 * Normalize text before saving.
 */
function normalizeText(value, maxLength) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, maxLength);
}

/**
 * Record an application activity.
 *
 * IMPORTANT:
 * This function throws if logging fails. Use `logActivitySafe`
 * for non-critical events such as trading telemetry, where a
 * database logging failure must never interrupt the main action.
 */
export async function logActivity({
  userId,
  type,
  title,
  description,
  metadata = {},
}) {
  if (!userId) {
    throw new Error(
      "userId is required to log an activity"
    );
  }

  const normalizedType = normalizeText(
    type,
    MAX_TYPE_LENGTH
  );

  if (!normalizedType) {
    throw new Error(
      "Activity type is required"
    );
  }

  const normalizedTitle =
    normalizeText(title, MAX_TITLE_LENGTH) ||
    normalizedType;

  const normalizedDescription =
    normalizeText(
      description,
      MAX_DESCRIPTION_LENGTH
    );

  const safeMetadata =
    sanitizeMetadata(metadata) || {};

  return ActivityLog.create({
    userId: String(userId),
    type: normalizedType,
    title: normalizedTitle,
    description: normalizedDescription,
    metadata: safeMetadata,
  });
}

/**
 * Record an activity without allowing logging failures to break
 * the primary operation.
 *
 * Use this for:
 * - Auto-trading events
 * - Background workers
 * - WebSocket events
 * - Analytics and telemetry
 *
 * Do NOT use this when the activity itself is a mandatory business
 * operation that must be guaranteed.
 */
export async function logActivitySafe(input) {
  try {
    return await logActivity(input);
  } catch (error) {
    console.error(
      "Failed to write activity log:",
      {
        type: input?.type,
        userId: input?.userId
          ? String(input.userId)
          : undefined,
        error: error?.message || String(error),
      }
    );

    return null;
  }
}