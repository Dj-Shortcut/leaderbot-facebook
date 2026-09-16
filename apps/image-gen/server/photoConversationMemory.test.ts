import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MessengerUserState } from "./_core/messengerState";
import {
  appendPhotoConversationTurn,
  getPhotoConversationImages,
  normalizePhotoConversation,
  rememberPhotoConversationImages,
  type PhotoConversationImage,
} from "./_core/photoConversationMemory";

const url = (name: string) => `https://assets.example/synthetic/${name}.png`;
const image = (
  name: string,
  kind: PhotoConversationImage["kind"] = "uploaded"
): PhotoConversationImage => ({
  id: `image_${createHash("sha256").update(url(name)).digest("hex").slice(0, 16)}`,
  url: url(name),
  kind,
});
const state = (
  overrides: Partial<MessengerUserState> = {}
): MessengerUserState => ({
  psid: "synthetic-memory-user",
  userKey: "synthetic-memory-user-key",
  workspaceId: 11,
  channelConnectionId: 12,
  bindingEpoch: 3,
  privacyEpoch: 4,
  pageId: "synthetic-page",
  stage: "RESULT_READY",
  state: "RESULT_READY",
  lastPhotoUrl: null,
  lastPhoto: null,
  consentGiven: true,
  hasSeenIntro: true,
  quota: { dayKey: "2026-09-16", count: 0 },
  videoGenerationQuota: { dayKey: "2026-09-16", count: 0 },
  transcriptionQuota: { dayKey: "2026-09-16", count: 0 },
  updatedAt: 1_789_516_800_000,
  ...overrides,
});

describe("photo conversation image memory", () => {
  it("deduplicates before the four-source limit and keeps the latest kind and recency", () => {
    const normalized = normalizePhotoConversation({
      images: [
        image("dog"),
        image("person"),
        image("cat", "generated"),
        image("garden"),
        image("dog", "generated"),
        image("dog"),
      ],
    });

    expect(normalized.images).toEqual([
      image("person"),
      image("cat", "generated"),
      image("garden"),
      image("dog"),
    ]);
    expect(new Set(normalized.images.map(entry => entry.id)).size).toBe(4);
  });

  it("keeps URL validation and rebuilds IDs instead of trusting stored IDs", () => {
    const normalized = normalizePhotoConversation({
      images: [
        { ...image("dog"), id: "image_ffffffffffffffff" },
        null,
        { url: "data:image/png;base64,AA==", kind: "uploaded" },
        { url: "file:///synthetic.png", kind: "uploaded" },
        { url: `https://assets.example/${"a".repeat(4096)}`, kind: "uploaded" },
        { ...image("dog"), kind: "unsupported" },
      ],
    });

    expect(normalized.images).toEqual([image("dog")]);
  });

  it("uses the last legacy occurrence when upload and generated aliases overlap", () => {
    const legacy = state({
      pendingImageUrls: [url("dog"), url("person"), url("dog")],
      lastPhotoUrl: url("cat"),
      lastGeneratedUrl: url("person"),
    });

    expect(getPhotoConversationImages(legacy)).toEqual([
      image("dog"),
      image("cat"),
      image("person", "generated"),
    ]);
  });

  it("keeps initialized memory authoritative instead of reviving evicted sources", () => {
    const current = state({
      photoConversation: {
        images: [image("person"), image("person", "generated")],
        turns: [],
      },
      pendingImageUrls: [url("dog"), url("cat")],
      lastGeneratedUrl: url("garden"),
    });

    expect(getPhotoConversationImages(current)).toEqual([
      image("person", "generated"),
    ]);
    expect(
      getPhotoConversationImages({
        ...current,
        photoConversation: { images: [], turns: [] },
      })
    ).toEqual([]);
  });

  it("remembers repeated new sources once while preserving distinct recent sources and other memory", () => {
    const turn = { id: "turn-1", role: "user" as const, text: "Voeg samen" };
    const execution = {
      requestId: "request-1",
      completed: false,
      decision: {
        action: "edit" as const,
        reply: "",
        prompt: "Combine the dog and person.",
        imageIds: [image("dog").id, image("person").id],
      },
    };
    const current = state({
      photoConversation: {
        images: [image("dog"), image("person"), image("cat"), image("garden")],
        turns: [turn],
        executions: [execution],
      },
      pendingSourceImageDeleteUrls: [url("expired")],
    });
    const before = structuredClone(current);

    const remembered = rememberPhotoConversationImages(
      current,
      [url("cat"), url("beach"), url("beach"), url("garden")],
      "generated"
    );

    expect(remembered).toEqual({
      images: [
        image("person"),
        image("cat", "generated"),
        image("beach", "generated"),
        image("garden", "generated"),
      ],
      turns: [turn],
      executions: [execution],
    });
    expect(current).toEqual(before);
    const roundTrip = normalizePhotoConversation(remembered);
    expect(roundTrip).toEqual(remembered);
    expect(
      getPhotoConversationImages({ ...current, photoConversation: roundTrip })
    ).toEqual(remembered.images);
  });

  it("does not let duplicate retained references consume source slots when appending a turn", () => {
    const current = state({
      photoConversation: {
        images: [
          image("dog"),
          image("person"),
          image("cat"),
          image("garden"),
          image("dog", "generated"),
        ],
        turns: [],
      },
    });

    const updated = appendPhotoConversationTurn(current, {
      id: "turn-2",
      role: "assistant",
      text: "Welke beelden wil je samenvoegen?",
    });

    expect(updated.images).toEqual([
      image("person"),
      image("cat"),
      image("garden"),
      image("dog", "generated"),
    ]);
    expect(updated.turns).toHaveLength(1);
  });
});
