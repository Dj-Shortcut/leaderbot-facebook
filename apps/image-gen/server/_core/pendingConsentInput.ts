import { randomUUID } from "node:crypto";
import {
  updatePendingConsentInput,
  type PendingConsentInput,
} from "./pendingConsentInputStore";
import { MAX_SOURCE_IMAGES } from "./image-generation/generationTypes";
import { getMessengerMessageSocialReply } from "./messengerSocialReply";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import type { MessengerUserState } from "./messengerState";

type PendingConsentResult = "held" | "limit" | "ignored" | "consented";

const isActivePendingClaim = (
  pending: PendingConsentInput | null,
  now: number
) => Boolean(pending?.claim && pending.claim.expiresAt > now);

const getUnexpiredPending = (
  pending: PendingConsentInput | null,
  now: number
) => (pending && pending.expiresAt > now ? pending : null);

const isConsentBlocked = (
  state: Pick<MessengerUserState, "consentDeclinedAt" | "pendingDeleteConfirm">
) =>
  state.consentDeclinedAt !== undefined || state.pendingDeleteConfirm === true;

const combinePendingInput = (
  previous: PendingConsentInput | null,
  text: string | undefined,
  imageUrls: string[]
) => ({
  text: [previous?.text, text].filter(Boolean).join("\n\n"),
  imageUrls: [...new Set([...(previous?.imageUrls ?? []), ...imageUrls])],
});

const exceedsPendingConsentLimits = (text: string, imageUrls: string[]) =>
  Buffer.byteLength(text, "utf8") > PENDING_CONSENT_MAX_TEXT_BYTES ||
  imageUrls.length > MAX_SOURCE_IMAGES ||
  imageUrls.some(url => Buffer.byteLength(url, "utf8") > 8_192);

const claimPendingInput = (pending: PendingConsentInput, now: number) => ({
  ...pending,
  claim: {
    token: randomUUID(),
    expiresAt: Math.min(pending.expiresAt, now + 5 * 60_000),
  },
});

const shouldDiscardFinishedPending = (
  state: Pick<MessengerUserState, "consentGiven" | "pendingDeleteConfirm">,
  succeeded: boolean
) => succeeded || !state.consentGiven || state.pendingDeleteConfirm === true;

export const PENDING_CONSENT_TTL_MS = 15 * 60_000;
export const PENDING_CONSENT_MAX_TEXT_BYTES = 32 * 1_024;

export async function holdPendingConsentInput(
  psid: string,
  message: FacebookWebhookEvent["message"],
  now = Date.now(),
  allowConsentedAttachments = false
): Promise<PendingConsentResult> {
  if (
    !message ||
    message.is_echo ||
    message.quick_reply ||
    getMessengerMessageSocialReply(message, "nl")
  )
    return "ignored";
  const text = allowConsentedAttachments ? undefined : message.text?.trim();
  if (
    text &&
    /^(hi|hey|hello|hallo|hoi|goedemorgen|goedemiddag|goedenavond)$/iu.test(
      text
    )
  )
    return "ignored";
  const attachments = message.attachments ?? [];
  // Only keep image references. Audio, files, stickers and controls keep their
  // existing paths; nothing is downloaded, analysed or generated here.
  if (
    message.sticker_id ||
    attachments.some(
      attachment =>
        attachment.type !== "image" ||
        attachment.payload?.sticker_id ||
        typeof attachment.payload?.url !== "string"
    )
  )
    return "ignored";
  const imageUrls = attachments.map(attachment => attachment.payload!.url!);
  if (!text && !imageUrls.length) return "ignored";
  return updatePendingConsentInput<"held" | "limit" | "ignored" | "consented">(
    psid,
    (current, stored) => {
      const previous = getUnexpiredPending(stored, now);
      if (current.consentGiven && !allowConsentedAttachments) {
        return { pending: previous, result: "consented" as const };
      }
      if (isConsentBlocked(current)) {
        return { pending: null, result: "ignored" as const };
      }
      if (isActivePendingClaim(previous, now))
        return { pending: previous, result: "ignored" as const };
      const combined = combinePendingInput(previous, text, imageUrls);
      if (exceedsPendingConsentLimits(combined.text, combined.imageUrls)) {
        return { pending: null, result: "limit" as const };
      }
      return {
        pending: {
          text: combined.text || undefined,
          imageUrls: combined.imageUrls,
          expiresAt: previous?.expiresAt ?? now + PENDING_CONSENT_TTL_MS,
          operationId: previous?.operationId ?? randomUUID(),
        },
        result: "held" as const,
      };
    }
  );
}

/** Keep the only copy until routing succeeds; a failed attempt can be retried. */
export async function takePendingConsentInput(
  psid: string,
  now = Date.now()
): Promise<PendingConsentInput | null> {
  return updatePendingConsentInput<PendingConsentInput | null>(
    psid,
    (current, stored) => {
      const pending = getUnexpiredPending(stored, now);
      if (
        !current.consentGiven ||
        current.pendingDeleteConfirm ||
        isActivePendingClaim(pending, now)
      ) {
        return { pending, result: null };
      }
      if (!pending) return { pending: null, result: null };
      const claimed = claimPendingInput(pending, now);
      return { pending: claimed, result: claimed };
    }
  );
}

export async function finishPendingConsentInput(
  psid: string,
  claimed: PendingConsentInput,
  succeeded: boolean
): Promise<void> {
  await updatePendingConsentInput(psid, (state, pending) => {
    if (!pending || pending.claim?.token !== claimed.claim?.token) {
      return { pending, result: undefined };
    }
    return {
      pending: shouldDiscardFinishedPending(state, succeeded)
        ? null
        : { ...pending, claim: undefined },
      result: undefined,
    };
  });
}
