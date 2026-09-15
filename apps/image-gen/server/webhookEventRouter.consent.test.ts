import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handleMessage } = vi.hoisted(() => ({ handleMessage: vi.fn() }));
vi.mock("./_core/webhookMessageRouter", () => ({
  handleMessageEvent: handleMessage,
}));
import { routeTrackedEvent } from "./_core/webhookEventRouter";
import { classifyInboundEvent } from "./_core/messengerInboundClassification";
import {
  getOrCreateState,
  resetStateStore,
  setConsentState,
} from "./_core/messengerState";
import { getPendingConsentStorageScope } from "./_core/messengerStatePersistence";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import { holdPendingConsentInput } from "./_core/pendingConsentInput";
import { readScopedState } from "./_core/stateStore";
import type { TrackedEventContext } from "./_core/webhookEventContext";
import type { HandlerContext } from "./_core/webhookHandlerTypes";
import type { FacebookWebhookEvent } from "./_core/webhookHelpers";

const psid = "consent-router-user";
const image = {
  type: "image",
  payload: { url: "https://example.test/photo.jpg" },
};
const agree = { postback: { payload: "GDPR_CONSENT_AGREE" } };
const scoped = (action: () => Promise<void>) =>
  runWithMessengerRequestContext("test-page", action);

async function context(event: FacebookWebhookEvent) {
  const state = await getOrCreateState(psid);
  return {
    psid,
    userId: state.userKey,
    reqId: "test-consent-event",
    lang: "en",
    localeLang: "en",
    state,
    classification: classifyInboundEvent(event),
    responseSent: () => true,
    sendFallbackIfNeeded: vi.fn(async () => undefined),
    trackedCtx: {
      sendLoggedText: vi.fn(async () => ({ sent: true })),
      sendLoggedActions: vi.fn(async () => ({ sent: true })),
    } as unknown as HandlerContext,
  } satisfies TrackedEventContext;
}

describe("pending consent event routing", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("PRIVACY_PEPPER", "consent-router-test-pepper");
    resetStateStore();
    handleMessage.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("continues to consent controls if the optional held notice fails", async () =>
    scoped(async () => {
      const event = { message: { text: "Draw a cat" } };
      const ctx = await context(event);
      vi.mocked(ctx.trackedCtx.sendLoggedText).mockRejectedValueOnce(
        new Error("transport failed")
      );
      await routeTrackedEvent(ctx, event);
      expect(ctx.trackedCtx.sendLoggedActions).toHaveBeenCalledWith(
        psid,
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "GDPR_CONSENT_AGREE" }),
        ]),
        ctx.reqId
      );
      expect(handleMessage).not.toHaveBeenCalled();
    }));

  it("routes the original photo when consent won after the context snapshot", async () =>
    scoped(async () => {
      const event = {
        message: { attachments: [image] },
        timestamp: Date.now(),
      };
      const ctx = await context(event);
      await setConsentState(psid, true);
      await routeTrackedEvent(ctx, event);
      expect(handleMessage).toHaveBeenCalledWith(
        ctx.trackedCtx,
        expect.objectContaining({ event })
      );
      expect(ctx.trackedCtx.sendLoggedActions).not.toHaveBeenCalled();
    }));

  it.each([false, true])(
    "routes photos on typed agreement with older input=%s",
    async previous =>
      scoped(async () => {
        if (previous)
          await holdPendingConsentInput(psid, { text: "Draw a portrait" });
        const event = { message: { text: "I agree", attachments: [image] } };
        const ctx = await context(event);
        await routeTrackedEvent(ctx, event);
        expect(handleMessage).toHaveBeenCalledOnce();
        expect(handleMessage.mock.calls[0][1].event.message).toEqual({
          text: previous ? "Draw a portrait" : undefined,
          attachments: [image],
        });
      })
  );

  it("retains failed input and resumes a fresh consent click with a stable operation id", async () =>
    scoped(async () => {
      await holdPendingConsentInput(psid, {
        text: "Draw a portrait",
        attachments: [image],
      });
      handleMessage.mockRejectedValueOnce(new Error("state unavailable"));
      const first = await context(agree);
      await expect(routeTrackedEvent(first, agree)).rejects.toThrow(
        "state unavailable"
      );
      const scope = getPendingConsentStorageScope(psid);
      expect(await readScopedState(scope.scope, scope.key)).toEqual(
        expect.objectContaining({ text: "Draw a portrait" })
      );
      await routeTrackedEvent(await context(agree), agree);
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(handleMessage.mock.calls[1][1].reqId).toBe(
        handleMessage.mock.calls[0][1].reqId
      );
      expect(await readScopedState(scope.scope, scope.key)).toBeNull();
    }));

  it("still resumes if the consent confirmation notice fails", async () =>
    scoped(async () => {
      await holdPendingConsentInput(psid, { text: "Draw a cat" });
      const ctx = await context(agree);
      vi.mocked(ctx.trackedCtx.sendLoggedText).mockRejectedValueOnce(
        new Error("transport failed")
      );
      await routeTrackedEvent(ctx, agree);
      expect(handleMessage).toHaveBeenCalledOnce();
    }));
});
