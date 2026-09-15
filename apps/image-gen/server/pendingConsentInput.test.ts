import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdPendingConsentInput,
  takePendingConsentInput,
  PENDING_CONSENT_MAX_TEXT_BYTES,
} from "./_core/pendingConsentInput";
import {
  clearUserState,
  getState,
  resetStateStore,
  setConsentState,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import { getStateTtlSeconds } from "./_core/stateStore";

const photo = (index: number) => ({
  type: "image",
  payload: { url: `https://example.test/${index}.jpg` },
});
const scoped = <T>(action: () => T | Promise<T>, page = "test-page") =>
  runWithMessengerRequestContext(page, async () => await action());

describe("pending processing consent", () => {
  beforeEach(() => {
    vi.stubEnv("PRIVACY_PEPPER", "pending-consent-test-pepper");
    vi.stubEnv("REDIS_URL", "");
    resetStateStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps four photo references and subsequent detailed instructions until consent", async () =>
    scoped(async () => {
      expect(
        await holdPendingConsentInput("user", {
          attachments: [photo(1), photo(2), photo(3), photo(4)],
        })
      ).toBe("held");
      const prompt =
        "Maak een afbeelding: " +
        "Gedetailleerd licht en compositie. ".repeat(300).trimEnd();
      expect(await holdPendingConsentInput("user", { text: prompt })).toBe(
        "held"
      );
      expect(await takePendingConsentInput("user")).toBeNull();
      await setConsentState("user", true);
      const results = await Promise.all([
        takePendingConsentInput("user"),
        takePendingConsentInput("user"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toEqual(
        expect.objectContaining({
          text: prompt,
          imageUrls: [1, 2, 3, 4].map(index => photo(index).payload.url),
        })
      );
      expect(getState("user")?.pendingConsentInput).toBeNull();
    }));

  it("does not extend the deadline and physically expires abandoned context", async () =>
    scoped(async () => {
      vi.useFakeTimers();
      await holdPendingConsentInput("user", { attachments: [photo(1)] });
      const deadline = getState("user")?.pendingConsentInput?.expiresAt;
      vi.advanceTimersByTime(10 * 60_000);
      await holdPendingConsentInput("user", { text: "Maak een schilderij" });
      expect(getState("user")?.pendingConsentInput?.expiresAt).toBe(deadline);
      expect(getStateTtlSeconds(getState("user"))).toBe(300);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(getState("user")).toBeNull();
      await setConsentState("user", true);
      expect(await takePendingConsentInput("user")).toBeNull();
    }));

  it("clears input on refusal and deletion", async () =>
    scoped(async () => {
      await holdPendingConsentInput("user", { text: "Maak een schilderij" });
      await setConsentState("user", false);
      expect(getState("user")?.pendingConsentInput).toBeNull();
      expect(
        await holdPendingConsentInput("user", { attachments: [photo(1)] })
      ).toBe("ignored");
      await clearUserState("user");
      await holdPendingConsentInput("user", { text: "Maak een kat" });
      await clearUserState("user");
      expect(getState("user")).toBeNull();
    }));

  it("isolates different users and Pages", async () => {
    await scoped(() =>
      holdPendingConsentInput("a", { attachments: [photo(1)] })
    );
    await scoped(async () => {
      await setConsentState("b", true);
      expect(await takePendingConsentInput("b")).toBeNull();
    });
    await scoped(async () => {
      await setConsentState("a", true);
      expect(await takePendingConsentInput("a")).toBeNull();
    }, "other-page");
    await scoped(async () => {
      await setConsentState("a", true);
      expect((await takePendingConsentInput("a"))?.imageUrls).toEqual([
        photo(1).payload.url,
      ]);
    });
  });

  it("rejects oversize input without silently resuming an older partial request", async () =>
    scoped(async () => {
      await holdPendingConsentInput("user", { text: "Maak een kat" });
      expect(
        await holdPendingConsentInput("user", {
          attachments: [1, 2, 3, 4, 5].map(photo),
        })
      ).toBe("limit");
      expect(getState("user")?.pendingConsentInput).toBeNull();
      expect(
        await holdPendingConsentInput("user", {
          text: "é".repeat(PENDING_CONSENT_MAX_TEXT_BYTES),
        })
      ).toBe("limit");
      expect(getState("user")?.pendingConsentInput).toBeNull();
    }));

  it("ignores likes, stickers and consented conversations", async () =>
    scoped(async () => {
      expect(
        await holdPendingConsentInput("user", {
          sticker_id: "123",
          attachments: [photo(1)],
        })
      ).toBe("ignored");
      expect(await holdPendingConsentInput("user", { text: "👍" })).toBe(
        "ignored"
      );
      await setConsentState("user", true);
      expect(
        await holdPendingConsentInput("user", { text: "Maak een kat" })
      ).toBe("ignored");
    }));
});
