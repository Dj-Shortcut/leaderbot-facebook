import { isMessengerAdmin } from "./messengerAdmin";
import { hasInFlightGeneration } from "./generationGuard";
import { getState, type MessengerUserState } from "./messengerState";
import { patchState } from "./messengerStatePersistence";
import {
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";

export function isCustomerTestConfiguration(): boolean {
  return (
    process.env.MOLLIE_MODE?.trim() === "test" &&
    process.env.MOLLIE_BILLING_ENABLED !== "true" &&
    process.env.MOLLIE_LIVE_BILLING_ENABLED !== "true"
  );
}

/** Read the shared Page/user state in the current verified request/job scope. */
export async function readMessengerExecutionAccess(
  psid: string,
  userKey: string
): Promise<{ quotaBypass: boolean; budgetBypass: boolean }> {
  const owner = isMessengerAdmin(psid, userKey);
  const explicitIds = new Set(
    (process.env.MESSENGER_QUOTA_BYPASS_IDS ?? "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
  const quotaBypass =
    owner || explicitIds.has(psid) || explicitIds.has(userKey);
  // Read even after an administrator is removed from the configuration: an
  // existing test session must not silently become a live customer session.
  const state = await getState(psid);
  if (state?.customerTestMode === true) {
    // A configuration change must not turn a customer test into live billing
    // or silently reinstate the owner's execution exemptions.
    if (!isCustomerTestConfiguration()) {
      throw new Error("Messenger customer testing requires Mollie Test Mode");
    }
    return { quotaBypass: false, budgetBypass: false };
  }
  return { quotaBypass, budgetBypass: owner };
}

/** Explicit on/off is replay-safe; this changes no quota, wallet or payment. */
export async function setMessengerCustomerTestMode(
  psid: string,
  userKey: string,
  enabled: boolean
): Promise<void> {
  if (!isMessengerAdmin(psid, userKey)) {
    throw new Error("Messenger customer testing requires an administrator");
  }
  if (enabled && !isCustomerTestConfiguration()) {
    throw new Error("Messenger customer testing requires Mollie Test Mode");
  }
  const ownership = getMessengerRequestOwnership();
  const subject = getMessengerRequestPrivacySubject();
  const pageId = getMessengerRequestPageId();
  if (
    getMessengerRequestChannel() !== "facebook_messenger" ||
    !ownership ||
    !subject ||
    !pageId ||
    subject.userKey !== userKey ||
    ![
      ownership.workspaceId,
      ownership.channelConnectionId,
      ownership.bindingEpoch,
      subject.privacyEpoch,
    ].every(value => Number.isSafeInteger(value) && value > 0)
  ) {
    throw new Error("Messenger customer testing requires a verified scope");
  }
  const assertCurrentState = (state: MessengerUserState | null) => {
    if (
      !state ||
      state.psid !== psid ||
      state.pageId !== pageId ||
      state.workspaceId !== ownership.workspaceId ||
      state.channelConnectionId !== ownership.channelConnectionId ||
      state.bindingEpoch !== ownership.bindingEpoch ||
      state.privacyEpoch !== subject.privacyEpoch ||
      !state.consentGiven
    ) {
      throw new Error(
        "Messenger customer testing requires current consent and scope"
      );
    }
    if (state.stage === "PROCESSING") {
      throw new Error(
        "Messenger customer testing cannot change during generation"
      );
    }
  };
  assertCurrentState(await getState(psid));
  if (await hasInFlightGeneration(psid)) {
    throw new Error(
      "Messenger customer testing cannot change during generation"
    );
  }
  await patchState(psid, current => {
    assertCurrentState(current);
    return { customerTestMode: enabled };
  });
}
