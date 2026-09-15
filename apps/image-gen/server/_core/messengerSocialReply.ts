import { t, type Lang } from "./i18n";
import { getSocialReply } from "./socialReply";
import type { FacebookWebhookEvent } from "./webhookHelpers";

function hasStickerId(value: unknown): boolean {
  return (
    (typeof value === "string" && /^\d+$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

export function getMessengerMessageSocialReply(
  message: FacebookWebhookEvent["message"],
  lang: Lang
): string | null {
  if (!message || message.is_echo || message.quick_reply?.payload) return null;
  const attachments = message.attachments ?? [];
  const reply = getSocialReply(message.text, lang);
  if (message.text?.trim() && !reply) return null;
  // A Messenger like can be an image attachment with a message-level
  // sticker_id. reply_to alone never makes a real uploaded photo a reaction.
  const sticker =
    (hasStickerId(message.sticker_id) && attachments.length <= 1) ||
    (attachments.length > 0 &&
      attachments.every(
        attachment =>
          attachment.type === "sticker" ||
          hasStickerId(attachment.payload?.sticker_id)
      ));
  if (sticker) return reply ?? t(lang, "socialReaction");
  return attachments.length === 0 ? reply : null;
}

export function getMessengerReactionReply(
  reaction: FacebookWebhookEvent["reaction"],
  lang: Lang
): string | null {
  if (reaction?.action !== "react" || !reaction.mid?.trim()) return null;
  const names: Record<string, string> = {
    like: "👍",
    love: "❤️",
    haha: "😂",
    wow: "😮",
    sad: "😢",
    angry: "😡",
    dislike: "👎",
  };
  const emoji = reaction.emoji ?? names[reaction.reaction ?? ""];
  return getSocialReply(emoji, lang) ?? t(lang, "socialReaction");
}
