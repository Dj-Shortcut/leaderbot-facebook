import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customerTestModeFeature } from "./_core/bot/features/customerTestModeFeature";
import { statsFeature } from "./_core/bot/features/statsFeature";
import { ensureDefaultBotFeaturesRegistered } from "./_core/bot/defaultFeatures";
import { getBotFeatures } from "./_core/bot/features";
import type { BotTextContext } from "./_core/botContext";
import { runGuardedGeneration } from "./_core/generationGuard";
import { isMessengerAdmin } from "./_core/messengerAdmin";
import {
  readMessengerExecutionAccess,
  setMessengerCustomerTestMode,
} from "./_core/messengerCustomerTestMode";
import {
  canGenerate,
  canGenerateVideo,
  canTranscribe,
  reserveImageGenerationForAttempt,
  reserveVideoGenerationForAttempt,
  reserveTranscriptionForAttempt,
} from "./_core/messengerQuota";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import {
  clearUserState,
  getOrCreateState,
  getState,
  resetStateStore,
  setConsentState,
  setFlowState,
} from "./_core/messengerState";
import { patchState } from "./_core/messengerStatePersistence";
import * as messengerState from "./_core/messengerState";

const psid = "owner-test-psid";
const userKey = `u2.k1.${"a".repeat(64)}`;
const scope = {
  channel: "facebook_messenger" as const,
  workspaceId: 1,
  channelConnectionId: 2,
  bindingEpoch: 3,
  privacyEpoch: 4,
  userKey,
};
function inScope<T>(
  task: () => Promise<T>,
  overrides = {},
  pageId = "owner-page"
) {
  return runWithMessengerRequestContext(pageId, task, {
    ...scope,
    ...overrides,
  });
}
async function seed() {
  await getOrCreateState(psid);
  await setConsentState(psid, true);
}
async function context(messageText: string): Promise<BotTextContext> {
  return {
    channel: "messenger",
    capabilities: { quickReplies: true, richTemplates: true },
    senderId: psid,
    userId: userKey,
    reqId: "owner-test-command",
    lang: "nl",
    state: (await getState(psid))!,
    messageText,
    normalizedText: messageText.toLowerCase(),
    hasPhoto: false,
    sendText: vi.fn(async () => {}),
    sendImage: vi.fn(async () => {}),
    sendActions: vi.fn(async () => {}),
    setFlowState: vi.fn(async () => {}),
    runImageGeneration: vi.fn(async () => {}),
    getRuntimeStats: () => ({
      date: "2026-09-16",
      imagesGeneratedToday: 0,
      activeUsersToday: 1,
      generationKindsUsedToday: 0,
      errorCountToday: 0,
      averageGenerationLatencyMs: null,
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("PRIVACY_PEPPER", "owner-test-mode-test-pepper");
  vi.stubEnv("MESSENGER_ADMIN_IDS", psid);
  vi.stubEnv("MESSENGER_QUOTA_BYPASS_IDS", psid);
  vi.stubEnv("MOLLIE_MODE", "test");
  vi.stubEnv("MOLLIE_BILLING_ENABLED", "false");
  vi.stubEnv("MOLLIE_LIVE_BILLING_ENABLED", "false");
  resetStateStore();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetStateStore();
});

describe("owner customer test mode", () => {
  it("persists explicit on/off without changing quotas and retains admin stats", async () => {
    await inScope(async () => {
      await seed();
      await patchState(psid, { quota: { dayKey: "2026-09-16", count: 3 } });
      const original = await getState(psid);
      const ctx = await context("/testklant aan");
      await customerTestModeFeature.onText!(ctx);
      await customerTestModeFeature.onText!(ctx);
      expect(await getState(psid)).toMatchObject({
        customerTestMode: true,
        quota: original!.quota,
      });
      expect(await readMessengerExecutionAccess(psid, userKey)).toEqual({
        quotaBypass: false,
        budgetBypass: false,
      });
      expect(isMessengerAdmin(psid, userKey)).toBe(true);
      const stats = await context("/stats");
      expect(await statsFeature.onText!(stats)).toEqual({ handled: true });
      expect(stats.sendText).toHaveBeenCalledWith(
        expect.stringContaining("Leaderbot Stats")
      );
      const status = await context("/testklant status");
      await customerTestModeFeature.onText!(status);
      expect(status.sendText).toHaveBeenCalledWith(
        expect.stringContaining("staat AAN")
      );
      await customerTestModeFeature.onText!(await context("/testklant uit"));
      expect(await getState(psid)).toMatchObject({
        customerTestMode: false,
        quota: original!.quota,
      });
      expect(await readMessengerExecutionAccess(psid, userKey)).toEqual({
        quotaBypass: true,
        budgetBypass: true,
      });
      expect(ctx.runImageGeneration).not.toHaveBeenCalled();
    });
  });

  it.each([
    [{ workspaceId: 9 }, "owner-page"],
    [{ channelConnectionId: 9 }, "owner-page"],
    [{ bindingEpoch: 9 }, "owner-page"],
    [{ privacyEpoch: 9 }, "owner-page"],
    [{}, "another-page"],
  ])(
    "does not share the switch with another scope %j %s",
    async (overrides, page) => {
      await inScope(async () => {
        await seed();
        await setMessengerCustomerTestMode(psid, userKey, true);
      });
      await inScope(
        async () => {
          expect(await getState(psid)).toBeNull();
          expect(await readMessengerExecutionAccess(psid, userKey)).toEqual({
            quotaBypass: true,
            budgetBypass: true,
          });
        },
        overrides,
        page
      );
      await inScope(async () => {
        expect(await readMessengerExecutionAccess(psid, userKey)).toEqual({
          quotaBypass: false,
          budgetBypass: false,
        });
      });
    }
  );

  it("keeps other users unchanged and prevents them from operating the switch", async () => {
    await inScope(async () => {
      await seed();
      await setMessengerCustomerTestMode(psid, userKey, true);
      const ctx = {
        ...(await context("/testklant uit")),
        senderId: "ordinary-user",
        userId: "b".repeat(64),
      };
      expect(await customerTestModeFeature.onText!(ctx)).toEqual({
        handled: true,
      });
      expect(ctx.runImageGeneration).not.toHaveBeenCalled();
      expect(
        await readMessengerExecutionAccess(ctx.senderId, ctx.userId)
      ).toEqual({ quotaBypass: false, budgetBypass: false });
      expect((await getState(psid))?.customerTestMode).toBe(true);
    });
  });

  it("rejects absent scope, a mismatched subject, absent consent and generation in flight", async () => {
    await expect(
      setMessengerCustomerTestMode(psid, userKey, true)
    ).rejects.toThrow("verified scope");
    await inScope(async () => {
      await getOrCreateState(psid);
      await expect(
        setMessengerCustomerTestMode(psid, userKey, true)
      ).rejects.toThrow("consent");
      await setConsentState(psid, true);
      await expect(
        setMessengerCustomerTestMode(psid, "wrong-user", true)
      ).rejects.toThrow("verified scope");
      await runGuardedGeneration(psid, async () => {
        await expect(
          setMessengerCustomerTestMode(psid, userKey, true)
        ).rejects.toThrow("during generation");
      });
      await setFlowState(psid, "PROCESSING");
      await expect(
        setMessengerCustomerTestMode(psid, userKey, true)
      ).rejects.toThrow("during generation");
      expect((await getState(psid))?.customerTestMode).not.toBe(true);
    });
  });

  it.each([
    ["MOLLIE_MODE", "live"],
    ["MOLLIE_MODE", ""],
    ["MOLLIE_BILLING_ENABLED", "true"],
    ["MOLLIE_LIVE_BILLING_ENABLED", "true"],
  ])(
    "blocks configuration drift %s=%s without restoring exemptions",
    async (name, value) => {
      await inScope(async () => {
        await seed();
        await setMessengerCustomerTestMode(psid, userKey, true);
        vi.stubEnv(name, value);
        await expect(
          readMessengerExecutionAccess(psid, userKey)
        ).rejects.toThrow("Test Mode");
        await expect(
          setMessengerCustomerTestMode(psid, userKey, true)
        ).rejects.toThrow("Test Mode");
        const ctx = await context("/testklant");
        await customerTestModeFeature.onText!(ctx);
        expect(ctx.sendText).toHaveBeenCalledWith(
          expect.stringContaining("geblokkeerd")
        );
        await setMessengerCustomerTestMode(psid, userKey, false);
        expect((await getState(psid))?.customerTestMode).toBe(false);
      });
    }
  );

  it("keeps a former administrator's existing test session closed to live billing", async () => {
    await inScope(async () => {
      await seed();
      await setMessengerCustomerTestMode(psid, userKey, true);
      vi.stubEnv("MESSENGER_ADMIN_IDS", "");
      vi.stubEnv("MESSENGER_QUOTA_BYPASS_IDS", "");
      vi.stubEnv("MOLLIE_MODE", "live");
      await expect(readMessengerExecutionAccess(psid, userKey)).rejects.toThrow(
        "Test Mode"
      );
    });
  });

  it("uses scoped preference even when legacy quota state already exists", async () => {
    vi.stubEnv("MESSENGER_FREE_DAILY_LIMIT", "0");
    vi.stubEnv("MESSENGER_VIDEO_GENERATION_DAILY_LIMIT", "0");
    vi.stubEnv("MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT", "0");
    // These create the legacy state without an enabled customer-test field.
    expect(await canGenerate(psid)).toBe(true);
    expect(await canGenerateVideo(psid)).toBe(true);
    expect(await canTranscribe(psid)).toBe(true);
    await inScope(async () => {
      await seed();
      await setMessengerCustomerTestMode(psid, userKey, true);
      expect(await canGenerate(psid)).toBe(false);
      expect(await canGenerateVideo(psid)).toBe(false);
      expect(await canTranscribe(psid)).toBe(false);
      expect(await reserveImageGenerationForAttempt(psid)).toBeNull();
      expect(await reserveVideoGenerationForAttempt(psid)).toBeNull();
      expect(await reserveTranscriptionForAttempt(psid)).toBeNull();
    });
  });

  it("fails closed on an unavailable shared state store and sends no false activation confirmation", async () => {
    await inScope(async () => {
      await seed();
      const ctx = await context("/testklant aan");
      const failedRead = vi
        .spyOn(messengerState, "getState")
        .mockRejectedValue(new Error("shared state unavailable"));
      try {
        await expect(
          readMessengerExecutionAccess(psid, userKey)
        ).rejects.toThrow("shared state unavailable");
        await customerTestModeFeature.onText!(ctx);
        expect(ctx.sendText).toHaveBeenCalledWith(
          expect.stringContaining("Omschakelen is nu niet mogelijk")
        );
        expect(ctx.logger.info).not.toHaveBeenCalled();
      } finally {
        failedRead.mockRestore();
      }
      expect((await getState(psid))?.customerTestMode).not.toBe(true);
    });
  });

  it("resets with erasure of the scoped conversation", async () => {
    await inScope(async () => {
      await seed();
      await setMessengerCustomerTestMode(psid, userKey, true);
      await clearUserState(psid);
      expect((await getOrCreateState(psid)).customerTestMode).not.toBe(true);
    });
  });

  it("handles commands before image features and never interprets invalid arguments as prompts", async () => {
    ensureDefaultBotFeaturesRegistered();
    const names = getBotFeatures().map(feature => feature.name);
    expect(names.indexOf("customerTestMode")).toBeLessThan(
      names.indexOf("imageRequest")
    );
    await inScope(async () => {
      await seed();
      const ctx = await context("/testklant aan voor iemand anders");
      expect(await customerTestModeFeature.onText!(ctx)).toEqual({
        handled: true,
      });
      expect((await getState(psid))?.customerTestMode).not.toBe(true);
      expect(ctx.runImageGeneration).not.toHaveBeenCalled();
    });
  });
});
