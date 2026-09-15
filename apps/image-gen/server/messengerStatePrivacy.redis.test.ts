import {
  finishPendingConsentInput,
  holdPendingConsentInput,
  PENDING_CONSENT_TTL_MS,
  takePendingConsentInput,
} from "./_core/pendingConsentInput";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getOrCreateState,
  getState,
  setConsentState,
  setLastGenerationContext,
} from "./_core/messengerState";
import {
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  getPendingConsentStorageScope,
  beginMessengerStatePrivacyErasure,
  deletePersistedStateForErasure,
  getPersistedStateForErasure,
} from "./_core/messengerStatePersistence";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const runRedis = process.env.RUN_REDIS_INTEGRATION === "1";
const suite = runRedis ? describe : describe.skip;

suite("Messenger state Redis privacy fence", () => {
  const originalPepper = process.env.PRIVACY_PEPPER;

  beforeEach(async () => {
    process.env.PRIVACY_PEPPER = "state-privacy-redis-test-pepper";
    resetRedisClientForTests();
    const redis = await getRedisClient();
    await redis.flushdb();
  });

  afterAll(() => {
    resetRedisClientForTests();
    if (originalPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPepper;
  });

  it("claims pending consent input once across concurrent Redis workers", async () => {
    const psid = "pending-consent-concurrent";
    await withFence(psid, 42, 7, 3, 5, async () => {
      await getOrCreateState(psid);
      await Promise.all([
        holdPendingConsentInput(psid, {
          attachments: [
            {
              type: "image",
              payload: { url: "https://example.test/pending.jpg" },
            },
          ],
        }),
        holdPendingConsentInput(psid, { text: "Maak een schilderij" }),
      ]);
      await setConsentState(psid, true);
      const results = await Promise.all([
        takePendingConsentInput(psid),
        takePendingConsentInput(psid),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toEqual(
        expect.objectContaining({
          text: "Maak een schilderij",
          imageUrls: ["https://example.test/pending.jpg"],
        })
      );
    });
  });

  it("fences pending input after erasure and across privacy epochs", async () => {
    const psid = "pending-consent-erasure";
    const userKey = await withFence(psid, 42, 7, 3, 5, async () => {
      const state = await getOrCreateState(psid);
      await holdPendingConsentInput(psid, { text: "Maak een schilderij" });
      return state.userKey;
    });
    await withFence(psid, 42, 7, 3, 6, async () => {
      await setConsentState(psid, true);
      expect(await takePendingConsentInput(psid)).toBeNull();
    });
    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey,
    });
    await expect(
      withFence(psid, 42, 7, 3, 5, () =>
        holdPendingConsentInput(psid, { text: "Late input" })
      )
    ).rejects.toThrow("subject is erased");
  });

  it("does not let a rollback state rewrite retain pending raw input", async () => {
    const psid = "pending-rollback";
    await withFence(psid, 42, 7, 3, 5, async () => {
      await holdPendingConsentInput(
        psid,
        { text: "private-pending-prompt" },
        Date.now() - PENDING_CONSENT_TTL_MS + 1000
      );
      const scope = getPendingConsentStorageScope(psid);
      const redis = await getRedisClient();
      const raw = (await redis.get(scope.stateKey))!;
      expect(raw).not.toContain("private-pending-prompt");
      expect(raw).not.toContain("pendingConsentInput");
      await redis.set(scope.stateKey, raw, "EX", 172800);
      expect(await redis.ttl(scope.storageKey)).toBeLessThanOrEqual(1);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(await redis.get(scope.storageKey)).toBeNull();
      expect(await redis.get(scope.stateKey)).not.toBeNull();
    });
  });

  it("reroutes a photo when a consent write wins an append CAS race", async () => {
    const psid = "pending-consent-race";
    await withFence(psid, 42, 7, 3, 5, async () => {
      const redis = await getRedisClient();
      const original = redis.eval.bind(redis);
      let raced = false;
      const spy = vi
        .spyOn(redis, "eval")
        .mockImplementation(async (script, count, ...args) => {
          if (!raced && script.includes("PXAT")) {
            raced = true;
            await setConsentState(psid, true);
          }
          return original(script, count, ...args);
        });
      try {
        expect(
          await holdPendingConsentInput(psid, {
            attachments: [
              {
                type: "image",
                payload: { url: "https://example.test/race.jpg" },
              },
            ],
          })
        ).toBe("consented");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("keeps failed Redis claims recoverable until ack and deletes content on erasure", async () => {
    const psid = "pending-claim-erasure";
    const owned = await withFence(psid, 42, 7, 3, 5, async () => {
      await holdPendingConsentInput(psid, { text: "pending-private" });
      await setConsentState(psid, true);
      const claimed = (await takePendingConsentInput(psid))!;
      await finishPendingConsentInput(psid, claimed, false);
      const retry = (await takePendingConsentInput(psid))!;
      expect(retry.operationId).toBe(claimed.operationId);
      const state = (await getState(psid))!;
      return {
        state,
        storageKey: getPendingConsentStorageScope(psid).storageKey,
      };
    });
    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey: owned.state.userKey,
    });
    await withErasureFence(psid, 42, 7, 3, 6, 5, async () => {
      await deletePersistedStateForErasure(psid, owned.state);
    });
    expect(await (await getRedisClient()).get(owned.storageKey)).toBeNull();
  });

  it.each([false, true])(
    "refuses consent and removes pending content atomically, failure after commit=%s",
    async afterCommit => {
      const psid = "pending-refusal-failure";
      await withFence(psid, 42, 7, 3, 5, async () => {
        await getOrCreateState(psid);
        await holdPendingConsentInput(psid, { text: "private-pending" });
        const scope = getPendingConsentStorageScope(psid);
        const redis = await getRedisClient();
        const original = redis.eval.bind(redis);
        const spy = vi
          .spyOn(redis, "eval")
          .mockImplementationOnce(async (...args) => {
            if (afterCommit) await original(...args);
            throw new Error("refusal write unavailable");
          });
        try {
          await expect(setConsentState(psid, false)).rejects.toThrow(
            "refusal write unavailable"
          );
        } finally {
          spy.mockRestore();
        }
        const stored = JSON.parse((await redis.get(scope.stateKey))!);
        const pending = await redis.get(scope.storageKey);
        expect(stored.consentDeclinedAt !== undefined).toBe(afterCommit);
        expect(pending === null).toBe(afterCommit);
        if (!afterCommit) {
          await setConsentState(psid, false);
          expect(await redis.get(scope.storageKey)).toBeNull();
        }
      });
    }
  );

  it.each([false, true])(
    "strips legacy embedded content on state writes, refusal=%s",
    async refusal => {
      const psid = "legacy-embedded-pending";
      await withFence(psid, 42, 7, 3, 5, async () => {
        const state = await getOrCreateState(psid);
        await holdPendingConsentInput(psid, { text: "sidecar-private" });
        const scope = getPendingConsentStorageScope(psid);
        const redis = await getRedisClient();
        await redis.set(
          scope.stateKey,
          JSON.stringify({
            ...state,
            pendingConsentInput: {
              text: "legacy-private",
              imageUrls: ["https://example.test/legacy.jpg"],
              expiresAt: Date.now() + 900000,
            },
          }),
          "EX",
          900
        );
        if (refusal) await setConsentState(psid, false);
        else
          await setLastGenerationContext(psid, { prompt: "consented-context" });
        const raw = (await redis.get(scope.stateKey))!;
        expect(raw).not.toContain("pendingConsentInput");
        expect(raw).not.toContain("legacy-private");
        expect(raw).not.toContain("legacy.jpg");
        expect((await redis.get(scope.storageKey)) === null).toBe(refusal);
      });
    }
  );

  it("atomically rejects stale state writes after the subject is erased", async () => {
    const psid = "state-privacy-user-a";
    const userKey = await withFence(psid, 42, 7, 3, 5, async () => {
      const state = await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
      return state.userKey;
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey,
    });

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "must-not-survive" },
            Date.now()
          )
        );
      })
    ).rejects.toThrow("subject is erased");

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();

    await expect(
      withFence(psid, 42, 7, 3, 5, async () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toEqual(
      expect.objectContaining({
        userKey,
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
      })
    );
  });

  it("does not tombstone the same user key in another tenant scope", async () => {
    const psid = "state-privacy-shared-user";
    const first = await withFence(psid, 42, 7, 3, 1, async () =>
      Promise.resolve(getOrCreateState(psid))
    );
    await withFence(psid, 84, 9, 1, 1, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 2,
      userKey: first.userKey,
    });

    await expect(
      withFence(psid, 84, 9, 1, 1, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "tenant-b-survives" },
            Date.now()
          )
        );
        return await Promise.resolve(getState(psid));
      })
    ).resolves.toEqual(
      expect.objectContaining({ lastPrompt: "tenant-b-survives" })
    );
  });

  it("lets an erasing epoch scrub only its immediately preceding data epoch", async () => {
    const psid = "state-privacy-erasure-retry";
    const oldState = await withFence(psid, 42, 7, 3, 5, async () => {
      await getOrCreateState(psid);
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "old-private-state" })
      );
      return await Promise.resolve(getState(psid));
    });
    expect(oldState).toEqual(expect.objectContaining({ privacyEpoch: 5 }));

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey: oldState!.userKey,
    });

    await expect(
      withErasureFence(psid, 42, 7, 3, 6, 5, async () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toEqual(
      expect.objectContaining({
        lastPrompt: "old-private-state",
        privacyEpoch: 5,
      })
    );

    await withFence(psid, 42, 7, 3, 7, async () => {
      await getOrCreateState(psid);
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "reactivated-private-state" })
      );
    });

    await withErasureFence(psid, 42, 7, 3, 6, 5, async () => {
      await Promise.resolve(deletePersistedStateForErasure(psid, oldState!));
    });

    await expect(
      withFence(psid, 42, 7, 3, 7, async () => Promise.resolve(getState(psid)))
    ).resolves.toEqual(
      expect.objectContaining({
        lastPrompt: "reactivated-private-state",
        privacyEpoch: 7,
      })
    );
  });
});

async function withFence<T>(
  psid: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    `page-${workspaceId}`,
    async () => {
      const state = await Promise.resolve(getOrCreateStateForUserKey(psid));
      setMessengerRequestPrivacySubject({
        userKey: state.userKey,
        privacyEpoch,
      });
      return action();
    },
    { workspaceId, channelConnectionId, bindingEpoch }
  );
}

async function withErasureFence<T>(
  psid: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number,
  dataPrivacyEpoch: number,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    `page-${workspaceId}`,
    async () => {
      const { toUserKey } = await import("./_core/privacy");
      setMessengerRequestErasurePrivacySubject({
        userKey: toUserKey(psid),
        privacyEpoch,
        dataPrivacyEpoch,
      });
      return action();
    },
    { workspaceId, channelConnectionId, bindingEpoch }
  );
}

async function getOrCreateStateForUserKey(psid: string) {
  // The first state call needs the privacy subject in request context. Derive
  // the same privacy-safe key without persisting any raw identifier.
  const { toUserKey } = await import("./_core/privacy");
  const userKey = toUserKey(psid);
  setMessengerRequestPrivacySubject({ userKey, privacyEpoch: 1 });
  return { userKey };
}
