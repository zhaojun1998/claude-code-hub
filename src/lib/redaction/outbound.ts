import "server-only";

import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import { type RedisLike, RedisSeenStore } from "./incremental";
import { callJev } from "./jev-client";
import { RedactionRuntime, type RedactionSessionLike } from "./runtime";
import {
  createStoredRule,
  deleteEventsOlderThan,
  findCandidateVerdicts,
  insertRedactionEvent,
  listActiveStoredRules,
  loadSettingsRow,
  recordRuleHits,
  saveCandidateVerdicts,
} from "./store";

export const REDACTION_INVALIDATION_CHANNEL = "cch:cache:redaction:updated";

const globalForRedaction = globalThis as typeof globalThis & {
  __CCH_REDACTION_RUNTIME__?: RedactionRuntime;
  __CCH_REDACTION_SUBSCRIBED__?: boolean;
};

async function publishInvalidation(): Promise<void> {
  const { publishCacheInvalidation } = await import("@/lib/redis/pubsub");
  await publishCacheInvalidation(REDACTION_INVALIDATION_CHANNEL);
}

function createRuntime(): RedactionRuntime {
  return new RedactionRuntime({
    loadSettingsRow,
    listActiveStoredRules,
    seenStore: new RedisSeenStore(
      () => getRedisClient({ allowWhenRateLimitDisabled: true }) as unknown as RedisLike | null
    ),
    insertEvent: insertRedactionEvent,
    recordRuleHits,
    deleteEventsOlderThan,
    discovery: {
      callJev: (settings, candidates) => callJev(settings, candidates),
      findCandidateVerdicts,
      saveCandidateVerdicts,
      createStoredRule,
    },
    publishInvalidation,
    logger: {
      debug: (message, detail) => logger.debug(message, detail),
      info: (message, detail) => logger.info(message, detail),
      warn: (message, detail) => logger.warn(message, detail),
      error: (message, detail) => logger.error(message, detail),
    },
  });
}

/** Process-wide runtime shared by the proxy and the settings actions. */
export function getRedactionRuntime(): RedactionRuntime {
  if (!globalForRedaction.__CCH_REDACTION_RUNTIME__) {
    globalForRedaction.__CCH_REDACTION_RUNTIME__ = createRuntime();
  }
  const runtime = globalForRedaction.__CCH_REDACTION_RUNTIME__;
  if (!globalForRedaction.__CCH_REDACTION_SUBSCRIBED__) {
    globalForRedaction.__CCH_REDACTION_SUBSCRIBED__ = true;
    void import("@/lib/redis/pubsub")
      .then(({ subscribeCacheInvalidation }) =>
        subscribeCacheInvalidation(REDACTION_INVALIDATION_CHANNEL, () => runtime.invalidate())
      )
      .catch((error) => {
        logger.warn("[Redaction] Failed to subscribe to invalidation channel", { error });
      });
  }
  return runtime;
}

/** Reloads this worker and notifies the others after a settings or rule change. */
export async function notifyRedactionConfigChanged(): Promise<void> {
  const runtime = getRedactionRuntime();
  runtime.invalidate();
  await runtime.reload();
  await publishInvalidation().catch(() => undefined);
}

/**
 * Forwarder hook: redacts the per-attempt request body copy before it is serialized.
 * Fails open: an internal error is logged and the body is forwarded unchanged.
 */
export async function applyOutboundRedaction(
  session: RedactionSessionLike,
  body: Record<string, unknown>
): Promise<void> {
  try {
    await getRedactionRuntime().redactOutbound(session, body);
  } catch (error) {
    logger.error("[Redaction] Outbound redaction failed", { error });
  }
}

/** Forwarder hook for raw passthrough endpoints; returns the body to send. */
export async function applyOutboundRedactionToRaw(
  session: RedactionSessionLike,
  raw: ArrayBuffer
): Promise<ArrayBuffer | string> {
  try {
    const redacted = await getRedactionRuntime().redactRawBody(session, raw);
    return redacted ?? raw;
  } catch (error) {
    logger.error("[Redaction] Raw body redaction failed", { error });
    return raw;
  }
}
