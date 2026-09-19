import { WhatsAppGenerationScopeError } from "./whatsappGenerationScope";

/** A WhatsApp event without a usable timestamp cannot be scoped to its tenant. */
export function parseWhatsAppEventOccurredAt(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WhatsAppGenerationScopeError();
  }
  const eventOccurredAt = new Date(value);
  if (!Number.isSafeInteger(eventOccurredAt.getTime())) {
    throw new WhatsAppGenerationScopeError();
  }
  return eventOccurredAt;
}
