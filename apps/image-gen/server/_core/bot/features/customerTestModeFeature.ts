import type { BotFeature } from "../features";
import { isMessengerAdmin } from "../../messengerAdmin";
import { getState } from "../../messengerState";
import {
  isCustomerTestConfiguration,
  setMessengerCustomerTestMode,
} from "../../messengerCustomerTestMode";

export const customerTestModeFeature: BotFeature = {
  name: "customerTestMode",
  async onText(ctx) {
    const match = /^\/testklant(?:\s+(.*))?$/iu.exec(ctx.messageText.trim());
    if (!match) return { handled: false };
    // Consume this command even for non-admins; it must never become a prompt.
    if (
      ctx.channel !== "messenger" ||
      !isMessengerAdmin(ctx.senderId, ctx.userId)
    ) {
      await ctx.sendText("Dit commando is alleen voor de beheerder.");
      return { handled: true };
    }
    const action = (match[1] ?? "status").toLowerCase();
    if (!["aan", "uit", "status"].includes(action)) {
      await ctx.sendText(
        "Gebruik /testklant aan, /testklant uit of /testklant status."
      );
      return { handled: true };
    }
    if (action === "status") {
      const state = await getState(ctx.senderId);
      const enabled = state?.customerTestMode === true;
      await ctx.sendText(
        enabled
          ? isCustomerTestConfiguration()
            ? "Testen als klant staat AAN. Je gewone quota, credits en budgetgrenzen gelden. Mollie staat in Test Mode. Je beheerdersrechten blijven behouden."
            : "Testen als klant staat AAN, maar is geblokkeerd omdat Mollie niet veilig in Test Mode staat."
          : "Testen als klant staat UIT. Je gebruikelijke beheerdersvrijstellingen gelden."
      );
      return { handled: true };
    }
    try {
      await setMessengerCustomerTestMode(
        ctx.senderId,
        ctx.userId,
        action === "aan"
      );
    } catch {
      await ctx.sendText(
        "Omschakelen is nu niet mogelijk. Dit kan alleen na toestemming, buiten een lopende generatie en bij inschakelen met Mollie in Test Mode. Probeer daarna opnieuw."
      );
      return { handled: true };
    }
    ctx.logger.info("messenger_customer_test_mode_changed", {
      enabled: action === "aan",
    });
    await ctx.sendText(
      action === "aan"
        ? "Testen als klant staat AAN. Je behoudt je beheerdersrechten. Je bestaande gratis quota en gekochte credits blijven behouden. Wanneer beide op zijn, verschijnt de gewone betaalknop voor een Mollie-testbetaling. Gebruik /testklant uit om terug te schakelen."
        : "Testen als klant staat UIT. Je gebruikelijke beheerdersvrijstellingen gelden weer. Je quota en credits zijn niet gewijzigd."
    );
    return { handled: true };
  },
};
