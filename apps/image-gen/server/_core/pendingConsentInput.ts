import type { PendingConsentInput } from "./messengerState";
import { patchState } from "./messengerStatePersistence";
import { MAX_SOURCE_IMAGES } from "./image-generation/generationTypes";
import { getMessengerMessageSocialReply } from "./messengerSocialReply";
import type { FacebookWebhookEvent } from "./webhookHelpers";

export const PENDING_CONSENT_TTL_MS = 15 * 60_000;
export const PENDING_CONSENT_MAX_TEXT_BYTES = 32 * 1_024;

export async function holdPendingConsentInput(
  psid: string,
  message: FacebookWebhookEvent["message"],
  now = Date.now()
): Promise<"held" | "limit" | "ignored"> {
  if (
    !message ||
    message.is_echo ||
    message.quick_reply ||
    getMessengerMessageSocialReply(message, "nl")
  )
    return "ignored";
  const text = message.text?.trim();
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
  let result: "held" | "limit" | "ignored" = "ignored";
  await patchState(psid, current => {
    result = "ignored";
    if (
      current.consentGiven ||
      current.consentDeclinedAt !== undefined ||
      current.pendingDeleteConfirm
    )
      return {};
    const pending = current.pendingConsentInput;
    const previous = pending && pending.expiresAt > now ? pending : null;
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
      result = "limit";
      return { pendingConsentInput: null };
    }
    result = "held";
    return {
      pendingConsentInput: {
        text: combinedText || undefined,
        imageUrls: combinedImages,
        expiresAt: previous?.expiresAt ?? now + PENDING_CONSENT_TTL_MS,
      },
    };
  });
  return result;
}

/** Atomically remove the input before resuming; concurrent grants get it once. */
export async function takePendingConsentInput(
  psid: string,
  now = Date.now()
): Promise<PendingConsentInput | null> {
  let claimed: PendingConsentInput | null = null;
  await patchState(psid, current => {
    claimed = null;
    if (!current.consentGiven || current.pendingDeleteConfirm) return {};
    if (
      current.pendingConsentInput &&
      current.pendingConsentInput.expiresAt > now
    ) {
      claimed = current.pendingConsentInput;
    }
    return { pendingConsentInput: null };
  });
  return claimed;
}
