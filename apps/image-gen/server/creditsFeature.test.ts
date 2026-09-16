import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  free: vi.fn(),
  premium: vi.fn(),
  privacy: vi.fn(),
  ownership: vi.fn(),
}));
vi.mock("./_core/messengerImageQuotaStore", () => ({
  getMessengerImageQuotaStatus: m.free,
}));
vi.mock("./_core/billing/creditGenerationAdmission", () => ({
  readPaidCreditBalance: m.premium,
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: m.privacy,
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: m.ownership,
}));
import { creditsFeature } from "./_core/bot/features/creditsFeature";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import { createDefaultState } from "./_core/messengerStateNormalization";
import { toUserKey } from "./_core/privacy";
import type { BotTextContext } from "./_core/botContext";
import { CREDIT_BALANCE_ACTION } from "./_core/creditBalanceAction";

const senderId = "synthetic-credit-user";
const scope = () => ({
  workspaceId: 1,
  channelConnectionId: 2,
  bindingEpoch: 3,
  privacyEpoch: 4,
  userKey: toUserKey(senderId),
});
function context(text = "Credits"): BotTextContext {
  return {
    channel: "messenger",
    senderId,
    userId: scope().userKey,
    reqId: "synthetic-credit-request",
    lang: "nl",
    messageText: text,
    normalizedText: text.toLowerCase(),
    hasPhoto: true,
    state: {
      ...createDefaultState(senderId),
      ...scope(),
      pageId: "synthetic-page",
      consentGiven: true,
      stage: "AWAITING_EDIT_PROMPT",
      lastPrompt: "synthetic pending edit",
      pendingEditIntent: "change_background",
    },
    sendActions: vi.fn(),
    sendText: vi.fn(),
    setFlowState: vi.fn(),
    setPendingEditIntent: vi.fn(),
    runImageGeneration: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as BotTextContext;
}
const run = (ctx: BotTextContext) =>
  runWithMessengerRequestContext(
    "synthetic-page",
    async () => creditsFeature.onText!(ctx),
    { ...scope(), channel: "facebook_messenger" }
  );

describe("Messenger Credits action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.PRIVACY_PEPPER = "synthetic-credit-pepper";
    m.free.mockResolvedValue({
      daily: { remaining: 2, limit: 5 },
      monthly: { remaining: 12, limit: 20 },
    });
    m.premium.mockResolvedValue(6);
  });
  it.each(["Credits", "credits", "/credits", "saldo", " /saldo "])(
    "reads the exact scoped balance for %s and preserves the edit",
    async command => {
      const ctx = context(command),
        before = structuredClone(ctx.state);
      expect(await run(ctx)).toEqual({ handled: true });
      expect(m.premium).toHaveBeenCalledWith({
        ...scope(),
        requestId: ctx.reqId,
      });
      expect(m.free).toHaveBeenCalledWith(scope());
      expect(ctx.sendActions).toHaveBeenCalledWith(
        "Gratis afbeeldingen: vandaag nog 2 van 5. Deze maand nog 12 van 20.\nPremiumcredits: 6 beschikbaar.",
        [CREDIT_BALANCE_ACTION]
      );
      expect(ctx.state).toEqual(before);
      expect(ctx.setFlowState).not.toHaveBeenCalled();
      expect(ctx.setPendingEditIntent).not.toHaveBeenCalled();
      expect(ctx.runImageGeneration).not.toHaveBeenCalled();
    }
  );
  it("reports a real zero balance", async () => {
    m.premium.mockResolvedValue(0);
    const ctx = context();
    await run(ctx);
    expect(ctx.sendActions).toHaveBeenCalledWith(
      expect.stringContaining("Premiumcredits: 0 beschikbaar."),
      expect.any(Array)
    );
  });
  it.each([null, new Error("synthetic database failure")])(
    "does not report zero when premium balance is unavailable",
    async result => {
      if (result instanceof Error) m.premium.mockRejectedValue(result);
      else m.premium.mockResolvedValue(result);
      const ctx = context();
      await run(ctx);
      expect(ctx.sendActions).toHaveBeenCalledWith(
        expect.stringContaining(
          "Premiumcredits: saldo momenteel niet beschikbaar."
        ),
        expect.any(Array)
      );
    }
  );
  it("still reports premium credits when the free-quota read fails", async () => {
    m.free.mockRejectedValue(new Error("synthetic quota failure"));
    const ctx = context();
    await run(ctx);
    expect(ctx.sendActions).toHaveBeenCalledWith(
      "Gratis afbeeldingen: saldo momenteel niet beschikbaar.\nPremiumcredits: 6 beschikbaar.",
      expect.any(Array)
    );
  });
  it.each([
    { consentGiven: false },
    { userKey: "b".repeat(64) },
    { privacyEpoch: 9 },
    { pageId: "other-page" },
    { channelConnectionId: 9 },
  ])(
    "rejects stale or foreign state %j before reading balances",
    async patch => {
      const ctx = context();
      Object.assign(ctx.state, patch);
      await run(ctx);
      expect(m.free).not.toHaveBeenCalled();
      expect(m.premium).not.toHaveBeenCalled();
      expect(ctx.sendActions).toHaveBeenCalledWith(
        expect.stringContaining("momenteel niet beschikbaar"),
        expect.any(Array)
      );
    }
  );
  it.each(["privacy", "teken credits op de muur", "maak een hond"])(
    "leaves ordinary input alone: %s",
    async text => {
      const ctx = context(text);
      expect(await run(ctx)).toEqual({ handled: false });
      expect(m.premium).not.toHaveBeenCalled();
    }
  );
  it("rejects a changed database privacy fence", async () => {
    m.privacy.mockRejectedValue(new Error("erased"));
    const ctx = context();
    await run(ctx);
    expect(m.premium).not.toHaveBeenCalled();
  });
  it("requires the request scope even if state claims ownership", async () => {
    const ctx = context();
    await creditsFeature.onText!(ctx);
    expect(m.premium).not.toHaveBeenCalled();
  });
  it("renders English balances", async () => {
    const ctx = context();
    ctx.lang = "en";
    await run(ctx);
    expect(ctx.sendActions).toHaveBeenCalledWith(
      expect.stringContaining("Premium credits: 6 available."),
      [CREDIT_BALANCE_ACTION]
    );
  });
});
