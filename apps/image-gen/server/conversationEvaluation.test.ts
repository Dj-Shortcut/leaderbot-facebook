import { beforeEach, describe, expect, it, vi } from "vitest";
const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("./_core/logger", () => ({ safeLog: log }));
import { createConversationEvaluation } from "./_core/conversationEvaluation";
import type { HandlerContext } from "./_core/webhookHandlerTypes";
import type { MessengerUserState } from "./_core/messengerState";
import { t } from "./_core/i18n";

function fixture(text: string, consentGiven = true) {
  const original = {
    sendLoggedText: vi.fn(async () => ({ sent: true })),
    sendLoggedActions: vi.fn(async () => ({ sent: true })),
    sendLoggedImage: vi.fn(async () => ({ sent: true })),
    runImageGeneration: vi.fn(async () => ({ sent: true })),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
  };
  const evaluation = createConversationEvaluation({
    event: { message: { text } },
    state: { consentGiven } as MessengerUserState,
    reqId: "f0caa415-f0d4-46dc-b6b3-556301bce550",
    lang: "nl",
    now: () => 1000,
  });
  return {
    evaluation,
    ctx: evaluation.wrap(original as unknown as HandlerContext),
    original,
  };
}

describe("bounded conversation evaluation", () => {
  beforeEach(() => {
    log.mockReset();
  });
  it("recognizes a courtesy incorrectly treated as an upload", async () => {
    const { evaluation, ctx } = fixture("Bedankt!");
    await ctx.sendLoggedText(
      "private-user",
      t("nl", "unsupportedSticker"),
      "req"
    );
    evaluation.finish();
    expect(log).toHaveBeenCalledWith(
      "messenger_conversation_evaluation",
      expect.objectContaining({
        intent: "social",
        findings: ["social_as_upload"],
      })
    );
  });
  it("flags generation from emoji", async () => {
    const { evaluation, ctx } = fixture("👍");
    await ctx.runImageGeneration(
      "user",
      "key",
      "req",
      "nl",
      undefined,
      "private-prompt",
      "text_to_image"
    );
    evaluation.finish();
    expect(log.mock.calls[0][1].findings).toContain(
      "social_started_generation"
    );
  });
  it("finds an explicit image request that receives only quick-start guidance", async () => {
    const { evaluation, ctx } = fixture(
      "Maak een afbeelding van een rode fiets"
    );
    await ctx.sendLoggedText("user", t("nl", "flowExplanation"), "req");
    evaluation.finish();
    expect(log.mock.calls[0][1].findings).toEqual(["image_request_unhandled"]);
  });
  it("records an accepted queued generation without claiming final delivery", async () => {
    const { evaluation, ctx } = fixture("Maak een afbeelding van een kat");
    await ctx.runImageGeneration(
      "user",
      "key",
      "req",
      "nl",
      undefined,
      "private-prompt",
      "text_to_image"
    );
    evaluation.finish();
    expect(log.mock.calls[0][1]).toMatchObject({
      accepted: true,
      generationRequested: true,
      findings: [],
    });
    expect(log.mock.calls[0][1]).not.toHaveProperty("delivered");
  });
  it("does not classify content before consent and never logs private values", async () => {
    const { evaluation, ctx } = fixture(
      "private-name@example.test Maak een afbeelding van mijn familie",
      false
    );
    await ctx.sendLoggedText(
      "private-user",
      "Secret reply https://private.test/photo",
      "req"
    );
    evaluation.finish();
    expect(log.mock.calls[0][1]).toMatchObject({
      contentCheck: "skipped",
      intent: "consent_or_control",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private|Secret|familie/
    );
  });
  it("preserves transport arguments, including delivery control", async () => {
    const { evaluation, ctx, original } = fixture("hoi");
    const control = { providerAttemptKey: "opaque-attempt" };
    await ctx.sendLoggedText("user", "hello", "req", control);
    expect(original.sendLoggedText).toHaveBeenCalledWith(
      "user",
      "hello",
      "req",
      control
    );
    evaluation.finish();
  });
  it("emits once and lets logging failure leave the response intact", async () => {
    const { evaluation, ctx } = fixture("hoi");
    await ctx.sendLoggedText("user", "hello", "req");
    log.mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    expect(() => evaluation.finish()).not.toThrow();
    evaluation.finish();
    expect(log).toHaveBeenCalledTimes(1);
  });
  it("distinguishes intentional acknowledgement silence", () => {
    const { evaluation } = fixture("ok");
    evaluation.finish();
    expect(log.mock.calls[0][1].findings).toEqual([]);
  });
  it("reports unexpected silence and errors", () => {
    const { evaluation } = fixture("Een gewone vraag");
    evaluation.finish(true);
    expect(log.mock.calls[0][1].findings).toEqual([
      "handler_error",
      "missing_reply",
    ]);
  });
});
