import { randomUUID } from "node:crypto";
import {
  updatePendingConsentInput,
  type PendingConsentInput,
} from "./pendingConsentInputStore";
import { MAX_SOURCE_IMAGES } from "./image-generation/generationTypes";
import { getMessengerMessageSocialReply } from "./messengerSocialReply";
import type { FacebookWebhookEvent } from "./webhookHelpers";

export const PENDING_CONSENT_TTL_MS = 15 * 60_000;
export const PENDING_CONSENT_MAX_TEXT_BYTES = 32 * 1_024;

export async function holdPendingConsentInput(
  psid: string,
  message: FacebookWebhookEvent["message"],
  now = Date.now(),
  allowConsentedAttachments = false
): Promise<"held" | "limit" | "ignored" | "consented"> {
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
      const previous = stored && stored.expiresAt > now ? stored : null;
      if (current.consentGiven && !allowConsentedAttachments) {
        return { pending: previous, result: "consented" as const };
      }
      if (
        current.consentDeclinedAt !== undefined ||
        current.pendingDeleteConfirm
      ) {
        return { pending: null, result: "ignored" as const };
      }
      if (previous?.claim && previous.claim.expiresAt > now)
        return { pending: previous, result: "ignored" as const };
      const combinedText = [previous?.text, text].filter(Boolean).join("\n\n");
      const combinedImages = [
        ...new Set([...(previous?.imageUrls ?? []), ...imageUrls]),
      ];
      if (
        Buffer.byteLength(combinedText, "utf8") >
          PENDING_CONSENT_MAX_TEXT_BYTES ||
        combinedImages.length > MAX_SOURCE_IMAGES ||
        combinedImages.some(url => Buffer.byteLength(url, "utf8") > 8_192)
      ) {
        return { pending: null, result: "limit" as const };
      }
      return {
        pending: {
          text: combinedText || undefined,
          imageUrls: combinedImages,
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
      const pending = stored && stored.expiresAt > now ? stored : null;
      if (
        !current.consentGiven ||
        current.pendingDeleteConfirm ||
        (pending?.claim && pending.claim.expiresAt > now)
      ) {
        return { pending, result: null };
      }
      if (!pending) return { pending: null, result: null };
      const claimed = {
        ...pending,
        claim: {
          token: randomUUID(),
          expiresAt: Math.min(pending.expiresAt, now + 5 * 60_000),
        },
      };
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
      pending:
        succeeded || !state.consentGiven || state.pendingDeleteConfirm
          ? null
          : { ...pending, claim: undefined },
      result: undefined,
    };
  });
}
