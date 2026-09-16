import { createHash, randomUUID } from "node:crypto";
import {
  setEphemeralKeyIfAbsent,
  deleteEphemeralKeyIfValue,
  hasEphemeralKeyValue,
  refreshEphemeralKeyIfValue,
} from "./stateStore";
import type { BotTextContext } from "./botContext";
import { getConnectedFacebookPageConnection } from "../db";
import { storageGet, storageKeyFromPublicUrl } from "../storage";
import {
  messengerStorageObjectMatchesScope,
  type MessengerStorageScope,
} from "./messengerStorageObject";
import { resolveStoredSourceImage } from "./image-generation/sourceImageFetcher";
import {
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import { assertMessengerPrivacySubject } from "./messengerPrivacySubject";
import {
  claimMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  finalizeMessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import {
  appendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
} from "./costLedger";
import { admitMessengerProviderSpend } from "./generationGuard";
import { getState, type MessengerUserState } from "./messengerState";
import { toUserKey } from "./privacy";
import {
  getPhotoConversationImages,
  normalizePhotoConversation,
  PHOTO_CONVERSATION_MAX_TEXT,
  type PhotoConversationImage,
} from "./photoConversationMemory";

import {
  buildPhotoConversationRequest,
  parsePhotoConversationDecision,
  photoConversationInputTokenBound,
  PHOTO_CONVERSATION_MODEL,
  PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS,
  PHOTO_CONVERSATION_TIMEOUT_MS,
  PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
  PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN,
  type PhotoConversationDecision,
} from "./photoConversationContract";

export {
  parsePhotoConversationDecision,
  PHOTO_CONVERSATION_MODEL,
  type PhotoConversationDecision,
} from "./photoConversationContract";

export function photoConversationScope(
  ctx: BotTextContext
): MessengerStorageScope & { pageId: string } {
  const ownership = getMessengerRequestOwnership();
  const subject = getMessengerRequestPrivacySubject();
  const pageId = getMessengerRequestPageId();
  if (
    ctx.channel !== "messenger" ||
    getMessengerRequestChannel() !== "facebook_messenger" ||
    !ownership ||
    !subject ||
    !pageId ||
    subject.userKey !== ctx.userId ||
    ctx.userId !== toUserKey(ctx.senderId) ||
    ![
      ownership.workspaceId,
      ownership.channelConnectionId,
      ownership.bindingEpoch,
      subject.privacyEpoch,
    ].every(n => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new Error("Photo conversation requires a verified scope");
  }
  return { ...ownership, ...subject, pageId };
}

export function assertPhotoConversationState(
  ctx: BotTextContext,
  state: MessengerUserState | null
): asserts state is MessengerUserState {
  const scope = photoConversationScope(ctx);
  if (
    !state ||
    !state.consentGiven ||
    state.psid !== ctx.senderId ||
    state.userKey !== scope.userKey ||
    state.pageId !== scope.pageId ||
    state.workspaceId !== scope.workspaceId ||
    state.channelConnectionId !== scope.channelConnectionId ||
    state.bindingEpoch !== scope.bindingEpoch ||
    state.privacyEpoch !== scope.privacyEpoch
  ) {
    throw new Error("Photo conversation consent or scope changed");
  }
}

export async function readCurrentPhotoConversationState(
  ctx: BotTextContext
): Promise<MessengerUserState> {
  const scope = photoConversationScope(ctx);
  await assertMessengerPrivacySubject(scope);
  if (!(await getConnectedFacebookPageConnection(scope.pageId, scope)))
    throw new Error("Photo conversation binding changed");
  const state = await getState(ctx.senderId);
  assertPhotoConversationState(ctx, state);
  return state;
}

/** A single paid interpretation, protected by the existing durable attempt and spend fences. */
export async function interpretPhotoConversation(
  ctx: BotTextContext,
  assertLease: () => Promise<void> = async () => {}
): Promise<{
  decision: PhotoConversationDecision;
  images: PhotoConversationImage[];
  snapshot: string;
} | null> {
  const state = await readCurrentPhotoConversationState(ctx);
  const scope = photoConversationScope(ctx);
  const memory = normalizePhotoConversation(state.photoConversation);
  const execution = memory.executions?.find(
    entry => entry.requestId === ctx.reqId
  );
  if (execution?.completed) return null;
  if (!execution && memory.turns.some(turn => turn.id === `${ctx.reqId}:user`))
    return null;
  const images = getPhotoConversationImages(state);
  const keys = images.map(image => {
    const key = storageKeyFromPublicUrl(image.url);
    if (!key || !messengerStorageObjectMatchesScope(key, scope))
      throw new Error("Photo conversation source scope is invalid");
    return key;
  });
  if (execution) {
    const decision = parsePhotoConversationDecision(
      { status: "completed", output_text: JSON.stringify(execution.decision) },
      images
    );
    return { decision, images, snapshot: photoConversationSnapshot(state) };
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || ctx.messageText.length > PHOTO_CONVERSATION_MAX_TEXT)
    throw new Error("Photo conversation unavailable");
  const catalog = images.map(image => ({ id: image.id, kind: image.kind }));
  const inputText = JSON.stringify({
    recentConversation: memory.turns.map(({ role, text }) => ({ role, text })),
    imageCatalog: catalog,
    stage: state.stage,
    pendingEditIntent: state.pendingEditIntent ?? null,
    latestImagePrompt:
      state.lastPrompt?.slice(0, PHOTO_CONVERSATION_MAX_TEXT) ?? null,
    currentUserMessage: ctx.messageText,
  });
  const now = new Date();
  const id = `${ctx.reqId}:photo-conversation:1`;
  const claim = await claimMessengerProviderAttemptFence(
    {
      psid: ctx.senderId,
      userId: ctx.userId,
      reqId: ctx.reqId,
      lang: ctx.lang,
      ...scope,
    },
    "openai-photo-conversation",
    1,
    now
  );
  if (claim.kind !== "owned") return null;
  let ledgerWritten = false;
  let transportStarted = false;
  let accepted = false;
  try {
    const content: Array<Record<string, string>> = [
      { type: "input_text", text: inputText },
    ];
    const availableImages: PhotoConversationImage[] = [];
    const unavailableImageIds: string[] = [];
    for (const [index, key] of keys.entries()) {
      try {
        const stored = await storageGet(key);
        const image = await resolveStoredSourceImage({
          sourceImageUrl: stored.url,
          trustedSourceImageUrl: true,
          sourceImageProvenance: "storeInbound",
          reqId: ctx.reqId,
        });
        if (
          image.buffer.length > 8 * 1024 * 1024 ||
          !["image/jpeg", "image/png", "image/webp"].includes(image.contentType)
        )
          throw new Error("Photo conversation image unavailable");
        content.push({
          type: "input_text",
          text: `Image ${catalog[index].id} (${catalog[index].kind}):`,
        });
        availableImages.push(images[index]);
        content.push({
          type: "input_image",
          image_url: `data:${image.contentType};base64,${image.buffer.toString("base64")}`,
          detail: "auto",
        });
      } catch {
        unavailableImageIds.push(catalog[index].id);
      }
    }
    content[0].text = JSON.stringify({
      ...JSON.parse(inputText),
      unavailableImageIds,
    });
    // Re-read after media IO; a concurrent reset/upload must not execute an obsolete turn.
    const current = await readCurrentPhotoConversationState(ctx);
    if (photoConversationSnapshot(current) !== photoConversationSnapshot(state))
      throw new Error("Photo conversation changed");
    const request = buildPhotoConversationRequest(ctx.lang, content);
    const requestBody = JSON.stringify(request);
    const estimatedCostUsd =
      photoConversationInputTokenBound(request) *
      PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN;
    await admitMessengerProviderSpend({
      reqId: ctx.reqId,
      attemptId: id,
      tenantScope: scope,
      userKey: ctx.userId,
      estimatedCostUsd,
      estimatedOutputCostUsd:
        PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS *
        PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN,
      costEstimateComplete: true,
      now,
      recordAttempt: async () => {
        await appendCostLedgerEntry(
          {
            id,
            channel: "facebook_messenger",
            operation: "photo_conversation",
            provider: "openai",
            model: PHOTO_CONVERSATION_MODEL,
            ...scope,
            reqId: ctx.reqId,
            status: "provider_attempt_started",
            estimatedCostUsd,
            estimatedOutputCostUsd:
              PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS *
              PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN,
            finalCostUsd: null,
            costEstimateComplete: true,
            estimateSource: "gpt-5.4-mini-2026-03-17:2026-09",
            unpricedCostComponents: [],
          },
          now
        );
        ledgerWritten = true;
        await assertLease();
        await markMessengerProviderAttemptStarted(claim.fence);
      },
    });
    transportStarted = true;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
      signal: AbortSignal.timeout(PHOTO_CONVERSATION_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error("Photo conversation provider rejected request");
    accepted = true;
    const raw: unknown = await response.json();
    const usage = (
      raw as {
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      } | null
    )?.usage;
    const inputTokens = usage?.input_tokens;
    const outputTokens = usage?.output_tokens;
    const finalCostUsd =
      typeof inputTokens === "number" &&
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      typeof outputTokens === "number" &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0
        ? inputTokens * PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN +
          outputTokens * PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN
        : null;
    await safelyUpdateCostLedgerEntry(
      id,
      { status: "provider_attempt_succeeded", finalCostUsd },
      now,
      scope
    );
    const decision = parsePhotoConversationDecision(raw, availableImages);
    await readCurrentPhotoConversationState(ctx);
    return {
      decision,
      images: availableImages,
      snapshot: photoConversationSnapshot(state),
    };
  } finally {
    // A successful HTTP response is billable even when JSON is malformed. A lost
    // response is ambiguous and never retried automatically under this event.
    await finalizeMessengerProviderAttemptFence(
      claim.fence,
      accepted ? "succeeded" : transportStarted ? "ambiguous" : "known_failed"
    );
    if (ledgerWritten)
      await safelyUpdateCostLedgerEntry(
        id,
        {
          status: accepted
            ? "provider_attempt_succeeded"
            : "provider_attempt_failed",
        },
        now,
        scope
      );
  }
}

export function photoConversationSnapshot(state: MessengerUserState): string {
  return JSON.stringify({
    memory: state.photoConversation ?? null,
    images: getPhotoConversationImages(state),
    stage: state.stage,
    prompt: state.lastPrompt,
    intent: state.pendingEditIntent,
  });
}

/** Serialize ordinary turns across workers; only the opaque full scope enters the lock key. */
export async function withPhotoConversationTurn<T>(
  ctx: BotTextContext,
  task: (assertLease: () => Promise<void>) => Promise<T>
): Promise<T> {
  const key = `photo-conversation:${createHash("sha256")
    .update(JSON.stringify(photoConversationScope(ctx)))
    .digest("hex")}`;
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  while (!(await setEphemeralKeyIfAbsent(key, token, 60))) {
    if (Date.now() >= deadline) throw new Error("Photo conversation is busy");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let lost = false;
  let refresh = Promise.resolve();
  const timer = setInterval(() => {
    refresh = refresh.then(async () => {
      try {
        if (!(await refreshEphemeralKeyIfValue(key, token, 60))) lost = true;
      } catch {
        lost = true;
      }
    });
  }, 10_000);
  timer.unref?.();
  const assertLease = async () => {
    if (lost || !(await hasEphemeralKeyValue(key, token)))
      throw new Error("Photo conversation lease lost");
  };
  try {
    return await task(assertLease);
  } finally {
    clearInterval(timer);
    await refresh;
    await deleteEphemeralKeyIfValue(key, token);
  }
}
