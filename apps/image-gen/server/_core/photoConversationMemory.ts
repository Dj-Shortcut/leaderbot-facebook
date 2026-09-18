import type { PhotoConversationDecision } from "./photoConversation";
import { createHash } from "node:crypto";
import type { MessengerUserState } from "./messengerState";
import { MAX_SOURCE_IMAGES } from "./image-generation/generationTypes";

export const PHOTO_CONVERSATION_MAX_TURNS = 12;
export const PHOTO_CONVERSATION_MAX_TEXT = 4000;

export type PhotoConversationImage = {
  id: string;
  url: string;
  kind: "uploaded" | "generated";
};
type PhotoConversationTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
type PhotoConversationExecution = NonNullable<
  PhotoConversationMemory["executions"]
>[number];
export type PhotoConversationMemory = {
  images: PhotoConversationImage[];
  turns: PhotoConversationTurn[];
  /** Bounded durable outbox for retrying dispatch without another model call. */
  executions?: Array<{
    requestId: string;
    decision: PhotoConversationDecision;
    completed: boolean;
  }>;
};

export function isPhotoConversationEnabled(): boolean {
  return process.env.MESSENGER_PHOTO_CONVERSATION_ENABLED === "true";
}

function imageReference(
  url: string,
  kind: PhotoConversationImage["kind"]
): PhotoConversationImage {
  return {
    id: `image_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
    url,
    kind,
  };
}

function normalizeImages(
  images: Array<Pick<PhotoConversationImage, "url" | "kind">>
): PhotoConversationImage[] {
  const byUrl = new Map<string, PhotoConversationImage>();
  for (const image of images) {
    if (
      !image ||
      typeof image.url !== "string" ||
      image.url.length > 4096 ||
      !/^https?:\/\//.test(image.url) ||
      (image.kind !== "uploaded" && image.kind !== "generated")
    )
      continue;
    // Refresh both kind and recency without spending a retained-source slot
    // on another reference to the same object.
    byUrl.delete(image.url);
    byUrl.set(image.url, imageReference(image.url, image.kind));
  }
  return [...byUrl.values()].slice(-MAX_SOURCE_IMAGES);
}

function isRetainableExecution(entry: PhotoConversationExecution): boolean {
  return Boolean(
    entry &&
      typeof entry.requestId === "string" &&
      entry.requestId.length <= 200 &&
      entry.decision &&
      ["reply", "generate", "edit"].includes(entry.decision.action) &&
      typeof entry.decision.reply === "string" &&
      entry.decision.reply.length <= 1800 &&
      typeof entry.decision.prompt === "string" &&
      entry.decision.prompt.length <= PHOTO_CONVERSATION_MAX_TEXT &&
      Array.isArray(entry.decision.imageIds) &&
      entry.decision.imageIds.length <= MAX_SOURCE_IMAGES &&
      entry.decision.imageIds.every(
        id => typeof id === "string" && /^image_[a-f0-9]{16}$/.test(id)
      )
  );
}

function isRetainableTurn(turn: PhotoConversationTurn): boolean {
  return Boolean(
    turn &&
      typeof turn.id === "string" &&
      turn.id.length <= 200 &&
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.text === "string" &&
      turn.text.length <= PHOTO_CONVERSATION_MAX_TEXT
  );
}

function boundTurns(turns: PhotoConversationTurn[]): PhotoConversationTurn[] {
  return turns
    .slice(-PHOTO_CONVERSATION_MAX_TURNS)
    .map(({ id, role, text }) => ({ id, role, text }));
}

export function normalizePhotoConversation(
  value: unknown
): PhotoConversationMemory {
  const input = value as Partial<PhotoConversationMemory> | undefined;
  const images = Array.isArray(input?.images) ? input.images : [];
  const turns = Array.isArray(input?.turns) ? input.turns : [];
  const executions = Array.isArray(input?.executions) ? input.executions : [];
  return {
    executions: executions
      .filter(isRetainableExecution)
      .slice(-6)
      .map(entry => ({
        requestId: entry.requestId,
        completed: entry.completed === true,
        decision: {
          action: entry.decision.action,
          reply: entry.decision.reply,
          prompt: entry.decision.prompt,
          imageIds: [...entry.decision.imageIds],
        },
      })),
    images: normalizeImages(images),
    turns: boundTurns(turns.filter(isRetainableTurn)),
  };
}

/** Only references already owned by this scoped state may enter the model context. */
export function getPhotoConversationImages(
  state: MessengerUserState
): PhotoConversationImage[] {
  const memory = normalizePhotoConversation(state.photoConversation);
  // Once initialized, this bounded list is authoritative: do not resurrect
  // older pending sources after they were evicted.
  if (state.photoConversation) return memory.images;
  const images = [...memory.images];
  const add = (
    url: string | null | undefined,
    kind: PhotoConversationImage["kind"]
  ) => {
    if (url) images.push(imageReference(url, kind));
  };
  for (const url of state.pendingImageUrls ?? []) add(url, "uploaded");
  add(state.lastPhotoUrl ?? state.lastPhoto, "uploaded");
  add(state.lastGeneratedUrl ?? state.lastImageUrl, "generated");
  return normalizeImages(images);
}

export function rememberPhotoConversationImages(
  state: MessengerUserState,
  urls: string[],
  kind: PhotoConversationImage["kind"]
): PhotoConversationMemory {
  return {
    ...normalizePhotoConversation(state.photoConversation),
    images: normalizeImages([
      ...getPhotoConversationImages(state),
      ...urls.map(url => ({ url, kind })),
    ]),
  };
}

export function appendPhotoConversationTurn(
  state: MessengerUserState,
  turn: PhotoConversationTurn
): PhotoConversationMemory {
  const memory = normalizePhotoConversation(state.photoConversation);
  return {
    ...memory,
    images: getPhotoConversationImages(state),
    turns: boundTurns([
      ...memory.turns.filter(previous => previous.id !== turn.id),
      turn,
    ]),
  };
}
