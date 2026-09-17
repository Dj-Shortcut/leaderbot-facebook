import { createHash } from "node:crypto";

import { getRedisClient, isRedisEnabled } from "../redis";

export const WEBHOOK_INGRESS_QUEUE_KEY = "{meta-webhook-ingress}:queued";
export const WEBHOOK_INGRESS_PROCESSING_KEY =
  "{meta-webhook-ingress}:processing";
export const WEBHOOK_INGRESS_DEAD_LETTER_KEY = "{meta-webhook-ingress}:dead";
export const WEBHOOK_INGRESS_DELIVERY_PREFIX =
  "{meta-webhook-ingress}:delivery:";
export const WEBHOOK_INGRESS_SUBJECT_PREFIX =
  "{meta-webhook-ingress}:subject:";
export const WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX =
  "{meta-webhook-ingress}:subject-lease:";
export const WEBHOOK_INGRESS_LEASE_PREFIX = "{meta-webhook-ingress}:lease:";

export type WebhookIngressSubject = {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  pageId: string;
  userKey: string;
};

function getWebhookIngressSubjectId(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return createHash("sha256")
    .update(String(subject.workspaceId))
    .update("\0")
    .update(String(subject.channelConnectionId))
    .update("\0")
    .update(subject.userKey)
    .digest("hex");
}

export function getWebhookIngressSubjectKey(
  subject: WebhookIngressSubject
): string {
  return `${WEBHOOK_INGRESS_SUBJECT_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

export function getWebhookIngressSubjectLeaseKey(
  subject: WebhookIngressSubject
): string {
  return `${WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

export function getWebhookIngressSubjectTombstoneKey(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return `{meta-webhook-ingress}:erased:${getWebhookIngressSubjectId(subject)}`;
}

export async function eraseWebhookIngressDeliveriesForSubject(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  privacyEpoch: number;
}): Promise<number> {
  if (!isRedisEnabled()) {
    throw new Error("Webhook ingress queue is required for privacy erasure");
  }
  const redis = await getRedisClient();
  const subject = {
    ...input,
    bindingEpoch: 1,
    pageId: "privacy-erasure",
  } satisfies WebhookIngressSubject;
  const subjectKey = getWebhookIngressSubjectKey(subject);
  const tombstoneResult = Number(
    await redis.eval(
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if current < requested then
          redis.call("SET", KEYS[1], ARGV[1])
          return requested
        end
        return current
      `,
      1,
      getWebhookIngressSubjectTombstoneKey(subject),
      input.privacyEpoch
    )
  );
  if (
    !Number.isSafeInteger(tombstoneResult) ||
    tombstoneResult < input.privacyEpoch
  ) {
    throw new Error("Webhook ingress privacy tombstone update failed");
  }
  let total = 0;
  while (true) {
    const result = await redis.eval(
      `
        local queueType = redis.call("TYPE", KEYS[1]).ok
        local processingType = redis.call("TYPE", KEYS[2]).ok
        local deadType = redis.call("TYPE", KEYS[3]).ok
        local subjectType = redis.call("TYPE", KEYS[4]).ok
        if (queueType ~= "none" and queueType ~= "list")
          or (processingType ~= "none" and processingType ~= "list")
          or (deadType ~= "none" and deadType ~= "list")
          or (subjectType ~= "none" and subjectType ~= "set") then
          return redis.error_reply("webhook ingress privacy index is inconsistent")
        end

        local ids = redis.call("SRANDMEMBER", KEYS[4], 100)
        if type(ids) ~= "table" then ids = {} end
        for i = 1, #ids do
          local contentType = redis.call("TYPE", ARGV[1] .. ids[i]).ok
          local leaseType = redis.call("TYPE", ARGV[2] .. ids[i]).ok
          if (contentType ~= "none" and contentType ~= "string")
            or (leaseType ~= "none" and leaseType ~= "string") then
            return redis.error_reply("webhook ingress subject reference is inconsistent")
          end
        end
        for i = 1, #ids do
          local id = ids[i]
          redis.call("LREM", KEYS[1], 0, id)
          redis.call("LREM", KEYS[2], 0, id)
          redis.call("LREM", KEYS[3], 0, id)
          redis.call("DEL", ARGV[1] .. id)
          redis.call("DEL", ARGV[2] .. id)
          redis.call("SREM", KEYS[4], id)
        end
        if redis.call("SCARD", KEYS[4]) == 0 then
          redis.call("DEL", KEYS[4])
          redis.call("DEL", KEYS[5])
        end
        return #ids
      `,
      5,
      WEBHOOK_INGRESS_QUEUE_KEY,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      subjectKey,
      getWebhookIngressSubjectLeaseKey(subject),
      WEBHOOK_INGRESS_DELIVERY_PREFIX,
      WEBHOOK_INGRESS_LEASE_PREFIX
    );
    const removed = typeof result === "number" ? result : Number(result) || 0;
    total += removed;
    if (removed < 100) return total;
  }
}
