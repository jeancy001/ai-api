import { ActivityLog } from "../models/ActivityLog.js";

/**
 * Record an application activity.
 *
 * This service is intentionally centralized so authentication,
 * Deriv connection, and trading activities use the same format.
 */
export async function logActivity({
  userId,
  type,
  title,
  description,
  metadata = {},
}) {
  if (!userId) {
    throw new Error("userId is required to log an activity");
  }

  if (!type) {
    throw new Error("Activity type is required");
  }

  const activity = await ActivityLog.create({
    userId,
    type,
    title: title || type,
    description: description || "",
    metadata,
  });

  return activity;
}