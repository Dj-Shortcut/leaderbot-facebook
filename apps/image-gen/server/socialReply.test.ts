import { describe, expect, it, vi } from "vitest";
import { getSocialReply } from "./_core/socialReply";
import {
  getMessengerMessageSocialReply,
  getMessengerReactionReply,
} from "./_core/messengerSocialReply";
import { handleSharedTextMessage } from "./_core/sharedTextHandler";
import { getEventDedupeKey } from "./_core/webhookHelpers";
import { t } from "./_core/i18n";

describe("social replies", () => {
  it.each([
    "Bedankt!",
    "dankjewel 😊",
    "Dank je wel!",
    "Merci ❤️",
    "Dank u wel",
    "Heel erg bedankt",
    "Thank you!",
    "Bedankt voor de mooie foto",
  ])("answers thanks: %s", text => {
    expect(getSocialReply(text, "nl")).toBe(t("nl", "socialThanks"));
  });
  it.each(["👍", "👍🏽", "❤️❤️", "🙏!", "😂", "🔥"])(
    "recognizes positive emoji: %s",
    text => {
      expect(getSocialReply(text, "nl")).toBe(t("nl", "socialPositive"));
    }
  );
  it.each(["👎", "😢", "😡", "👍👎"])(
    "does not celebrate negative feedback: %s",
    text => {
      expect(getSocialReply(text, "nl")).toBe(t("nl", "socialNegative"));
    }
  );
  it.each(["🇧🇪", "👩‍👩‍👧‍👦", "1️⃣", "😮"])(
    "acknowledges other emoji without guessing: %s",
    text => {
      expect(getSocialReply(text, "nl")).toBe(t("nl", "socialReaction"));
    }
  );
  it.each([
    "Bedankt, maak nu een kat",
    "Maak een logo met ❤️",
    "mooi maar ik zie geen paard",
    "nee bedankt",
    "verwijder mijn data",
    "123",
    "...",
    "ja",
    "ok",
  ])("preserves commands and other text: %s", text => {
    expect(getSocialReply(text, "nl")).toBeNull();
  });
  it("handles courtesy without touching state or starting features", async () => {
    const getState = vi.fn();
    const setFlowState = vi.fn();
    const runTextFeatures = vi.fn();
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "test-user",
        userId: "test-key",
        messageType: "text",
        textBody: "Bedankt!",
      },
      lang: "en",
      reqId: "social-test",
      getState,
      setFlowState,
      runTextFeatures,
    });
    expect(result).toEqual({ response: { text: t("en", "socialThanks") } });
    expect(getState).not.toHaveBeenCalled();
    expect(setFlowState).not.toHaveBeenCalled();
    expect(runTextFeatures).not.toHaveBeenCalled();
  });
  it("passes a long detailed prompt through unchanged, including its final instruction", async () => {
    const prompt =
      "Maak een afbeelding: " +
      "Gedetailleerde belichting, materialen en compositie. ".repeat(160) +
      "Zet een rode fiets rechtsonder.";
    const runTextFeatures = vi.fn(async () => true);
    await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "test-user",
        userId: "test-key",
        messageType: "text",
        textBody: prompt,
      },
      lang: "nl",
      reqId: "long-prompt-test",
      getState: vi.fn(async () => ({ stage: "IDLE" }) as never),
      setFlowState: vi.fn(),
      runTextFeatures,
    });
    expect(prompt.length).toBeGreaterThan(8_000);
    expect(runTextFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: prompt })
    );
  });
  it("recognizes an image-shaped sticker reply but preserves actual uploads", () => {
    const photo = {
      type: "image",
      payload: { url: "https://example.test/photo.jpg" },
    };
    expect(
      getMessengerMessageSocialReply(
        {
          sticker_id: 369239263222822,
          reply_to: { mid: "generated-photo" },
          attachments: [photo],
        },
        "nl"
      )
    ).toBe(t("nl", "socialReaction"));
    expect(
      getMessengerMessageSocialReply(
        {
          reply_to: { mid: "generated-photo" },
          text: "👍",
          attachments: [photo],
        },
        "nl"
      )
    ).toBeNull();
    expect(
      getMessengerMessageSocialReply(
        { sticker_id: "123", attachments: [photo, photo] },
        "nl"
      )
    ).toBeNull();
    expect(
      getMessengerMessageSocialReply(
        { text: "Maak een kat", attachments: [{ type: "sticker" }] },
        "nl"
      )
    ).toBeNull();
  });
  it("does not respond to removals and recognizes named reactions", () => {
    expect(
      getMessengerReactionReply(
        { action: "unreact", mid: "photo", emoji: "👍" },
        "nl"
      )
    ).toBeNull();
    expect(
      getMessengerReactionReply(
        { action: "react", mid: "photo", reaction: "love" },
        "nl"
      )
    ).toBe(t("nl", "socialPositive"));
  });
  it("deduplicates reactions independently of original messages, users and removals", () => {
    const event = {
      timestamp: 123,
      reaction: { action: "react" as const, mid: "photo", emoji: "👍" },
    };
    const key = getEventDedupeKey(event, "user-a", "page-a");
    expect(key).toBe(getEventDedupeKey(event, "user-a", "page-a"));
    expect(key).not.toBe(
      getEventDedupeKey({ message: { mid: "photo" } }, "user-a", "page-a")
    );
    expect(key).not.toBe(getEventDedupeKey(event, "user-b", "page-a"));
    expect(key).not.toBe(getEventDedupeKey(event, "user-a", "page-b"));
    expect(key).not.toBe(
      getEventDedupeKey(
        { ...event, reaction: { ...event.reaction, action: "unreact" } },
        "user-a",
        "page-a"
      )
    );
    expect(key).not.toContain("photo");
  });
});
