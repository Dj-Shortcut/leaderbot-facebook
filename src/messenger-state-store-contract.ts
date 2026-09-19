export type MessengerSharedStateStoreMode = "memory" | "redis";

export type MessengerStateScope = Readonly<{
  accountId: string;
  pageId: string;
}>;

export type MessengerBudgetKind = "image_forward" | "audio_transcription";

export type MessengerDailyBudgetResult =
  | { ok: true; count: number; cap: number }
  | { ok: false; count: number; cap: number };

export interface MessengerEphemeralStateStore {
  readonly mode: MessengerSharedStateStoreMode;
  ensureReady(): Promise<void>;
  claimMessage(
    input: Readonly<{
      scope: MessengerStateScope;
      eventIdentity: string;
      ownerToken: string;
      ttlMs: number;
      now?: number;
    }>,
  ): Promise<boolean>;
  reserveDaily(
    input: Readonly<{
      scope: MessengerStateScope;
      kind: MessengerBudgetKind;
      dayKey: string;
      eventIdentity: string;
      cap: number;
      expiresAtMs: number;
      now?: number;
    }>,
  ): Promise<MessengerDailyBudgetResult>;
  close(): Promise<void>;
}

export class MessengerSharedStateUnavailableError extends Error {
  readonly code: "config" | "connect" | "command" | "protocol";

  constructor(
    code: MessengerSharedStateUnavailableError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MessengerSharedStateUnavailableError";
    this.code = code;
  }
}

export function validateMessengerStateIdentity(
  scope: MessengerStateScope,
  eventIdentity: string,
): void {
  for (const [label, value] of [
    ["accountId", scope.accountId],
    ["pageId", scope.pageId],
    ["eventIdentity", eventIdentity],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        `Messenger shared state ${label} must not be empty`,
      );
    }
  }
}

