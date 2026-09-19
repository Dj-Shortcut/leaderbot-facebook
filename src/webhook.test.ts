import { describe, expect, it } from "vitest";
import {
  extractMessengerAttachmentUrls,
  extractMessengerImageAttachmentUrls,
  extractMessengerInboundMessages,
  handleMessengerWebhookVerification,
  normalizeMessengerAttachmentKind,
} from "./webhook.js";

function createResponse() {
  const response = {
    statusCode: 0,
    headers: new Map<string, string>(),
    body: "",
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    end(body?: string) {
      this.body = body ?? "";
    },
  };
  return response;
}

describe("handleMessengerWebhookVerification", () => {
  it("accepts the subscribed verification challenge", () => {
    const response = createResponse();

    expect(
      handleMessengerWebhookVerification({
        url: new URL(
          "https://example.test/webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=challenge-42",
        ),
        verifyToken: "secret",
        res: response,
      }),
    ).toBe(true);

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.body).toBe("challenge-42");
  });

  it("rejects an unsupported mode or mismatched token", () => {
    for (const url of [
      "https://example.test/webhook?hub.mode=publish&hub.verify_token=secret",
      "https://example.test/webhook?hub.mode=subscribe&hub.verify_token=wrong",
    ]) {
      const response = createResponse();

      expect(
        handleMessengerWebhookVerification({
          url: new URL(url),
          verifyToken: "secret",
          res: response,
        }),
      ).toBe(true);
      expect(response.statusCode).toBe(403);
      expect(response.body).toBe("Forbidden");
    }
  });
});

describe("normalizeMessengerAttachmentKind", () => {
  it("normalizes supported types and rejects unknown values", () => {
    expect(normalizeMessengerAttachmentKind(" IMAGE ")).toBe("image");
    expect(normalizeMessengerAttachmentKind("audio")).toBe("audio");
    expect(normalizeMessengerAttachmentKind("video")).toBe("video");
    expect(normalizeMessengerAttachmentKind("file")).toBe("file");
    expect(normalizeMessengerAttachmentKind("sticker")).toBe("unknown");
    expect(normalizeMessengerAttachmentKind(undefined)).toBe("unknown");
  });
});

describe("extractMessengerInboundMessages", () => {
  it("keeps text Page messages and skips echoes or unsupported events", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: { mid: "m1", text: "hello" },
            },
            {
              sender: { id: "page-1" },
              recipient: { id: "psid-1" },
              message: { mid: "m2", text: "echo", is_echo: true },
            },
            {
              sender: { id: "psid-2" },
              recipient: { id: "page-1" },
              message: { mid: "m3" },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sender?.id).toBe("psid-1");
    expect(messages[0]?.message?.text).toBe("hello");
  });

  it("keeps image-only Page messages", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://example.test/photo.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(extractMessengerImageAttachmentUrls(messages[0]!)).toEqual([
      "https://example.test/photo.jpg",
    ]);
  });

  it("keeps image-only Page messages even when payload.url is missing", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "image",
                    payload: {},
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(extractMessengerAttachmentUrls(messages[0]!)).toEqual([]);
  });

  it("keeps audio-only Page messages", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "audio",
                    payload: { url: "https://example.test/voice.mp4" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(extractMessengerAttachmentUrls(messages[0]!)).toEqual([
      {
        type: "audio",
        kind: "audio",
        url: "https://example.test/voice.mp4",
      },
    ]);
  });

  it("keeps file-only Page messages", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "file",
                    payload: { url: "https://example.test/file.pdf" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(extractMessengerAttachmentUrls(messages[0]!)).toEqual([
      {
        type: "file",
        kind: "file",
        url: "https://example.test/file.pdf",
      },
    ]);
  });

  it("keeps quick replies and postbacks without text", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: { mid: "m1", quick_reply: { payload: "RETRY_STYLE_gold" } },
            },
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              postback: { payload: "CHOOSE_STYLE" },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message?.quick_reply?.payload).toBe("RETRY_STYLE_gold");
    expect(messages[1]?.postback?.payload).toBe("CHOOSE_STYLE");
  });
});
