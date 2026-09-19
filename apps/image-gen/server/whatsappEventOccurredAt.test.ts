import { describe, expect, it } from "vitest";
import { parseWhatsAppEventOccurredAt } from "./_core/whatsappEventOccurredAt";
import { WhatsAppGenerationScopeError } from "./_core/whatsappGenerationScope";

describe("parseWhatsAppEventOccurredAt", () => {
  it("returns the event time for a positive safe-integer timestamp", () => {
    expect(parseWhatsAppEventOccurredAt(1_700_000_000_000)).toEqual(
      new Date(1_700_000_000_000)
    );
  });

  it.each([undefined, null, "1700000000000", 0, -1, 1.5, Number.MAX_VALUE])(
    "rejects %j as a non-retryable scope error",
    value => {
      let thrown: unknown;
      try {
        parseWhatsAppEventOccurredAt(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WhatsAppGenerationScopeError);
      expect((thrown as WhatsAppGenerationScopeError).retryable).toBe(false);
    }
  );

  it("rejects a safe integer outside the valid Date range", () => {
    expect(() => parseWhatsAppEventOccurredAt(8_640_000_000_000_001)).toThrow(
      WhatsAppGenerationScopeError
    );
  });
});
