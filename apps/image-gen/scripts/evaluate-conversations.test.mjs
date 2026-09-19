import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLogDecoder,
  normalizeEvaluationLog,
  buildEvaluationReport,
  runEvaluationMonitor,
} from "./evaluate-conversations.mjs";
const now = Date.parse("2026-09-15T10:00:00Z");
const folders = [];
const raw = (index = 0, overrides = {}) => ({
  timestamp: new Date(now - index * 1000).toISOString(),
  message: JSON.stringify({
    event: "messenger_conversation_evaluation",
    version: 1,
    contentCheck: "rules",
    reqId: `f0caa415-f0d4-46dc-b6b3-556301bce55${index}`,
    findings: ["social_as_upload"],
    ...overrides,
  }),
});
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map(folder => rm(folder, { recursive: true, force: true }))
  );
});

describe("automatic evaluation reports", () => {
  it("discards content, identities, URLs, unknown fields and invented finding names", () => {
    const signal = normalizeEvaluationLog(
      raw(0, {
        text: "PRIVATE-CONTENT",
        psid: "PRIVATE-ID",
        url: "https://PRIVATE.test",
        findings: ["social_as_upload", "PRIVATE-INSTRUCTION"],
        reqId: "PRIVATE-ID",
      })
    );
    expect(signal.findings).toEqual(["social_as_upload"]);
    expect(signal.request).toBeNull();
    expect(JSON.stringify(signal)).not.toContain("PRIVATE");
  });
  it("does not turn unknown logs or missing timestamps into evidence", () => {
    expect(
      normalizeEvaluationLog({ event: "other", message: "private content" })
    ).toBeNull();
    expect(
      normalizeEvaluationLog({
        event: "messenger_conversation_evaluation",
        version: 1,
        findings: [],
      })
    ).toBeNull();
  });
  it("labels limited coverage and alerts on recurring patterns", () => {
    const report = buildEvaluationReport(
      [0, 1, 2].map(index => normalizeEvaluationLog(raw(index))),
      now
    );
    expect(report.coverage).toMatchObject({
      completeConversationCoverage: false,
      contentCheck: "limited_rules",
      evaluationsObserved: 3,
    });
    expect(report.findings[0]).toMatchObject({ count: 3, actionable: true });
  });
  it("does not claim content coverage from consent-skipped evaluations", () => {
    const report = buildEvaluationReport(
      [normalizeEvaluationLog(raw(0, { contentCheck: "skipped" }))],
      now
    );
    expect(report.coverage.contentCheck).toBe("not_observed");
    expect(report.coverage.evaluationsObserved).toBe(1);
  });
  it("never calls an empty snapshot a healthy full-conversation review", () => {
    expect(buildEvaluationReport([], now).coverage).toMatchObject({
      contentCheck: "not_observed",
      completeConversationCoverage: false,
      lastObservedAt: null,
    });
  });
  it("deduplicates overlapping snapshots and stays quiet when unchanged", async () => {
    const folder = await mkdtemp(join(tmpdir(), "conversation-eval-test-"));
    folders.push(folder);
    const options = {
      statePath: join(folder, "state.json"),
      reportPath: join(folder, "report.json"),
      now,
      collect: async () =>
        [0, 1, 2].map(index => normalizeEvaluationLog(raw(index))),
    };
    const first = await runEvaluationMonitor(options);
    const second = await runEvaluationMonitor(options);
    expect(first.newAlerts).toHaveLength(1);
    expect(second.newAlerts).toHaveLength(0);
    expect(second.findings[0].count).toBe(3);
    expect(
      JSON.stringify(JSON.parse(await readFile(options.statePath, "utf8")))
    ).not.toContain("message");
    const saved = await readFile(options.reportPath, "utf8");
    await expect(
      runEvaluationMonitor({
        ...options,
        collect: async () => {
          throw new Error("private provider error");
        },
      })
    ).rejects.toThrow();
    expect(await readFile(options.reportPath, "utf8")).toBe(saved);
  });
  it("expires stored evidence after a day", async () => {
    const folder = await mkdtemp(join(tmpdir(), "conversation-eval-test-"));
    folders.push(folder);
    const options = {
      statePath: join(folder, "state.json"),
      reportPath: join(folder, "report.json"),
      now,
      collect: async () => [normalizeEvaluationLog(raw())],
    };
    await runEvaluationMonitor(options);
    const report = await runEvaluationMonitor({
      ...options,
      now: now + 86_400_001,
      collect: async () => [],
    });
    expect(report.findings).toEqual([]);
    expect(
      JSON.parse(await readFile(options.statePath, "utf8")).signals
    ).toEqual([]);
  });
});

describe("log framing", () => {
  it("decodes consecutive pretty JSON and arbitrary chunks including escaped quotes", () => {
    const records = [];
    const decoder = createLogDecoder(record => records.push(record));
    const input = [raw(0, { text: 'quote " and braces { }' }), raw(1)];
    const stream = input
      .map(record => JSON.stringify(record, null, 2))
      .join("\n");
    for (const character of stream) decoder.push(character);
    decoder.finish();
    expect(records).toEqual(input);
  });
  it("decodes arrays and NDJSON", () => {
    const records = [];
    const decoder = createLogDecoder(record => records.push(record));
    decoder.push(
      JSON.stringify([raw(0), raw(1)]) + "\n" + JSON.stringify(raw(2))
    );
    decoder.finish();
    expect(records).toHaveLength(3);
  });
  it("rejects unexpected, incomplete and oversized output without echoing content", () => {
    expect(() => createLogDecoder(() => {}).push("PRIVATE")).toThrow(
      "Unexpected log format"
    );
    const partial = createLogDecoder(() => {});
    partial.push('{"a":');
    expect(() => partial.finish()).toThrow("Incomplete log snapshot");
    expect(() =>
      createLogDecoder(() => {}).push('{"a":"' + "x".repeat(1_048_576))
    ).toThrow("size limit");
  });
});
