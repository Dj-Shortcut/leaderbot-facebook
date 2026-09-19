import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishPendingConsentInput,
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
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  getStateTtlSeconds,
  readScopedState,
  readState,
  writeState,
} from "./_core/stateStore";
import { getPendingConsentStorageScope } from "./_core/messengerStatePersistence";
import type { PendingConsentInput } from "./_core/pendingConsentInputStore";
const readPending = (psid = "user") => {
  const scope = getPendingConsentStorageScope(psid);
  return readScopedState<PendingConsentInput>(
    scope.scope,
    scope.key
  ) as PendingConsentInput | null;
};

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
      expect(readPending()?.claim).toBeDefined();
      await finishPendingConsentInput("user", results.find(Boolean)!, true);
      expect(readPending()).toBeNull();
      expect(JSON.stringify(getState("user"))).not.toContain(prompt);
    }));

  it("does not extend the deadline and physically expires abandoned context", async () =>
    scoped(async () => {
      vi.useFakeTimers();
      await holdPendingConsentInput("user", { attachments: [photo(1)] });
      const deadline = readPending()?.expiresAt;
      vi.advanceTimersByTime(10 * 60_000);
      await holdPendingConsentInput("user", { text: "Maak een schilderij" });
      expect(readPending()?.expiresAt).toBe(deadline);
      // Simulate an old runtime rewriting the regular state with its 48-hour TTL.
      const key = getPendingConsentStorageScope("user").key;
      const oldState = readState(key);
      expect(JSON.stringify(oldState)).not.toContain("Maak een schilderij");
      expect(JSON.stringify(oldState)).not.toContain(photo(1).payload.url);
      expect(getStateTtlSeconds(oldState)).toBe(172800);
      await writeState(key, { ...(oldState as object), updatedAt: Date.now() });
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(readPending()).toBeNull();
      expect(getState("user")).not.toBeNull();
      await setConsentState("user", true);
      expect(await takePendingConsentInput("user")).toBeNull();
    }));

  it("clears input on refusal and deletion", async () =>
    scoped(async () => {
      await holdPendingConsentInput("user", { text: "Maak een schilderij" });
      await setConsentState("user", false);
      expect(readPending()).toBeNull();
      expect(
        await holdPendingConsentInput("user", { attachments: [photo(1)] })
      ).toBe("ignored");
      await clearUserState("user");
      await holdPendingConsentInput("user", { text: "Maak een kat" });
      await clearUserState("user");
      expect(getState("user")).toBeNull();
      expect(readPending()).toBeNull();
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
      expect(readPending()).toBeNull();
      expect(
        await holdPendingConsentInput("user", {
          text: "é".repeat(PENDING_CONSENT_MAX_TEXT_BYTES),
        })
      ).toBe("limit");
      expect(readPending()).toBeNull();
    }));

  it("ignores likes and stickers but reroutes newly consented conversations", async () =>
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
      ).toBe("consented");
    }));
  it("recovers a failed claim with the same operation identity", async () =>
    scoped(async () => {
      await holdPendingConsentInput("user", { text: "Maak een kat" });
      await setConsentState("user", true);
      const first = (await takePendingConsentInput("user"))!;
      await finishPendingConsentInput("user", first, false);
      const retry = (await takePendingConsentInput("user"))!;
      expect(retry.text).toBe(first.text);
      expect(retry.operationId).toBe(first.operationId);
      expect(retry.claim?.token).not.toBe(first.claim?.token);
      await finishPendingConsentInput("user", first, true);
      expect(readPending()?.claim?.token).toBe(retry.claim?.token);
      await finishPendingConsentInput("user", retry, true);
      expect(readPending()).toBeNull();
    }));

  it("recovers an abandoned claim without extending content expiry", async () =>
    scoped(async () => {
      vi.useFakeTimers();
      await holdPendingConsentInput("user", { text: "Maak een kat" });
      await setConsentState("user", true);
      const first = (await takePendingConsentInput("user"))!;
      vi.advanceTimersByTime(5 * 60_000 + 1);
      const retry = (await takePendingConsentInput("user"))!;
      expect(retry.operationId).toBe(first.operationId);
      expect(retry.expiresAt).toBe(first.expiresAt);
    }));
  it("rejects a request context belonging to another user", async () =>
    scoped(async () => {
      setMessengerRequestPrivacySubject({
        userKey: "wrong-user",
        privacyEpoch: 1,
      });
      await expect(
        holdPendingConsentInput("user", { text: "private prompt" })
      ).rejects.toThrow("subject is inconsistent");
    }));
});
