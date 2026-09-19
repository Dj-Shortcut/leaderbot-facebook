import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import { isCreditBalanceCommand } from "../../creditBalanceAction";
import { readPaidCreditBalance } from "../../billing/creditGenerationAdmission";
import { getMessengerImageQuotaStatus } from "../../messengerImageQuotaStore";
import {
  getMessengerRequestOwnership,
  getMessengerRequestChannel,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "../../messengerRequestContext";
import { assertMessengerPrivacySubject } from "../../messengerPrivacySubject";
import { assertMessengerGenerationOwnership } from "../../workspaceEntitlementRuntime";
import { getUserKey } from "../../messengerStateNormalization";
import { toUserKey } from "../../privacy";

async function sendCreditBalance(ctx: BotTextContext): Promise<void> {
  const unavailable =
    ctx.lang === "nl"
      ? "Je creditsaldo is momenteel niet beschikbaar. Probeer het straks opnieuw."
      : "Your credit balance is currently unavailable. Please try again shortly.";
  let text: string;
  try {
    const ownership = getMessengerRequestOwnership();
    const subject = getMessengerRequestPrivacySubject();
    const pageId = getMessengerRequestPageId();
    if (
      getMessengerRequestChannel() !== "facebook_messenger" ||
      !ownership ||
      !subject ||
      !pageId ||
      subject.userKey !== ctx.userId ||
      ctx.userId !== toUserKey(ctx.senderId) ||
      ctx.state.consentGiven !== true ||
      ctx.state.psid !== ctx.senderId ||
      ctx.state.userKey !== subject.userKey ||
      ctx.state.pageId !== pageId ||
      ctx.state.workspaceId !== ownership.workspaceId ||
      ctx.state.channelConnectionId !== ownership.channelConnectionId ||
      ctx.state.bindingEpoch !== ownership.bindingEpoch ||
      ctx.state.privacyEpoch !== subject.privacyEpoch
    ) {
      throw new Error(
        "Credit balance requires current Messenger consent and scope"
      );
    }
    const fence = {
      ...ownership,
      ...subject,
      pageId,
      channel: "facebook_messenger" as const,
    };
    await assertMessengerGenerationOwnership(fence);
    await assertMessengerPrivacySubject(fence);
    const [free, premium] = await Promise.allSettled([
      getMessengerImageQuotaStatus({
        ...ownership,
        ...subject,
        userKey: getUserKey(subject.userKey),
      }),
      readPaidCreditBalance({ ...ownership, ...subject, requestId: ctx.reqId }),
    ]);
    const lines: string[] = [];
    if (free.status === "fulfilled") {
      lines.push(
        ctx.lang === "nl"
          ? `Gratis afbeeldingen: vandaag nog ${free.value.daily.remaining} van ${free.value.daily.limit}. Deze maand nog ${free.value.monthly.remaining} van ${free.value.monthly.limit}.`
          : `Free images: ${free.value.daily.remaining} of ${free.value.daily.limit} left today. ${free.value.monthly.remaining} of ${free.value.monthly.limit} left this month.`
      );
    } else {
      lines.push(
        ctx.lang === "nl"
          ? "Gratis afbeeldingen: saldo momenteel niet beschikbaar."
          : "Free images: balance currently unavailable."
      );
    }
    if (premium.status === "fulfilled" && premium.value !== null) {
      lines.push(
        ctx.lang === "nl"
          ? `Premiumcredits: ${premium.value} beschikbaar.`
          : `Premium credits: ${premium.value} available.`
      );
    } else {
      lines.push(
        ctx.lang === "nl"
          ? "Premiumcredits: saldo momenteel niet beschikbaar."
          : "Premium credits: balance currently unavailable."
      );
    }
    text = lines.join("\n");
  } catch {
    ctx.logger.warn("messenger_credit_balance_unavailable", {});
    text = unavailable;
  }
  await ctx.sendText(text);
}

export const creditsFeature: BotFeature = {
  name: "credits",
  async onText(ctx) {
    if (
      ctx.channel !== "messenger" ||
      !isCreditBalanceCommand(ctx.messageText)
    ) {
      return { handled: false };
    }
    await sendCreditBalance(ctx);
    return { handled: true };
  },
};
