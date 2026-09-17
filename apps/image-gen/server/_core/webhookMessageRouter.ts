import { type Lang } from "./i18n";
import { safeLog } from "./messengerApi";
import { t } from "./i18n";
import { decodeMessengerActionInput } from "./messengerActionPayload";
import { isCreditBalanceCommand } from "./creditBalanceAction";
import {
  anonymizePsid,
  getOrCreateState,
  type MessengerUserState,
} from "./messengerState";
import {
  getNormalizedAttachmentTypes,
  hasAttachmentUrl,
  hasImageAttachment,
  hasReadableImageAttachment,
  type FacebookWebhookEvent,
  type MessengerNormalizedAttachment,
  resolveMessengerAttachmentRoute,
  type MessengerAttachmentRoute,
  type MessengerAttachmentRouteDecision,
  normalizeMessengerInboundMessage,
} from "./webhookHelpers";
import { handlePayload } from "./webhookPayloadBranch";
import type { HandlerContext } from "./webhookHandlerTypes";
import { handleTextMessage } from "./webhookTextMessageRouter";
import { tryHandleImageMessage } from "./webhookImageMessageRouter";
import { tryHandleAudioMessage } from "./webhookAudioMessageRouter";

import { getMessengerMessageSocialReply } from "./messengerSocialReply";

type MessageEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

function getUnsupportedResponseKey(
  route: MessengerAttachmentRoute,
  hasEditablePhoto: boolean
): UnsupportedAttachmentCopyKey {
  if (route === "audio") {
    return "unsupportedAudio";
  }

  if (route === "unsupported_video") {
    return hasEditablePhoto
      ? "unsupportedVideoWithEditableImage"
      : "unsupportedVideo";
  }

  if (route === "unsupported_file") {
    return hasEditablePhoto
      ? "unsupportedFileWithEditableImage"
      : "unsupportedFile";
  }

  if (route === "unsupported_share") {
    return hasEditablePhoto
      ? "unsupportedShareWithEditableImage"
      : "unsupportedShare";
  }

  if (route === "unsupported_sticker") {
    return hasEditablePhoto
      ? "unsupportedStickerWithEditableImage"
      : "unsupportedSticker";
  }

  if (route === "unsupported_unknown") {
    return hasEditablePhoto
      ? "unsupportedUnknownWithEditableImage"
      : "unsupportedUnknown";
  }

  if (route === "image") {
    return hasEditablePhoto
      ? "unsupportedMediaWithEditableImage"
      : "unsupportedMedia";
  }

  return hasEditablePhoto
    ? "unsupportedMediaWithEditableImage"
    : "unsupportedUnknown";
}

type UnsupportedAttachmentCopyKey =
  | "unsupportedAudio"
  | "unsupportedVideo"
  | "unsupportedVideoWithEditableImage"
  | "unsupportedFile"
  | "unsupportedFileWithEditableImage"
  | "unsupportedShare"
  | "unsupportedShareWithEditableImage"
  | "unsupportedSticker"
  | "unsupportedStickerWithEditableImage"
  | "unsupportedUnknown"
  | "unsupportedUnknownWithEditableImage"
  | "unsupportedMedia"
  | "unsupportedMediaWithEditableImage";

function getAfterRouteTextResponse(
  lang: Lang,
  route: MessengerAttachmentRoute,
  state: MessengerUserState | null
): string {
  return t(lang, getUnsupportedResponseKey(route, hasEditableImage(state)));
}

function hasEditableImage(state: MessengerUserState | null): boolean {
  return Boolean(
    state?.lastPhotoUrl ??
    state?.lastPhoto ??
    state?.lastGeneratedUrl ??
    state?.lastImageUrl
  );
}

async function tryHandleCreditBalanceCommand(
  ctx: HandlerContext,
  input: MessageEventInput,
  message: NonNullable<FacebookWebhookEvent["message"]>
): Promise<boolean> {
  const creditCommand = message.quick_reply?.payload
    ? decodeMessengerActionInput(message.quick_reply.payload)
    : message.text;
  if (
    message.attachments?.length ||
    !creditCommand ||
    !isCreditBalanceCommand(creditCommand)
  ) {
    return false;
  }

  await handleTextMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    text: creditCommand,
    timestamp: input.event.timestamp ?? Date.now(),
  });
  return true;
}

async function tryHandleQuickReplyPayload(
  ctx: HandlerContext,
  input: MessageEventInput,
  message: NonNullable<FacebookWebhookEvent["message"]>
): Promise<boolean> {
  const quickPayload = message.quick_reply?.payload;
  if (!quickPayload) return false;

  const actionInput = decodeMessengerActionInput(quickPayload);
  if (actionInput) {
    await handleTextMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      text: actionInput,
      replyToMessageId: message.reply_to?.mid,
      timestamp: input.event.timestamp ?? Date.now(),
    });
    return true;
  }

  await handlePayload(ctx, {
    psid: input.psid,
    userId: input.userId,
    payload: quickPayload,
    reqId: input.reqId,
    lang: input.lang,
  });
  return true;
}

async function tryRouteImageAttachment(
  ctx: HandlerContext,
  input: MessageEventInput,
  message: NonNullable<FacebookWebhookEvent["message"]>,
  normalizedAttachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  attachmentRoute: MessengerAttachmentRouteDecision | null,
  stateBeforeRoute: MessengerUserState | null
): Promise<boolean> {
  if (
    attachmentRoute?.route !== "image" ||
    !hasImageAttachment(normalizedAttachments) ||
    !hasReadableImageAttachment(normalizedAttachments)
  ) {
    return false;
  }

  const imageHandled = await tryHandleImageMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    attachments: message.attachments ?? [],
    text: message.text,
    timestamp: input.event.timestamp ?? Date.now(),
  });
  if (!imageHandled) return false;

  const stateAfter = await getOrCreateState(input.psid);
  logMessengerImageRouted(
    ctx,
    input,
    normalizedAttachments,
    trimmedText,
    "image",
    stateBeforeRoute,
    stateAfter
  );
  return true;
}

async function tryRouteAudioAttachment(
  ctx: HandlerContext,
  input: MessageEventInput,
  message: NonNullable<FacebookWebhookEvent["message"]>,
  normalizedAttachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  attachmentRoute: MessengerAttachmentRouteDecision | null,
  stateBeforeRoute: MessengerUserState | null
): Promise<boolean> {
  if (attachmentRoute?.route !== "audio") return false;

  const audioHandled = await tryHandleAudioMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    attachments: message.attachments ?? [],
    text: message.text,
    timestamp: input.event.timestamp ?? Date.now(),
  });
  if (!audioHandled) return false;

  const stateAfter = await getOrCreateState(input.psid);
  logMessengerAttachmentRouted(
    ctx,
    input,
    normalizedAttachments,
    trimmedText,
    "audio",
    "handled",
    stateBeforeRoute,
    stateAfter,
    hasAttachmentUrl(normalizedAttachments)
  );
  return true;
}

/** Handles a non-echo Messenger message event and dispatches payload, image, or text flows. */
export async function handleMessageEvent(
  ctx: HandlerContext,
  input: MessageEventInput
): Promise<void> {
  const message = input.event.message;
  if (!message || message.is_echo) return;

  const socialReply = getMessengerMessageSocialReply(message, input.lang);
  if (socialReply) {
    await ctx.sendLoggedText(input.psid, socialReply, input.reqId);
    return;
  }

  if (await tryHandleCreditBalanceCommand(ctx, input, message)) return;

  if (
    (await ctx.maybeSendInFlightMessage(input.psid, input.reqId, input.lang))
      .handled
  ) {
    return;
  }

  if (await tryHandleQuickReplyPayload(ctx, input, message)) return;

  const normalizedInbound = normalizeMessengerInboundMessage(message);
  const normalizedAttachments = normalizedInbound.attachments;
  const trimmedText = normalizedInbound.text?.trim();
  const hasAttachments = normalizedAttachments.length > 0;
  const attachmentRoute = hasAttachments
    ? resolveMessengerAttachmentRoute(normalizedAttachments)
    : null;
  const stateBeforeRoute = hasAttachments
    ? await getOrCreateState(input.psid)
    : null;

  if (normalizedAttachments.length) {
    logMessengerAttachments(ctx, input, normalizedAttachments, trimmedText);
  }

  if (
    await tryRouteImageAttachment(
      ctx,
      input,
      message,
      normalizedAttachments,
      trimmedText,
      attachmentRoute,
      stateBeforeRoute
    )
  ) {
    return;
  }

  if (
    await tryRouteAudioAttachment(
      ctx,
      input,
      message,
      normalizedAttachments,
      trimmedText,
      attachmentRoute,
      stateBeforeRoute
    )
  ) {
    return;
  }

  if (attachmentRoute) {
    await sendUnsupportedAttachmentResponse(
      ctx,
      input,
      normalizedAttachments,
      trimmedText,
      attachmentRoute,
      stateBeforeRoute
    );
    return;
  }

  if (!trimmedText) {
    return;
  }

  await handleTextMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    text: trimmedText,
    replyToMessageId: message.reply_to?.mid,
    timestamp: input.event.timestamp ?? Date.now(),
  });
  if (hasAttachments) {
    const fallbackRoute: MessengerAttachmentRouteDecision = {
      route: "unsupported_unknown",
      rejectedReason: "unsupported_payload",
    };
    await sendUnsupportedAttachmentResponse(
      ctx,
      input,
      normalizedAttachments,
      trimmedText,
      fallbackRoute,
      stateBeforeRoute
    );
  }
}

function logMessengerAttachments(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined
): void {
  safeLog("messenger_attachment_received", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    attachmentHasUrl: hasAttachmentUrl(attachments),
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
  });
  ctx.debugWebhookLog({
    msg: "attachment_received",
    reqId: input.reqId,
    attachmentCount: attachments?.length ?? 0,
    hasAttachments: true,
  });
}

function logMessengerImageRouted(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  route: MessengerAttachmentRoute,
  stateBefore?: MessengerUserState | null,
  stateAfter?: MessengerUserState | null
): void {
  logMessengerAttachmentRouted(
    ctx,
    input,
    attachments,
    trimmedText,
    route,
    "handled",
    stateBefore,
    stateAfter,
    hasAttachmentUrl(attachments)
  );
}

async function sendUnsupportedAttachmentResponse(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  route: MessengerAttachmentRouteDecision,
  stateBefore?: MessengerUserState | null
): Promise<void> {
  const stateAfter = await getOrCreateState(input.psid);
  logMessengerAttachmentRouted(
    ctx,
    input,
    attachments,
    trimmedText,
    route.route,
    route.rejectedReason,
    stateBefore,
    stateAfter,
    hasAttachmentUrl(attachments)
  );
  safeLog("messenger_attachment_unsupported", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    route: route.route,
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    attachmentHasUrl: hasAttachmentUrl(attachments),
    reason: route.rejectedReason ?? "unsupported_payload",
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
    stateBefore: summarizeStateForLog(stateBefore),
    stateAfter: summarizeStateForLog(stateAfter),
    selectedRoute: route.route,
  });
  await ctx.sendLoggedText(
    input.psid,
    getAfterRouteTextResponse(input.lang, route.route, stateAfter),
    input.reqId
  );
}

function logMessengerAttachmentRouted(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  route: MessengerAttachmentRoute,
  reason: string | undefined = undefined,
  stateBefore?: MessengerUserState | null,
  stateAfter?: MessengerUserState | null,
  hasUrl?: boolean
): void {
  safeLog("messenger_attachment_routed", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    route,
    rejectedReason: reason,
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    attachmentHasUrl: hasUrl ?? hasAttachmentUrl(attachments),
    stateBefore: summarizeStateForLog(stateBefore),
    stateAfter: summarizeStateForLog(stateAfter),
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
    selectedRoute: route,
  });
  ctx.debugWebhookLog({
    msg: "attachment_routed",
    reqId: input.reqId,
    route,
  });
}

function summarizeStateForLog(
  state: MessengerUserState | null | undefined
): { stage?: string; state?: string } | null {
  if (!state) {
    return null;
  }

  return {
    stage: state.stage,
    state: state.state,
  };
}
