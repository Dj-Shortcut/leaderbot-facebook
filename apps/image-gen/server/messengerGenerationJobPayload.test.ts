import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReservedGenerationJob } from "./_core/messengerGenerationJobPayload";

const HOUR_MS = 60 * 60_000;
const CREATED_AT = 1_700_000_000_000;

const base = {
  psid: "psid-1",
  userId: "hashed-user",
  reqId: "request-1",
  lang: "nl",
};

const tenant = {
  workspaceId: 7,
  channelConnectionId: 11,
  bindingEpoch: 2,
  privacyEpoch: 3,
};

function parse(value: unknown) {
  return parseReservedGenerationJob(JSON.stringify(value));
}

describe("parseReservedGenerationJob", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the raw payload and parses a minimal job", () => {
    const raw = JSON.stringify(base);

    expect(parseReservedGenerationJob(raw)).toEqual({
      raw,
      job: { ...base, pageId: undefined },
    });
  });

  it("rejects payloads that are not a JSON object", () => {
    expect(parseReservedGenerationJob("{not json")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse([base])).toBeNull();
    expect(parse("job")).toBeNull();
  });

  it.each(["psid", "userId", "reqId"])(
    "rejects a job without a string %s",
    field => {
      expect(parse({ ...base, [field]: undefined })).toBeNull();
      expect(parse({ ...base, [field]: 42 })).toBeNull();
    }
  );

  it("only accepts supported UI languages", () => {
    expect(parse({ ...base, lang: "en" })?.job.lang).toBe("en");
    expect(parse({ ...base, lang: "fr" })).toBeNull();
    expect(parse({ ...base, lang: undefined })).toBeNull();
  });

  it("maps the legacy restyle kind to a source image edit", () => {
    expect(
      parse({ ...base, generationKind: "style_restyle" })?.job.generationKind
    ).toBe("source_image_edit");
    expect(
      parse({ ...base, generationKind: "text_to_image" })?.job.generationKind
    ).toBe("text_to_image");
    expect(parse({ ...base, generationKind: "sketch" })).toBeNull();
  });

  it("only accepts known operations", () => {
    expect(parse({ ...base, operation: "image" })?.job.operation).toBe("image");
    expect(parse({ ...base, operation: "audio" })).toBeNull();
  });

  it("requires a source image and prompt hint for video jobs", () => {
    const video = {
      ...base,
      operation: "video",
      sourceImageUrl: "https://example.test/source.png",
      promptHint: "Make it move",
    };

    expect(parse(video)?.job).toMatchObject({
      operation: "video",
      sourceImageUrl: video.sourceImageUrl,
      promptHint: video.promptHint,
    });
    expect(parse({ ...video, sourceImageUrl: undefined })).toBeNull();
    expect(parse({ ...video, sourceImageUrl: "" })).toBeNull();
    expect(parse({ ...video, promptHint: undefined })).toBeNull();
    expect(parse({ ...video, promptHint: "" })).toBeNull();
  });

  it("bounds the source image list", () => {
    const url = (index: number) => `https://example.test/${index}.png`;

    expect(
      parse({ ...base, sourceImageUrls: [url(1), url(2)] })?.job.sourceImageUrls
    ).toEqual([url(1), url(2)]);
    expect(parse({ ...base, sourceImageUrls: [] })).toBeNull();
    expect(
      parse({ ...base, sourceImageUrls: [1, 2, 3, 4, 5].map(url) })
    ).toBeNull();
    expect(parse({ ...base, sourceImageUrls: [url(1), "  "] })).toBeNull();
    expect(parse({ ...base, sourceImageUrls: url(1) })).toBeNull();
  });

  it("trims the page id and drops a blank one", () => {
    expect(parse({ ...base, pageId: " page-1 " })?.job.pageId).toBe("page-1");
    expect(parse({ ...base, pageId: "   " })?.job.pageId).toBeUndefined();
    expect(parse({ ...base, pageId: 12 })).toBeNull();
  });

  it("requires the tenant binding fields together", () => {
    expect(parse({ ...base, ...tenant })?.job).toMatchObject(tenant);

    for (const field of Object.keys(tenant)) {
      expect(parse({ ...base, ...tenant, [field]: undefined })).toBeNull();
    }
  });

  it.each([0, -1, 1.5, "7"])("rejects a workspace id of %j", workspaceId => {
    expect(parse({ ...base, ...tenant, workspaceId })).toBeNull();
  });

  it("validates the tenant partition when present", () => {
    expect(parse({ ...base, tenantPartition: "not a partition" })).toBeNull();
  });

  it("bounds job expiry to one day after creation", () => {
    const timed = { ...base, createdAt: CREATED_AT };

    expect(
      parse({ ...timed, expiresAt: CREATED_AT + 24 * HOUR_MS })?.job
    ).toMatchObject({
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 24 * HOUR_MS,
    });
    expect(parse({ ...timed, expiresAt: CREATED_AT })).toBeNull();
    expect(parse({ ...timed, expiresAt: CREATED_AT - 1 })).toBeNull();
    expect(
      parse({ ...timed, expiresAt: CREATED_AT + 24 * HOUR_MS + 1 })
    ).toBeNull();
    expect(parse({ ...base, createdAt: 0 })).toBeNull();
    expect(parse({ ...base, expiresAt: -5 })).toBeNull();
  });

  it("requires timestamps in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(parse(base)).toBeNull();
    expect(parse({ ...base, createdAt: CREATED_AT })).toBeNull();
    expect(
      parse({ ...base, createdAt: CREATED_AT, expiresAt: CREATED_AT + HOUR_MS })
    ).not.toBeNull();
  });

  it("only accepts non-negative integer attempt counts", () => {
    expect(parse({ ...base, attempts: 0 })?.job.attempts).toBe(0);
    expect(parse({ ...base, attempts: 3 })?.job.attempts).toBe(3);
    expect(parse({ ...base, attempts: -1 })).toBeNull();
    expect(parse({ ...base, attempts: 1.5 })).toBeNull();
  });
});
