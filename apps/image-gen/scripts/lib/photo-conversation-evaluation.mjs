import { createHash } from "node:crypto";
import { extractResponseText } from "../../server/_core/openai/responseText.ts";
import {
  buildPhotoConversationRequest,
  photoConversationInputTokenBound,
  parsePhotoConversationDecision,
  PHOTO_CONVERSATION_MODEL,
  PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS,
  PHOTO_CONVERSATION_TIMEOUT_MS,
  PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN,
  PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN,
} from "../../server/_core/photoConversationContract.ts";

export const EVALUATION_MAX_USD = 0.5;
export const EVALUATION_MAX_CALLS = 10;
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_RESPONSE_BYTES = 64 * 1024;
const ids = {
  dog: "image_b6d749ac8fe02315",
  person: "image_291ea05f83dc764b",
  cat: "image_7c19a24d06bf358e",
  failed_result: "image_08ad4c7536bf129e",
};
const imageKind = name =>
  name === "dog" || name === "failed_result" ? "generated" : "uploaded";

export function evaluationFailureReason(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return "transport_timeout";
  const allowed = new Set([
    "missing_openai_key",
    "invalid_fly_runtime",
    "provider_rejected",
    "empty_response",
    "oversized_response",
    "invalid_or_unbounded_usage",
    "evaluation_budget_exceeded",
    "Invalid photo conversation response",
    "Incomplete photo conversation response",
    "Invalid photo conversation decision",
    "Inconsistent photo conversation action",
  ]);
  return allowed.has(error?.message)
    ? error.message
    : "transport_or_response_failure";
}

/** Fixed authored fixtures only; no customer IDs, URLs, state, or caller prompts. */
export function buildEvaluationCases(fixtures, suite = "regression") {
  if (!["regression", "holdout"].includes(suite))
    throw new Error("invalid_synthetic_suite");
  for (const name of ["dog", "person", "cat"]) {
    if (
      typeof fixtures[name] !== "string" ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(fixtures[name]) ||
      fixtures[name].length > 100_000
    )
      throw new Error("invalid_synthetic_fixture");
  }
  const pair = ["dog", "person"];
  const trio = ["cat", "person", "dog"];
  const previous = [
    { role: "user", text: "Maak een afbeelding van een hond in het gras." },
  ];
  // The feature stores generation requests, not transport-owned status replies.
  const composition = [...previous, { role: "user", text: "Voeg samen" }];
  const specs = [
    {
      id: "combine_two",
      names: pair,
      text: "Voeg samen",
      history: previous,
      action: "edit",
      sources: pair,
    },
    {
      id: "complaint",
      names: pair,
      text: "Niet wat ik vroeg",
      history: composition,
      action: "reply",
      sources: [],
    },
    {
      id: "repair_with_distractor",
      names: trio,
      text: "Voeg de hond samen met mijn maat",
      history: [
        ...composition,
        { role: "user", text: "Niet wat ik vroeg" },
        {
          role: "assistant",
          text: "Sorry, wat moet ik aanpassen aan de samenvoeging?",
        },
      ],
      action: "edit",
      sources: pair,
    },
    {
      id: "creative_question",
      names: pair,
      text: "Wat zou een leuke achtergrond zijn voor die twee?",
      history: previous,
      action: "reply",
      sources: [],
    },
    {
      id: "thanks",
      names: pair,
      text: "Haha geweldig, bedankt!",
      history: composition,
      action: "reply",
      sources: [],
    },
    {
      id: "ambiguous_three",
      names: trio,
      text: "Voeg die twee samen",
      history: [],
      action: "reply",
      sources: [],
    },
    {
      id: "clarification_answer",
      names: trio,
      text: "Ja, die twee graag",
      history: [
        { role: "user", text: "Voeg die twee samen" },
        {
          role: "assistant",
          text: "Bedoel je de hond en de persoon met de blauwe trui?",
        },
      ],
      action: "edit",
      sources: pair,
    },
    {
      id: "missing_source",
      names: pair,
      unavailable: ["dog"],
      text: "Zet mijn maat samen met de hond op één foto",
      history: previous,
      action: "reply",
      sources: [],
    },
    {
      id: "new_image",
      names: [],
      text: "Maak een afbeelding van een papegaai op een fiets.",
      history: [],
      action: "generate",
      sources: [],
    },
    {
      id: "playful_comment",
      names: pair,
      text: "Mijn hond lijkt hier wel een filmster haha",
      history: previous,
      action: "reply",
      sources: [],
    },
  ];
  // Alternate wording, image order, and target subset; never supplied to the
  // model as expected answers. This catches fixed pair/position shortcuts.
  if (suite === "holdout") {
    const changes = [
      {
        text: "Nee, de hond graag",
        names: ["person", "dog", "cat"],
        history: [
          { role: "user", text: "Zet die twee bij elkaar" },
          { role: "assistant", text: "Bedoel je de kat naast de persoon?" },
        ],
      },
      {
        text: "Nee, dit is niet de bedoeling.",
        names: ["dog", "person", "failed_result"],
      },
      {
        text: "Ik bedoel mijn maat samen met de kat, de hond hoeft er niet bij.",
        names: ["dog", "cat", "person"],
        sources: ["person", "cat"],
      },
      {
        text: "Verander alleen de trui van mijn maat naar rood.",
        unavailable: ["dog"],
        action: "edit",
        sources: ["person"],
      },
      {
        text: "Voeg de hond samen met mijn maat",
        names: ["dog", "person", "failed_result"],
        history: [
          ...composition,
          { role: "user", text: "Niet wat ik vroeg" },
          {
            role: "assistant",
            text: "Je wilde de hond en je maat samen. Wat ontbreekt er in het resultaat?",
          },
        ],
        action: "edit",
        sources: pair,
        // The failed result is pixel-identical to the person fixture. Either
        // person source is valid, but dog + one person is mandatory.
        alternateSources: ["dog", "failed_result"],
      },
      { text: "Zet ze allebei naast elkaar.", names: ["person", "dog", "cat"] },
      {
        text: "Klopt, doe maar",
        names: ["dog", "cat", "person"],
        sources: ["cat", "person"],
        history: [
          { role: "user", text: "Zet die twee bij elkaar" },
          {
            role: "assistant",
            text: "Bedoel je de kat en de persoon met de blauwe trui?",
          },
        ],
      },
      {
        text: "Laat mijn maat samen met de kat op één foto zien.",
        names: ["person", "cat"],
        unavailable: ["person"],
        history: [],
      },
      { text: "Teken een rode luchtballon boven de bergen." },
      {
        text: "Die oude hond hoeft niet; bedenk een nieuwe hond naast mijn maat.",
        unavailable: ["dog"],
        action: "edit",
        sources: ["person"],
      },
    ];
    specs.forEach((spec, index) => Object.assign(spec, changes[index]));
  }
  const holdoutIds = {
    combine_two: "elliptical_correction",
    complaint: "complaint_alternate",
    repair_with_distractor: "different_pair",
    creative_question: "unneeded_missing_source",
    thanks: "after_failed_result",
    ambiguous_three: "ambiguous_alternate",
    clarification_answer: "confirmed_different_pair",
    missing_source: "missing_person",
    new_image: "new_image_alternate",
    playful_comment: "authorized_new_subject",
  };
  return specs.map(spec => {
    const catalog = spec.names.map(name => ({
      id: ids[name],
      kind: imageKind(name),
    }));
    const available = spec.names.filter(
      name => !spec.unavailable?.includes(name)
    );
    const content = [
      {
        type: "input_text",
        text: JSON.stringify({
          recentConversation: spec.history,
          imageCatalog: catalog,
          stage: !spec.names.length
            ? "IDLE"
            : ["complaint", "thanks", "playful_comment"].includes(spec.id)
              ? "RESULT_READY"
              : "AWAITING_EDIT_PROMPT",
          pendingEditIntent: null,
          latestImagePrompt: ["complaint", "thanks"].includes(spec.id)
            ? "Combineer de hond met de persoon in één afbeelding."
            : spec.history.length
              ? "Een hond in het gras"
              : null,
          currentUserMessage: spec.text,
          unavailableImageIds: (spec.unavailable ?? []).map(name => ids[name]),
        }),
      },
    ];
    for (const name of available) {
      content.push({
        type: "input_text",
        text: `Image ${ids[name]} (${imageKind(name)}):`,
      });
      content.push({
        type: "input_image",
        image_url: fixtures[name === "failed_result" ? "person" : name],
        detail: "auto",
      });
    }
    const request = buildPhotoConversationRequest("nl", content);
    // Use exactly the runtime's full request/schema/vision admission estimate.
    const tokenBound = photoConversationInputTokenBound(request);
    const reservedUsd =
      tokenBound * PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN +
      PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS *
        PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN;
    return {
      id: suite === "holdout" ? holdoutIds[spec.id] : spec.id,
      request,
      tokenBound,
      reservedUsd,
      images: available.map(name => ({ id: ids[name] })),
      expectedAction: spec.action,
      expectedImageIds: spec.sources.map(name => ids[name]),
      alternateImageIds: spec.alternateSources?.map(name => ids[name]) ?? null,
    };
  });
}

export function evaluationPlan(cases) {
  const reservedUsd = cases.reduce((sum, item) => sum + item.reservedUsd, 0);
  if (
    !cases.length ||
    cases.length > EVALUATION_MAX_CALLS ||
    !Number.isFinite(reservedUsd) ||
    reservedUsd > EVALUATION_MAX_USD
  )
    throw new Error("evaluation_budget_exceeded");
  return {
    kind: "plan",
    model: PHOTO_CONVERSATION_MODEL,
    calls: cases.length,
    maxUsd: EVALUATION_MAX_USD,
    reservedUsd,
    suiteSha256: createHash("sha256")
      .update(JSON.stringify(cases))
      .digest("hex"),
    cases: cases.map(({ id, tokenBound, reservedUsd, expectedAction }) => ({
      id,
      tokenBound,
      reservedUsd,
      expectedAction,
    })),
  };
}

async function boundedResponse(response) {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("oversized_response");
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Separately budgeted text/vision diagnostic; never dispatches image work. */
export async function runPhotoConversationEvaluation({
  fixtures,
  suite = "regression",
  execute = false,
  apiKey,
  fetcher = fetch,
  emit = () => {},
}) {
  const cases = buildEvaluationCases(fixtures, suite);
  const plan = evaluationPlan(cases);
  emit(plan); // Admit the entire fixed run before its first billable call.
  if (!execute) return { passed: true, calls: 0, plan };
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error("missing_openai_key");
  const outcomes = [];
  let actualUsd = 0;
  for (const item of cases) {
    emit({ kind: "attempt", caseId: item.id });
    const start = Date.now();
    // No retries or configurable destinations. Keep credentials inside Fly.
    const response = await fetcher(ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(item.request),
      signal: AbortSignal.timeout(PHOTO_CONVERSATION_TIMEOUT_MS),
    });
    if (!response.ok) {
      emit({
        kind: "provider_rejected",
        caseId: item.id,
        httpStatus: response.status,
      });
      await response.body?.cancel();
      throw new Error("provider_rejected");
    }
    emit({ kind: "response", caseId: item.id, httpStatus: response.status });
    const raw = await boundedResponse(response);
    const inputTokens = raw?.usage?.input_tokens;
    const outputTokens = raw?.usage?.output_tokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      inputTokens > item.tokenBound ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0 ||
      outputTokens > PHOTO_CONVERSATION_MAX_OUTPUT_TOKENS
    )
      throw new Error("invalid_or_unbounded_usage");
    actualUsd +=
      inputTokens * PHOTO_CONVERSATION_INPUT_USD_PER_TOKEN +
      outputTokens * PHOTO_CONVERSATION_OUTPUT_USD_PER_TOKEN;
    emit({ kind: "usage", caseId: item.id, inputTokens, outputTokens });
    let decision;
    try {
      decision = parsePhotoConversationDecision(raw, item.images);
    } catch (error) {
      // Diagnose parser failures with booleans/counts, never an invalid payload.
      let value;
      try {
        value = JSON.parse(extractResponseText(raw) ?? "null");
      } catch {}
      const selected = Array.isArray(value?.imageIds) ? value.imageIds : [];
      emit({
        kind: "invalid_decision",
        caseId: item.id,
        exactKeys: Boolean(
          value &&
          Object.keys(value).sort().join(",") === "action,imageIds,prompt,reply"
        ),
        knownSources: selected.every(id =>
          item.images.some(image => image.id === id)
        ),
        uniqueSources: new Set(selected).size === selected.length,
        sourceCount: selected.length,
        embeddedSourceId: /image_[a-f\d]{16}/i.test(
          String(value?.reply) + String(value?.prompt)
        ),
        embeddedUrl: /https?:\/\//i.test(
          String(value?.reply) + String(value?.prompt)
        ),
        replyLength:
          typeof value?.reply === "string" ? value.reply.length : null,
        promptLength:
          typeof value?.prompt === "string" ? value.prompt.length : null,
      });
      throw error;
    }
    const passed =
      decision.action === item.expectedAction &&
      [item.expectedImageIds, item.alternateImageIds]
        .filter(Boolean)
        .some(
          sourceSet =>
            [...decision.imageIds].sort().join(",") ===
            [...sourceSet].sort().join(",")
        );
    const outcome = {
      kind: "case",
      caseId: item.id,
      passed,
      decision,
      inputTokens,
      outputTokens,
      elapsedMs: Date.now() - start,
    };
    outcomes.push(outcome);
    // These are authored synthetic cases, never a customer transcript.
    emit(outcome);
  }
  const result = {
    kind: "summary",
    passed: outcomes.every(item => item.passed),
    calls: outcomes.length,
    actualUsd,
    reservedUsd: plan.reservedUsd,
    suiteSha256: plan.suiteSha256,
  };
  emit(result);
  return result;
}
