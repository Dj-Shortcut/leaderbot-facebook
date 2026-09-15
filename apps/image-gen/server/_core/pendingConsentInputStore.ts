import type { MessengerUserState } from "./messengerState";
import {
  getOrCreatePersistedState,
  getPendingConsentStorageScope,
} from "./messengerStatePersistence";
import { getRedisClient } from "./redis";
import {
  deleteScopedState,
  isRedisStateStoreEnabled,
  readScopedState,
  readState,
  writeScopedState,
} from "./stateStore";

export type PendingConsentInput = {
  text?: string;
  imageUrls: string[];
  expiresAt: number;
  operationId: string;
  claim?: { token: string; expiresAt: number };
};

// Compare both records and the privacy fence in one Redis operation. A consent
// grant racing an append therefore retries against the newly consented state.
const UPDATE_SCRIPT = `
  if tonumber(redis.call("GET", KEYS[3]) or "0") >= tonumber(ARGV[1]) then
    return -1
  end
  if (redis.call("GET", KEYS[1]) or "") ~= ARGV[2] then return 0 end
  if (redis.call("GET", KEYS[2]) or "") ~= ARGV[3] then return 0 end
  if ARGV[4] == "" then
    redis.call("DEL", KEYS[2])
  else
    redis.call("SET", KEYS[2], ARGV[4], "PXAT", ARGV[5])
  end
  return 1
`;

export async function updatePendingConsentInput<T>(
  psid: string,
  update: (
    state: MessengerUserState,
    pending: PendingConsentInput | null
  ) => { pending: PendingConsentInput | null; result: T }
): Promise<T> {
  const scope = getPendingConsentStorageScope(psid);
  await getOrCreatePersistedState(psid);
  if (!isRedisStateStoreEnabled()) {
    // Memory operations are synchronous, with no yield between read and write.
    const state = readState<MessengerUserState>(
      scope.key
    ) as MessengerUserState;
    const pending = readScopedState<PendingConsentInput>(
      scope.scope,
      scope.key
    ) as PendingConsentInput | null;
    const next = update(state, pending);
    if (next.pending) {
      void writeScopedState(
        scope.scope,
        scope.key,
        next.pending,
        (next.pending.expiresAt - Date.now()) / 1000
      );
    } else {
      void deleteScopedState(scope.scope, scope.key);
    }
    return next.result;
  }
  const redis = await getRedisClient();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [stateRaw, pendingRaw] = await Promise.all([
      redis.get(scope.stateKey),
      redis.get(scope.storageKey),
    ]);
    if (!stateRaw)
      throw new Error("Messenger pending input state is unavailable");
    const next = update(
      JSON.parse(stateRaw) as MessengerUserState,
      pendingRaw ? (JSON.parse(pendingRaw) as PendingConsentInput) : null
    );
    const result = Number(
      await redis.eval(
        UPDATE_SCRIPT,
        3,
        scope.stateKey,
        scope.storageKey,
        scope.tombstoneKey,
        scope.privacyEpoch,
        stateRaw,
        pendingRaw ?? "",
        next.pending ? JSON.stringify(next.pending) : "",
        next.pending?.expiresAt ?? 0
      )
    );
    if (result === 1) return next.result;
    if (result === -1) throw new Error("Messenger state subject is erased");
  }
  throw new Error("Messenger pending input contention exceeded retry limit");
}
