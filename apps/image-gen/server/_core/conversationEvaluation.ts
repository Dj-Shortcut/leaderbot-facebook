import { safeLog } from "./logger";
import { t, type Lang } from "./i18n";
import {
  isImageGenerationRequest,
  isPromptWritingRequest,
  isLikelyNonImageArtifactRequest,
} from "./imageIntent";
import { detectAck, type FacebookWebhookEvent } from "./webhookHelpers";
import type { MessengerUserState } from "./messengerState";
import type {
  HandlerContext,
  MessengerSendOutcome,
} from "./webhookHandlerTypes";

type Finding =
  | "missing_reply"
  | "handler_error"
  | "fallback_reply"
  | "social_as_upload"
  | "social_started_generation"
  | "image_request_unhandled"
  | "in_flight_block"
  | "window_closed";

function isSocialText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (
    /\p{Extended_Pictographic}/u.test(normalized) &&
    /^[\s.!?\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]+$/u.test(
      normalized
    )
  )
    return true;
  return /^(bedankt|dank ?je ?wel|dank je|merci|thanks|thank you|thx|graag gedaan|geen probleem|you're welcome)[.!?\s]*$/u.test(
    normalized
  );
}

/** A bounded in-process check: retain categories and counts, never transcript content. */
export function createConversationEvaluation(input: {
  event: FacebookWebhookEvent;
  state: MessengerUserState;
  lang: Lang;
  reqId: string;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const message = input.event.message;
  const eligible = Boolean(
    (message && !message.is_echo) || input.event.postback
  );
  const canClassifyContent =
    input.state.consentGiven === true && !input.state.pendingDeleteConfirm;
  const text = canClassifyContent ? (message?.text ?? "") : "";
  const isSticker =
    (Boolean((message as { sticker_id?: unknown } | undefined)?.sticker_id) &&
      (message?.attachments?.length ?? 0) <= 1) ||
    Boolean(
      message?.attachments?.length &&
      message.attachments.every(
        attachment =>
          attachment.type === "sticker" || attachment.payload?.sticker_id
      )
    );
  const social =
    canClassifyContent &&
    ((isSticker && (!text.trim() || isSocialText(text))) ||
      (!message?.attachments?.length && isSocialText(text)));
  const expectedImage =
    canClassifyContent &&
    !social &&
    isImageGenerationRequest(text) &&
    !isPromptWritingRequest(text) &&
    !isLikelyNonImageArtifactRequest(text);
  const intent = !canClassifyContent
    ? "consent_or_control"
    : social
      ? "social"
      : expectedImage
        ? "image_request"
        : message?.attachments?.length
          ? "media"
          : "other";
  const intentionalSilence = Boolean(
    detectAck(text) || message?.quick_reply?.payload || input.event.postback
  );
  const unsupported = new Set([
    t(input.lang, "unsupportedSticker"),
    t(input.lang, "unsupportedStickerWithEditableImage"),
    t(input.lang, "unsupportedUnknown"),
    t(input.lang, "unsupportedUnknownWithEditableImage"),
    t(input.lang, "unsupportedMediaWithEditableImage"),
    t(input.lang, "missingInputImage"),
    t(input.lang, "messengerMissingInputImage"),
    t(input.lang, "textWithoutPhoto"),
  ]);
  const findings = new Set<Finding>();
  let accepted = false;
  let generationRequested = false;
  let guidance = false;
  let finished = false;
  const observeOutcome = (outcome: MessengerSendOutcome | undefined) => {
    if (outcome?.sent) accepted = true;
    else if (outcome?.reason === "response_window_closed")
      findings.add("window_closed");
  };
  const observeText = (
    reply: string,
    outcome: MessengerSendOutcome | undefined
  ) => {
    observeOutcome(outcome);
    if (!outcome?.sent) return;
    if (reply === t(input.lang, "failure")) findings.add("fallback_reply");
    if (social && unsupported.has(reply)) findings.add("social_as_upload");
    if (
      reply === t(input.lang, "flowExplanation") ||
      reply === t(input.lang, "textWithoutPhoto")
    )
      guidance = true;
  };

  return {
    wrap(ctx: HandlerContext): HandlerContext {
      return {
        ...ctx,
        sendLoggedText: async (...args) => {
          const outcome = await ctx.sendLoggedText(...args);
          observeText(args[1], outcome);
          return outcome;
        },
        sendLoggedActions: async (...args) => {
          const outcome = await ctx.sendLoggedActions(...args);
          observeText(args[1], outcome);
          return outcome;
        },
        sendLoggedImage: async (...args) => {
          const outcome = await ctx.sendLoggedImage(...args);
          observeOutcome(outcome);
          return outcome;
        },
        sendPhotoReceivedPrompt: async (...args) => {
          const outcome = await ctx.sendPhotoReceivedPrompt(...args);
          observeOutcome(outcome);
          return outcome;
        },
        sendFaceMemoryConsentPrompt: async (...args) => {
          const outcome = await ctx.sendFaceMemoryConsentPrompt(...args);
          observeOutcome(outcome);
          return outcome;
        },
        sendFlowExplanation: async (...args) => {
          const outcome = await ctx.sendFlowExplanation(...args);
          observeText(t(args[1], "flowExplanation"), outcome);
          return outcome;
        },
        runImageGeneration: async (...args) => {
          generationRequested = true;
          const outcome = await ctx.runImageGeneration(...args);
          observeOutcome(outcome);
          return outcome;
        },
        runVideoGeneration: ctx.runVideoGeneration
          ? async (...args) => {
              generationRequested = true;
              const outcome = await ctx.runVideoGeneration!(...args);
              observeOutcome(outcome);
              return outcome;
            }
          : undefined,
        sendLoggedVideo: ctx.sendLoggedVideo
          ? async (...args) => {
              const outcome = await ctx.sendLoggedVideo!(...args);
              observeOutcome(outcome);
              return outcome;
            }
          : undefined,
        maybeSendInFlightMessage: async (...args) => {
          const result = await ctx.maybeSendInFlightMessage(...args);
          if (result.handled) {
            findings.add("in_flight_block");
            if ("outcome" in result) observeOutcome(result.outcome);
          }
          return result;
        },
      };
    },
    finish(failed = false): void {
      if (finished || !eligible) return;
      finished = true;
      if (failed) findings.add("handler_error");
      if (
        !accepted &&
        !intentionalSilence &&
        !findings.has("window_closed") &&
        !findings.has("in_flight_block")
      )
        findings.add("missing_reply");
      if (social && generationRequested)
        findings.add("social_started_generation");
      if (
        expectedImage &&
        guidance &&
        !generationRequested &&
        !findings.has("in_flight_block")
      )
        findings.add("image_request_unhandled");
      try {
        safeLog("messenger_conversation_evaluation", {
          version: 1,
          reqId: input.reqId,
          evaluatedAt: new Date(now()).toISOString(),
          intent,
          contentCheck: canClassifyContent ? "rules" : "skipped",
          accepted,
          generationRequested,
          elapsedMs: Math.max(0, now() - startedAt),
          findings: [...findings].sort(),
        });
      } catch {
        // An evaluator must never change delivery, retries or user-visible behavior.
      }
    },
  };
}
