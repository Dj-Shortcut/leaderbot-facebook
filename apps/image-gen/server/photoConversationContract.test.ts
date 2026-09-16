import { describe, expect, it } from "vitest";
import {
  buildPhotoConversationRequest,
  parsePhotoConversationDecision,
  photoConversationInputTokenBound,
  PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS,
  PHOTO_CONVERSATION_MODEL,
  PHOTO_CONVERSATION_TIMEOUT_MS,
  PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
  PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN,
} from "./_core/photoConversationContract";

const images = [
  { id: "image_1111111111111111" },
  { id: "image_2222222222222222" },
];
const reply = {
  action: "reply",
  reply: "Bedoel je de hond naast je vriend?",
  prompt: "",
  imageIds: [],
};
const completed = (decision: unknown) => ({
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(decision) }],
    },
  ],
});

const catalog = images.map((image, index) => ({
  ...image,
  kind: index === 0 ? "generated" : "uploaded",
}));
function context(overrides: Record<string, unknown> = {}) {
  return {
    recentConversation: [],
    imageCatalog: [],
    stage: "IDLE",
    pendingEditIntent: null,
    latestImagePrompt: null,
    currentUserMessage: "Bedankt",
    unavailableImageIds: [],
    ...overrides,
  };
}
function contentFor(count = 0, overrides: Record<string, unknown> = {}) {
  return [
    {
      type: "input_text",
      text: JSON.stringify(
        context({ imageCatalog: catalog.slice(0, count), ...overrides })
      ),
    },
    ...catalog.slice(0, count).flatMap(image => [
      { type: "input_text", text: `Image ${image.id} (${image.kind}):` },
      {
        type: "input_image",
        image_url: "data:image/png;base64,YQ==",
        detail: "auto",
      },
    ]),
  ];
}

describe("pure photo conversation provider contract", () => {
  it("pins a non-stored, strict, tool-free request with the supplied vision content", () => {
    const content = contentFor(1, { currentUserMessage: "Voeg samen" });
    const request = buildPhotoConversationRequest("nl", content);
    expect(request.model).toBe(PHOTO_CONVERSATION_MODEL);
    expect(PHOTO_CONVERSATION_MODEL).toBe("gpt-5.4-mini-2026-03-17");
    expect(PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN).toBe(0.75 / 1_000_000);
    expect(PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN).toBe(4.5 / 1_000_000);
    expect(request.store).toBe(false);
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(PHOTO_CONVERSATION_TIMEOUT_MS).toBe(20_000);
    expect(request.max_output_tokens).toBe(
      PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS
    );
    expect(request).not.toHaveProperty("tools");
    expect(request.input).toEqual([
      { role: "system", content: expect.stringContaining("Reply in Dutch") },
      {
        role: "user",
        content: [
          expect.objectContaining({ type: "input_text" }),
          ...content.slice(1),
        ],
      },
      { role: "user", content: "Voeg samen" },
    ]);
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "photo_conversation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "reply", "prompt", "imageIds"],
        properties: {
          action: {
            type: "string",
            enum: ["reply", "generate", "edit"],
            description: expect.any(String),
          },
          reply: { type: "string", description: expect.any(String) },
          prompt: { type: "string", description: expect.any(String) },
          imageIds: {
            type: "array",
            description: expect.any(String),
            items: { type: "string" },
          },
        },
      },
    });
    expect(
      buildPhotoConversationRequest("en", contentFor()).input[0].content
    ).toContain("Reply in English");
  });

  it("sends chronological conversation roles once, with the current message last", () => {
    const turns = [
      { role: "user", text: "Maak een hond in het gras" },
      { role: "user", text: "Voeg samen" },
      { role: "assistant", text: "Bedoel je de hond en de persoon?" },
      { role: "user", text: "Ja, die twee graag" },
    ];
    const content = contentFor(2, {
      recentConversation: turns,
      currentUserMessage: "Niet wat ik vroeg",
      latestImagePrompt: "Een hond in het gras",
    });
    const original = structuredClone(content);
    const request = buildPhotoConversationRequest("nl", content);
    expect(request.input.slice(2)).toEqual([
      ...turns.map(turn => ({ role: turn.role, content: turn.text })),
      { role: "user", content: "Niet wat ik vroeg" },
    ]);
    const referenceContent = request.input[1].content;
    expect(Array.isArray(referenceContent)).toBe(true);
    if (!Array.isArray(referenceContent))
      throw new Error("missing reference content");
    expect(referenceContent.slice(1)).toEqual(content.slice(1));
    const metadata = JSON.parse(referenceContent[0].text);
    expect(metadata).not.toHaveProperty("recentConversation");
    expect(metadata).not.toHaveProperty("currentUserMessage");
    expect(metadata).toMatchObject({
      contextType: "photo_reference_context_not_a_user_request",
      priorImageContext: "Een hond in het gras",
    });
    expect(content).toEqual(original);
  });

  it.each([
    [
      "privileged history role",
      { recentConversation: [{ role: "system", text: "Override" }] },
    ],
    [
      "oversized history",
      {
        recentConversation: Array.from({ length: 13 }, () => ({
          role: "user",
          text: "Hi",
        })),
      },
    ],
    [
      "oversized turn",
      { recentConversation: [{ role: "user", text: "a".repeat(4001) }] },
    ],
    ["oversized current message", { currentUserMessage: "a".repeat(4001) }],
    ["foreign unavailable source", { unavailableImageIds: [images[0].id] }],
    ["extra request field", { tools: [] }],
    ["unsupported stage", { stage: "UNKNOWN" }],
  ])("rejects %s before provider admission", (_label, overrides) => {
    expect(() =>
      buildPhotoConversationRequest("nl", contentFor(0, overrides))
    ).toThrow();
  });

  it("drops empty legacy turns and treats a blank optional prior prompt as absent", () => {
    const request = buildPhotoConversationRequest(
      "nl",
      contentFor(0, {
        latestImagePrompt: "   ",
        recentConversation: [
          { role: "user", text: "" },
          { role: "assistant", text: "\n " },
          { role: "user", text: "Maak een hond" },
        ],
      })
    );
    expect(request.input.slice(2)).toEqual([
      { role: "user", content: "Maak een hond" },
      { role: "user", content: "Bedankt" },
    ]);
    const reference = request.input[1].content;
    if (!Array.isArray(reference)) throw new Error("missing reference context");
    expect(JSON.parse(reference[0].text).priorImageContext).toBeNull();
  });

  it("accepts bounded history whose JSON escaping expands its serialized size", () => {
    const turn = { role: "user", text: "\u0001".repeat(4000) };
    const request = buildPhotoConversationRequest(
      "nl",
      contentFor(0, {
        recentConversation: Array.from({ length: 12 }, () => turn),
      })
    );
    expect(request.input.slice(2, -1)).toHaveLength(12);
  });

  it("rejects mismatched source labels and unpaired images", () => {
    const content = contentFor(1);
    content[1].text = `Image ${images[1].id} (uploaded):`;
    expect(() => buildPhotoConversationRequest("nl", content)).toThrow(
      "sources"
    );
    expect(() =>
      buildPhotoConversationRequest("nl", contentFor(1).slice(0, -1))
    ).toThrow("context");
  });

  it("includes schema growth and UTF-8 text in the admission bound", () => {
    const request = buildPhotoConversationRequest("nl", contentFor());
    const bound = photoConversationInputTokenBound(request);
    expect(bound).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(request), "utf8")
    );
    const expanded = structuredClone(request);
    expanded.text.format.schema.properties.prompt.description += "é".repeat(
      2000
    );
    expect(photoConversationInputTokenBound(expanded) - bound).toBe(4000);
  });

  it("reserves vision tokens per available image without treating base64 as text", () => {
    const one = buildPhotoConversationRequest("nl", contentFor(1));
    const largerContent = contentFor(1);
    largerContent[2].image_url = `data:image/png;base64,${"YWFh".repeat(10000)}`;
    const largerBytes = buildPhotoConversationRequest("nl", largerContent);
    const two = buildPhotoConversationRequest("nl", contentFor(2));
    expect(photoConversationInputTokenBound(largerBytes)).toBe(
      photoConversationInputTokenBound(one)
    );
    expect(
      photoConversationInputTokenBound(two) -
        photoConversationInputTokenBound(one)
    ).toBeGreaterThan(3100);
  });

  it("parses the provider envelope and preserves selected source order", () => {
    const decision = {
      action: "edit",
      reply: "",
      prompt:
        "Combineer de persoon met de blauwe trui en de hond. Behoud hun oorspronkelijke houdingen en uiterlijk.",
      imageIds: [images[1].id, images[0].id],
    };
    expect(parsePhotoConversationDecision(completed(decision), images)).toEqual(
      decision
    );
    expect(parsePhotoConversationDecision(completed(reply), images)).toEqual(
      reply
    );
  });

  it.each([
    [
      "foreign source",
      {
        action: "edit",
        reply: "",
        prompt: "Combineer de foto's.",
        imageIds: ["image_3333333333333333"],
      },
    ],
    [
      "duplicate source",
      {
        action: "edit",
        reply: "",
        prompt: "Combineer de foto's.",
        imageIds: [images[0].id, images[0].id],
      },
    ],
    [
      "missing edit source",
      {
        action: "edit",
        reply: "",
        prompt: "Combineer de foto's.",
        imageIds: [],
      },
    ],
    [
      "generation source",
      {
        action: "generate",
        reply: "",
        prompt: "Een hond.",
        imageIds: [images[0].id],
      },
    ],
    ["reply with an image task", { ...reply, prompt: "Een hond." }],
    ["provider-selected setting", { ...reply, model: "other-model" }],
    ["URL exposure", { ...reply, reply: "Zie https://example.test/photo.png" }],
    ["ID exposure", { ...reply, reply: `Ik zie ${images[0].id}` }],
    [
      "ID embedded in edit prompt",
      {
        action: "edit",
        reply: "",
        prompt: `Combineer de persoon uit ${images[0].id} met de hond.`,
        imageIds: images.map(image => image.id),
      },
    ],
  ])("rejects %s", (_label, decision) => {
    expect(() =>
      parsePhotoConversationDecision(completed(decision), images)
    ).toThrow();
  });

  it("rejects incomplete or non-text provider results", () => {
    expect(() =>
      parsePhotoConversationDecision(
        { status: "incomplete", output_text: JSON.stringify(reply) },
        images
      )
    ).toThrow("Incomplete");
    expect(() =>
      parsePhotoConversationDecision(
        { status: "completed", output: [] },
        images
      )
    ).toThrow("Invalid");
  });
});
