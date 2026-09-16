import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS } from "../server/_core/photoConversationContract.ts";
import {
  buildEvaluationCases,
  evaluationPlan,
  evaluationFailureReason,
  runPhotoConversationEvaluation,
} from "./lib/photo-conversation-evaluation.mjs";

const fixtures = Object.fromEntries(
  ["dog", "person", "cat"].map(name => [
    name,
    `data:image/png;base64,${readFileSync(new URL(`./fixtures/photo-conversation/${name}.png`, import.meta.url)).toString("base64")}`,
  ])
);
const cases = buildEvaluationCases(fixtures);
const responseFor = (item, overrides = {}) =>
  new Response(
    JSON.stringify({
      status: "completed",
      output_text: JSON.stringify({
        action: item.expectedAction,
        imageIds: item.expectedImageIds,
        reply: item.expectedAction === "reply" ? "Welke twee bedoel je?" : "",
        prompt:
          item.expectedAction === "reply" ? "" : "Combineer de onderwerpen.",
      }),
      usage: { input_tokens: 900, output_tokens: 60 },
      ...overrides,
    })
  );

describe("bounded synthetic real-model evaluation", () => {
  it("reports bounded failure reasons without echoing unexpected errors", () => {
    expect(
      evaluationFailureReason(new Error("Bearer synthetic-private-key"))
    ).toBe("transport_or_response_failure");
    expect(
      evaluationFailureReason(
        new DOMException("untrusted details", "TimeoutError")
      )
    ).toBe("transport_timeout");
    expect(
      evaluationFailureReason(
        new Error("Incomplete photo conversation response")
      )
    ).toBe("Incomplete photo conversation response");
  });
  it("plans all ten multimodal calls below the fixed budget without a key or transport", async () => {
    const fetcher = vi.fn();
    const result = await runPhotoConversationEvaluation({ fixtures, fetcher });
    expect(result.calls).toBe(0);
    expect(result.plan.calls).toBe(10);
    expect(result.plan.reservedUsd).toBeLessThan(0.5);
    expect(fetcher).not.toHaveBeenCalled();
    for (const item of cases) {
      expect(item.request.store).toBe(false);
      expect(item.request.model).toBe("gpt-5.4-mini-2026-03-17");
      expect(item.request.reasoning).toEqual({ effort: "low" });
      expect(item.request.max_output_tokens).toBe(
        PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS
      );
      expect(item.request.tools).toBeUndefined();
    }
  });

  it("checks exact source selection and records bounded usage with no API key in evidence", async () => {
    const events = [];
    const fetcher = vi.fn(async () =>
      responseFor(cases[fetcher.mock.calls.length - 1])
    );
    const result = await runPhotoConversationEvaluation({
      fixtures,
      execute: true,
      apiKey: "synthetic-private-key",
      fetcher,
      emit: event => events.push(event),
    });
    expect(result.passed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(events[0].kind).toBe("plan");
    for (const [endpoint, init] of fetcher.mock.calls) {
      expect(endpoint).toBe("https://api.openai.com/v1/responses");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(events)).not.toContain("synthetic-private-key");
  });

  it("fails a semantic result even when it is a valid structured response", async () => {
    const fetcher = vi.fn(async () =>
      responseFor(
        cases[fetcher.mock.calls.length - 1],
        fetcher.mock.calls.length === 1
          ? {
              output_text: JSON.stringify({
                action: "reply",
                reply: "Wat wil je doen?",
                prompt: "",
                imageIds: [],
              }),
            }
          : {}
      )
    );
    const result = await runPhotoConversationEvaluation({
      fixtures,
      execute: true,
      apiKey: "synthetic",
      fetcher,
    });
    expect(result.passed).toBe(false);
    expect(result.calls).toBe(10);
  });

  it.each([
    { input_tokens: undefined, output_tokens: 50 },
    { input_tokens: -1, output_tokens: 50 },
    { input_tokens: 1_000_000, output_tokens: 50 },
    {
      input_tokens: 800,
      output_tokens: PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS + 1,
    },
  ])("stops after unknown or out-of-budget usage %j", async usage => {
    const fetcher = vi.fn(async () => responseFor(cases[0], { usage }));
    await expect(
      runPhotoConversationEvaluation({
        fixtures,
        execute: true,
        apiKey: "synthetic",
        fetcher,
      })
    ).rejects.toThrow("invalid_or_unbounded_usage");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries a transport failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("synthetic lost response");
    });
    await expect(
      runPhotoConversationEvaluation({
        fixtures,
        execute: true,
        apiKey: "synthetic",
        fetcher,
      })
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("diagnoses rejected decisions using metadata without echoing their payload", async () => {
    const events = [];
    const fetcher = vi.fn(async () =>
      responseFor(cases[0], {
        output_text: JSON.stringify({
          action: "edit",
          reply: "",
          prompt: "synthetic-private-payload",
          imageIds: ["synthetic-foreign-id"],
        }),
      })
    );
    await expect(
      runPhotoConversationEvaluation({
        fixtures,
        execute: true,
        apiKey: "synthetic-key",
        fetcher,
        emit: e => events.push(e),
      })
    ).rejects.toThrow();
    expect(events.find(e => e.kind === "invalid_decision")).toMatchObject({
      knownSources: false,
      sourceCount: 1,
      embeddedSourceId: false,
    });
    expect(JSON.stringify(events)).not.toContain("synthetic-private-payload");
    expect(JSON.stringify(events)).not.toContain("synthetic-foreign-id");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops on rejection without reading or logging provider error content", async () => {
    const events = [];
    const fetcher = vi.fn(
      async () => new Response("private-provider-error", { status: 401 })
    );
    await expect(
      runPhotoConversationEvaluation({
        fixtures,
        execute: true,
        apiKey: "synthetic",
        fetcher,
        emit: e => events.push(e),
      })
    ).rejects.toThrow("provider_rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain("private-provider-error");
  });

  it("stops on incomplete or oversized responses", async () => {
    for (const response of [
      responseFor(cases[0], { status: "incomplete" }),
      new Response("x".repeat(65 * 1024)),
    ]) {
      const fetcher = vi.fn(async () => response);
      await expect(
        runPhotoConversationEvaluation({
          fixtures,
          execute: true,
          apiKey: "synthetic",
          fetcher,
        })
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects external fixtures and plans above the fixed cap", () => {
    expect(() =>
      buildEvaluationCases({
        ...fixtures,
        dog: "https://example.com/customer.png",
      })
    ).toThrow();
    expect(() => evaluationPlan([...cases, cases[0]])).toThrow(
      "evaluation_budget_exceeded"
    );
    expect(() => evaluationPlan([{ ...cases[0], reservedUsd: 0.51 }])).toThrow(
      "evaluation_budget_exceeded"
    );
  });

  it("keeps unavailable IDs in the catalog but out of selectable image IDs", () => {
    const item = cases.find(item => item.id === "missing_source");
    const text = JSON.parse(item.request.input[1].content[0].text);
    expect(text.imageCatalog).toHaveLength(2);
    expect(text.unavailableImageIds).toHaveLength(1);
    expect(item.images).toHaveLength(1);
    expect(item.images[0].id).not.toBe(text.unavailableImageIds[0]);
  });

  it("varies language, catalog order and actual target subjects in the held-out suite", () => {
    const holdout = buildEvaluationCases(fixtures, "holdout");
    expect(evaluationPlan(holdout).reservedUsd).toBeLessThan(0.5);
    expect(holdout[2].expectedImageIds).not.toEqual(cases[2].expectedImageIds);
    expect(holdout[6].expectedImageIds).not.toEqual(cases[6].expectedImageIds);
    expect(holdout[7].images[0].id).not.toEqual(cases[7].images[0].id);
    expect(() => buildEvaluationCases(fixtures, "customer")).toThrow();
  });

  it("keeps the failed generated result distinct while requiring dog plus exactly one person", () => {
    const item = buildEvaluationCases(fixtures, "holdout").find(
      item => item.id === "after_failed_result"
    );
    const context = JSON.parse(item.request.input[1].content[0].text);
    expect(context.imageCatalog.map(image => image.kind)).toEqual([
      "generated",
      "uploaded",
      "generated",
    ]);
    expect(new Set(item.images.map(image => image.id)).size).toBe(3);
    const imageBlocks = item.request.input[1].content.filter(
      block => block.type === "input_image"
    );
    expect(imageBlocks[1].image_url).toBe(imageBlocks[2].image_url);
    expect(item.expectedImageIds).toHaveLength(2);
    expect(item.alternateImageIds).toHaveLength(2);
    expect(item.expectedImageIds[0]).toBe(item.alternateImageIds[0]);
    expect(item.expectedImageIds[1]).not.toBe(item.alternateImageIds[1]);
  });
});
