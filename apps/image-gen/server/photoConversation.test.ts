import * as statePersistence from "./_core/messengerStatePersistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  privacy: vi.fn(),
  binding: vi.fn(),
  claim: vi.fn(),
  started: vi.fn(),
  finalized: vi.fn(),
  spend: vi.fn(),
  append: vi.fn(),
  update: vi.fn(),
  download: vi.fn(),
  send: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./db", async original => ({
  ...(await original<typeof import("./db")>()),
  getConnectedFacebookPageConnection: m.binding,
}));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageKeyFromPublicUrl: (url: string) => new URL(url).pathname.slice(1),
  storageGet: async (key: string) => ({ url: `https://assets.example/${key}` }),
}));
vi.mock("./_core/messengerPrivacySubject", async original => ({
  ...(await original<typeof import("./_core/messengerPrivacySubject")>()),
  assertMessengerPrivacySubject: m.privacy,
}));
vi.mock("./_core/messengerProviderAttemptFence", () => ({
  claimMessengerProviderAttemptFence: m.claim,
  markMessengerProviderAttemptStarted: m.started,
  finalizeMessengerProviderAttemptFence: m.finalized,
}));
vi.mock("./_core/generationGuard", async original => ({
  ...(await original<typeof import("./_core/generationGuard")>()),
  admitMessengerProviderSpend: m.spend,
}));
vi.mock("./_core/costLedger", async original => ({
  ...(await original<typeof import("./_core/costLedger")>()),
  appendCostLedgerEntry: m.append,
  safelyUpdateCostLedgerEntry: m.update,
}));
vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  resolveStoredSourceImage: m.download,
}));
vi.mock("./_core/messengerApi", async original => ({
  ...(await original<typeof import("./_core/messengerApi")>()),
  sendText: m.send,
  sendQuickReplies: m.send,
  sendButtonTemplate: m.send,
}));
import { ensureDefaultBotFeaturesRegistered } from "./_core/bot/defaultFeatures";
import { photoConversationFeature } from "./_core/bot/features/photoConversationFeature";
import { createHandlerContext } from "./_core/webhookHandlerContext";
import { handleTextMessage } from "./_core/webhookTextMessageRouter";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import {
  clearPendingImageState,
  clearUserState,
  getOrCreateState,
  getState,
  resetStateStore,
  setConsentState,
  setLastGenerated,
  setPendingStoredImages,
} from "./_core/messengerState";
import { patchState } from "./_core/messengerStatePersistence";
import { toUserKey } from "./_core/privacy";
import {
  appendPhotoConversationTurn,
  getPhotoConversationImages,
  normalizePhotoConversation,
} from "./_core/photoConversationMemory";
import {
  parsePhotoConversationDecision,
  PHOTO_CONVERSATION_MODEL,
} from "./_core/photoConversation";
import {
  photoConversationInputTokenBound,
  PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
} from "./_core/photoConversationContract";
import { buildMessengerStorageObjectKey } from "./_core/messengerStorageObject";
import { MessengerSpendBudgetExceededError } from "./_core/generationGuard";
const psid = "synthetic-photo-user";
const scope = () => ({
  workspaceId: 11,
  channelConnectionId: 12,
  bindingEpoch: 3,
  privacyEpoch: 4,
  userKey: toUserKey(psid),
});
const within = <T>(task: () => Promise<T>) =>
  runWithMessengerRequestContext("synthetic-page", task, {
    channel: "facebook_messenger",
    ...scope(),
  });
function imageUrl(
  kind: "generated_image" | "inbound_source",
  n: number,
  overrides = {}
) {
  return `https://assets.example/${buildMessengerStorageObjectKey({ kind, scope: { ...scope(), ...overrides }, fileName: `178000000000${n}-00000000-0000-0000-0000-000000000000.png` })}`;
}
const reply = (
  text = "Dat had ik verkeerd begrepen. Bedoel je de hond naast je vriend?"
) => ({ action: "reply", reply: text, prompt: "", imageIds: [] });
const response = (value: unknown) => ({
  ok: true,
  json: async () => ({
    status: "completed",
    output_text: JSON.stringify(value),
    usage: { input_tokens: 1200, output_tokens: 80 },
  }),
});
const runImage = vi.fn(async () => ({ sent: true as const }));
const handler = () =>
  createHandlerContext({ defaultLang: "nl", runImageGeneration: runImage });
async function seed() {
  await getOrCreateState(psid);
  await setConsentState(psid, true);
}
async function say(text: string, reqId = "turn-1") {
  await handleTextMessage(handler(), {
    psid,
    userId: scope().userKey,
    reqId,
    lang: "nl",
    text,
  });
}
async function twoImages() {
  const dog = imageUrl("generated_image", 1),
    friend = imageUrl("inbound_source", 2);
  await setLastGenerated(psid, dog);
  await setPendingStoredImages(psid, [friend]);
  return {
    dog,
    friend,
    images: getPhotoConversationImages((await getState(psid))!),
  };
}
const edit = (ids: string[]) => ({
  action: "edit",
  reply: "",
  prompt: "Put the dog from image one beside the friend from image two.",
  imageIds: ids,
});
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    PRIVACY_PEPPER: "synthetic-conversation-pepper",
    REDIS_URL: "",
    MESSENGER_PHOTO_CONVERSATION_ENABLED: "true",
    OPENAI_API_KEY: "synthetic-key",
    BOT_TEXT_RATE_LIMIT_MAX: "100",
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal("fetch", m.fetch);
  m.privacy.mockResolvedValue(undefined);
  m.binding.mockResolvedValue({ id: 12, workspaceId: 11, bindingEpoch: 3 });
  m.claim.mockResolvedValue({
    kind: "owned",
    fence: { leaseToken: "synthetic-lease" },
  });
  m.started.mockResolvedValue(undefined);
  m.finalized.mockResolvedValue(undefined);
  m.spend.mockImplementation(async input => input.recordAttempt());
  m.append.mockResolvedValue(undefined);
  m.update.mockResolvedValue(undefined);
  m.download.mockResolvedValue({
    buffer: Buffer.alloc(6000),
    contentType: "image/png",
  });
  m.send.mockResolvedValue({ sent: true });
  m.fetch.mockResolvedValue(response(reply()));
  runImage.mockResolvedValue({ sent: true });
  resetStateStore();
  ensureDefaultBotFeaturesRegistered();
});
afterEach(() => {
  resetStateStore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("contextual photo service through Messenger routing", () => {
  it.each(["Voeg samen", "samenvoegen", "combine photos"])(
    "keeps both sources for %s",
    async text =>
      within(async () => {
        await seed();
        const { dog, friend, images } = await twoImages();
        expect(images.map(i => i.url)).toEqual([dog, friend]);
        m.fetch.mockResolvedValue(response(edit(images.map(i => i.id))));
        await say(text);
        expect(runImage).toHaveBeenCalledExactlyOnceWith(
          psid,
          scope().userKey,
          "turn-1",
          "nl",
          dog,
          edit([]).prompt,
          "source_image_edit",
          [dog, friend]
        );
        const body = JSON.parse(m.fetch.mock.calls[0][1].body);
        expect(body).toMatchObject({
          model: PHOTO_CONVERSATION_MODEL,
          store: false,
          text: { format: { type: "json_schema", strict: true } },
        });
        expect(
          body.input[1].content.filter(
            (c: { type: string }) => c.type === "input_image"
          )
        ).toHaveLength(2);
        expect(JSON.stringify(body)).not.toContain("assets.example");
        expect(m.spend).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantScope: expect.objectContaining(scope()),
            costEstimateComplete: true,
            estimatedCostUsd:
              photoConversationInputTokenBound(body) *
              PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
          })
        );
      })
  );
  it("responds to criticism without spending image quota, then uses context for the explicit request", async () =>
    within(async () => {
      await seed();
      const { dog, friend, images } = await twoImages();
      const quota = (await getState(psid))!.quota;
      await say("Niet wat ik vroeg");
      expect(runImage).not.toHaveBeenCalled();
      expect(m.send.mock.calls[0][1]).toBe(reply().reply);
      expect((await getState(psid))!.quota).toEqual(quota);
      m.fetch.mockResolvedValue(response(edit(images.map(i => i.id))));
      await say("Voeg de hond samen met mijn maat", "turn-2");
      expect(runImage).toHaveBeenCalledExactlyOnceWith(
        psid,
        scope().userKey,
        "turn-2",
        "nl",
        dog,
        edit([]).prompt,
        "source_image_edit",
        [dog, friend]
      );
      const data = JSON.parse(m.fetch.mock.calls[1][1].body);
      expect(data.input.slice(2, -1)).toEqual([
        { role: "user", content: "Niet wat ik vroeg" },
        { role: "assistant", content: reply().reply },
      ]);
      expect(data.input.at(-1)).toEqual({
        role: "user",
        content: "Voeg de hond samen met mijn maat",
      });
    }));
  it.each([
    "Dankjewel",
    "👍",
    "Wat zou een leuke achtergrond zijn?",
    "Haha die hond kijkt grappig",
  ])("responds to %s without generating", async text =>
    within(async () => {
      await seed();
      await twoImages();
      await say(text);
      expect(m.fetch).toHaveBeenCalledTimes(1);
      expect(runImage).not.toHaveBeenCalled();
    })
  );
  it("asks for missing sources despite AWAITING_EDIT_PROMPT", async () =>
    within(async () => {
      await seed();
      await setPendingStoredImages(psid, [imageUrl("inbound_source", 1)]);
      m.fetch.mockResolvedValue(
        response(reply("Met welke andere foto wil je deze samenvoegen?"))
      );
      await say("Voeg samen");
      expect(runImage).not.toHaveBeenCalled();
    }));
  it("uses the normal admission boundary for new images", async () =>
    within(async () => {
      await seed();
      m.fetch.mockResolvedValue(
        response({
          action: "generate",
          reply: "",
          prompt: "A brown dog in a garden.",
          imageIds: [],
        })
      );
      await say("Maak een hond");
      expect(runImage).toHaveBeenCalledExactlyOnceWith(
        psid,
        scope().userKey,
        "turn-1",
        "nl",
        undefined,
        "A brown dog in a garden.",
        "text_to_image"
      );
    }));
  it("does not repeat a completed turn or an already claimed provider attempt", async () =>
    within(async () => {
      await seed();
      await say("Niet wat ik vroeg");
      await say("Niet wat ik vroeg");
      m.claim.mockResolvedValue({
        kind: "unsafe_or_done",
        status: "ambiguous",
      });
      await say("Nog eens", "turn-2");
      expect(m.fetch).toHaveBeenCalledTimes(1);
      expect(m.send).toHaveBeenCalledTimes(1);
    }));
  it.each(["malformed", "unknown-source", "incomplete", "timeout"])(
    "fails closed on %s without legacy generation fallback",
    async failure =>
      within(async () => {
        await seed();
        await twoImages();
        if (failure === "timeout")
          m.fetch.mockRejectedValue(new Error("timeout"));
        else if (failure === "malformed")
          m.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ status: "completed", output_text: "invalid" }),
          });
        else if (failure === "incomplete")
          m.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
              status: "incomplete",
              output_text: JSON.stringify(reply()),
            }),
          });
        else m.fetch.mockResolvedValue(response(edit(["foreign"])));
        await say("Maak deze foto warmer");
        expect(m.fetch).toHaveBeenCalledTimes(1);
        expect(runImage).not.toHaveBeenCalled();
        expect((await getState(psid))!.photoConversation?.turns).toEqual([]);
        expect(m.finalized).toHaveBeenCalledWith(
          expect.anything(),
          failure === "timeout" ? "ambiguous" : "succeeded"
        );
      })
  );
  it("blocks spend before transport even for the owner", async () =>
    within(async () => {
      await seed();
      vi.stubEnv("MESSENGER_ADMIN_IDS", psid);
      m.spend.mockRejectedValue(new Error("cap reached"));
      await say("Maak een hond");
      expect(m.fetch).not.toHaveBeenCalled();
      expect(runImage).not.toHaveBeenCalled();
      expect(m.finalized).toHaveBeenCalledWith(
        expect.anything(),
        "known_failed"
      );
    }));
  it.each(["consent", "binding", "privacy", "foreign-image", "state-user"])(
    "blocks invalid %s before transport",
    async failure =>
      within(async () => {
        await seed();
        if (failure === "consent") await setConsentState(psid, false);
        if (failure === "binding") m.binding.mockResolvedValue(null);
        if (failure === "privacy")
          m.privacy.mockRejectedValue(new Error("erased"));
        if (failure === "foreign-image")
          await setLastGenerated(
            psid,
            imageUrl("generated_image", 1, { privacyEpoch: 3 })
          );
        if (failure === "state-user")
          await patchState(psid, { userKey: "f".repeat(64) });
        await say("Voeg samen");
        expect(m.fetch).not.toHaveBeenCalled();
        expect(runImage).not.toHaveBeenCalled();
      })
  );
  it("suppresses late output and history after erasure", async () =>
    within(async () => {
      await seed();
      m.fetch.mockImplementation(async () => {
        await clearUserState(psid);
        m.privacy.mockRejectedValue(new Error("erased"));
        return response(reply());
      });
      await say("Niet wat ik vroeg");
      expect(m.send).not.toHaveBeenCalled();
      expect(runImage).not.toHaveBeenCalled();
      expect(await getState(psid)).toBeNull();
    }));
  it("discards a stale response when new-image resets context during the call", async () =>
    within(async () => {
      await seed();
      const { images } = await twoImages();
      m.fetch.mockImplementation(async () => {
        await clearPendingImageState(psid);
        return response(edit(images.map(i => i.id)));
      });
      await say("Voeg samen");
      expect(m.send).toHaveBeenCalledTimes(1);
      expect(runImage).not.toHaveBeenCalled();
      expect((await getState(psid))!.photoConversation).toBeUndefined();
    }));
  it("keeps privacy and owner commands deterministic", async () =>
    within(async () => {
      await seed();
      for (const text of [
        "/testklant status",
        "/stats",
        "privacy",
        "new_image",
      ]) {
        const ctx = handler().createFeatureTextContext(
          psid,
          scope().userKey,
          "command",
          "nl",
          (await getState(psid))!,
          text,
          text,
          false
        );
        expect(await photoConversationFeature.onText!(ctx)).toEqual({
          handled: false,
        });
      }
      expect(m.fetch).not.toHaveBeenCalled();
    }));
  it("bounds context and clears it on new-image", async () =>
    within(async () => {
      await seed();
      for (let n = 1; n <= 6; n++)
        await setLastGenerated(psid, imageUrl("generated_image", n));
      let state = (await getState(psid))!;
      expect(getPhotoConversationImages(state).map(i => i.url)).toEqual(
        [3, 4, 5, 6].map(n => imageUrl("generated_image", n))
      );
      for (let n = 0; n < 20; n++)
        state = {
          ...state,
          photoConversation: appendPhotoConversationTurn(state, {
            id: String(n),
            role: "user",
            text: "synthetic",
          }),
        };
      expect(
        normalizePhotoConversation(state.photoConversation).turns
      ).toHaveLength(12);
      await patchState(psid, { photoConversation: state.photoConversation });
      await say("new_image");
      expect((await getState(psid))!.photoConversation).toBeUndefined();
      expect(getPhotoConversationImages((await getState(psid))!)).toEqual([]);
      expect(m.fetch).not.toHaveBeenCalled();
    }));
  it("keeps ordinary chat working when an old image is unavailable", async () =>
    within(async () => {
      await seed();
      await twoImages();
      m.download.mockRejectedValueOnce(new Error("object deleted"));
      await say("Hoe zou jij dit aanpakken?");
      expect(m.fetch).toHaveBeenCalledTimes(1);
      expect(runImage).not.toHaveBeenCalled();
      const body = JSON.parse(m.fetch.mock.calls[0][1].body);
      expect(
        JSON.parse(body.input[1].content[0].text).unavailableImageIds
      ).toHaveLength(1);
      expect(
        body.input[1].content.filter(
          (c: { type: string }) => c.type === "input_image"
        )
      ).toHaveLength(1);
      expect(m.spend).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedCostUsd:
            photoConversationInputTokenBound(body) *
            PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
        })
      );
    }));
  it("serializes overlapping messages and includes the first exchange in the second", async () =>
    within(async () => {
      await seed();
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>(resolve => {
        release = resolve;
      });
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      m.fetch.mockImplementationOnce(async () => {
        entered();
        await waiting;
        return response(reply("Dat kan zeker."));
      });
      const first = say("Ik zoek een idee", "concurrent-1");
      await started;
      const second = say("Iets met een hond", "concurrent-2");
      release();
      await Promise.all([first, second]);
      expect(m.fetch).toHaveBeenCalledTimes(2);
      expect(m.send).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(m.fetch.mock.calls[1][1].body).input.slice(2, -1)
      ).toContainEqual({ role: "user", content: "Ik zoek een idee" });
    }));
  it("explains a spend-budget block without asking the user to retry or starting generation", async () =>
    within(async () => {
      await seed();
      await twoImages();
      m.spend.mockRejectedValueOnce(
        new MessengerSpendBudgetExceededError(undefined, "user_daily")
      );
      await say(
        "Zoom uit zodat het bovenlichaam meer zichtbaar wordt",
        "budget-block"
      );
      expect(m.fetch).not.toHaveBeenCalled();
      expect(runImage).not.toHaveBeenCalled();
      expect(m.send).toHaveBeenCalledWith(
        psid,
        "De daglimiet voor beeldverwerking is bereikt. Je credits blijven behouden; deze aanvraag is niet gestart. Je kunt morgen weer verder."
      );
      expect(m.started).not.toHaveBeenCalled();
    }));
  it("invalidates old memory when uploads occur while the flag is disabled", async () =>
    within(async () => {
      await seed();
      await twoImages();
      vi.stubEnv("MESSENGER_PHOTO_CONVERSATION_ENABLED", "false");
      const latest = imageUrl("inbound_source", 3);
      await setPendingStoredImages(psid, [latest]);
      expect((await getState(psid))!.photoConversation).toBeUndefined();
      vi.stubEnv("MESSENGER_PHOTO_CONVERSATION_ENABLED", "true");
      expect(
        getPhotoConversationImages((await getState(psid))!).map(i => i.url)
      ).toContain(latest);
    }));
  it("replays a persisted edit decision after queue dispatch fails without repeating interpretation", async () =>
    within(async () => {
      await seed();
      const { images, dog, friend } = await twoImages();
      m.fetch.mockResolvedValue(response(edit(images.map(i => i.id))));
      runImage.mockRejectedValueOnce(new Error("queue unavailable"));
      await say("Voeg samen");
      expect(
        (await getState(psid))!.photoConversation?.executions?.[0].completed
      ).toBe(false);
      await say("Voeg samen");
      expect(m.fetch).toHaveBeenCalledTimes(1);
      expect(runImage).toHaveBeenCalledTimes(2);
      expect(runImage.mock.calls[1]).toEqual([
        psid,
        scope().userKey,
        "turn-1",
        "nl",
        dog,
        edit([]).prompt,
        "source_image_edit",
        [dog, friend],
      ]);
      expect(
        (await getState(psid))!.photoConversation?.executions?.[0].completed
      ).toBe(true);
    }));
  it("retries text dispatch from the cached decision after send failure", async () =>
    within(async () => {
      await seed();
      m.send.mockRejectedValueOnce(new Error("transport unavailable"));
      await say("Wat zou leuk zijn?");
      expect(
        (await getState(psid))!.photoConversation?.turns.filter(
          t => t.role === "assistant"
        )
      ).toEqual([]);
      await say("Wat zou leuk zijn?");
      expect(m.fetch).toHaveBeenCalledTimes(1);
      expect(
        (await getState(psid))!.photoConversation?.turns.filter(
          t => t.role === "assistant"
        )
      ).toEqual([
        { id: "turn-1:assistant", role: "assistant", text: reply().reply },
      ]);
    }));
  it("does not invite a second generation after dispatch succeeds but completion persistence fails", async () =>
    within(async () => {
      await seed();
      const { images } = await twoImages();
      m.fetch.mockResolvedValue(response(edit(images.map(i => i.id))));
      const original = statePersistence.patchState;
      const patch = vi
        .spyOn(statePersistence, "patchState")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("completion unavailable"));
      try {
        await say("Voeg samen");
        expect(runImage).toHaveBeenCalledTimes(1);
        expect(m.send).not.toHaveBeenCalled();
        expect(
          (await getState(psid))!.photoConversation?.executions?.[0].completed
        ).toBe(false);
      } finally {
        patch.mockRestore();
      }
    }));
  it("rejects invented sources, URLs and extra executable fields", () => {
    for (const value of [
      { ...reply(), reply: "https://untrusted.example" },
      { ...reply(), price: 1 },
      edit(["image_bad"]),
    ])
      expect(() =>
        parsePhotoConversationDecision(
          { status: "completed", output_text: JSON.stringify(value) },
          []
        )
      ).toThrow();
  });
});
