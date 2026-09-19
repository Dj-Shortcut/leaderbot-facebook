import type { BotFeature } from "../features";

import {
  appendPhotoConversationTurn,
  isPhotoConversationEnabled,
  normalizePhotoConversation,
} from "../../photoConversationMemory";
import {
  assertPhotoConversationState,
  interpretPhotoConversation,
  photoConversationSnapshot,
  readCurrentPhotoConversationState,
  withPhotoConversationTurn,
} from "../../photoConversation";
import { patchState } from "../../messengerStatePersistence";
import { MessengerSpendBudgetExceededError } from "../../generationGuard";

export const photoConversationFeature: BotFeature = {
  name: "photoConversation",
  async onText(ctx) {
    if (
      !isPhotoConversationEnabled() ||
      ctx.channel !== "messenger" ||
      ctx.normalizedText.startsWith("/") ||
      [
        "new_image",
        "new image",
        "nieuwe afbeelding",
        "nieuwe foto",
        "nieuw beeld",
        "privacy",
        "privacybeleid",
        "privacy policy",
      ].includes(ctx.normalizedText)
    )
      return { handled: false };
    let dispatchAccepted = false;
    try {
      await withPhotoConversationTurn(ctx, async assertLease => {
        const result = await interpretPhotoConversation(ctx, assertLease);
        if (!result) {
          ctx.suppressFallback?.();
          return;
        }
        const { decision, images, snapshot } = result;
        const current = await readCurrentPhotoConversationState(ctx);
        if (photoConversationSnapshot(current) !== snapshot)
          throw new Error("Photo conversation changed");
        await assertLease();
        // A CAS against the exact context prevents an older model response from
        // overwriting an upload, reset, or newer conversation turn.
        await patchState(ctx.senderId, state => {
          assertPhotoConversationState(ctx, state);
          if (photoConversationSnapshot(state) !== snapshot)
            throw new Error("Photo conversation changed");
          const photoConversation = appendPhotoConversationTurn(state, {
            id: `${ctx.reqId}:user`,
            role: "user",
            text: ctx.messageText,
          });
          photoConversation.executions = [
            ...(photoConversation.executions ?? []).filter(
              entry => entry.requestId !== ctx.reqId
            ),
            { requestId: ctx.reqId, decision, completed: false },
          ].slice(-6);
          return { photoConversation };
        });
        if (decision.action === "reply") {
          await ctx.sendText(decision.reply);
        } else if (decision.action === "generate") {
          await ctx.runImageGeneration(
            undefined,
            decision.prompt,
            "text_to_image"
          );
        } else {
          const sources = decision.imageIds.map(
            id => images.find(image => image.id === id)!.url
          );
          await ctx.runImageGeneration(
            sources[0],
            decision.prompt,
            "source_image_edit",
            sources
          );
        }
        dispatchAccepted = true;
        await patchState(ctx.senderId, state => {
          assertPhotoConversationState(ctx, state);
          let photoConversation = normalizePhotoConversation(
            state.photoConversation
          );
          if (
            !photoConversation.executions?.some(
              entry => entry.requestId === ctx.reqId
            )
          )
            return {};
          photoConversation.executions = photoConversation.executions.map(
            entry =>
              entry.requestId === ctx.reqId
                ? { ...entry, completed: true }
                : entry
          );
          if (decision.action === "reply")
            photoConversation = appendPhotoConversationTurn(
              { ...state, photoConversation },
              {
                id: `${ctx.reqId}:assistant`,
                role: "assistant",
                text: decision.reply,
              }
            );
          return { photoConversation };
        });
      });
    } catch (error) {
      if (dispatchAccepted) {
        ctx.logger.warn("photo_conversation_completion_pending", {
          reqId: ctx.reqId,
        });
        ctx.suppressFallback?.();
        return { handled: true };
      }
      ctx.logger.warn("photo_conversation_unavailable", { reqId: ctx.reqId });
      // Never let an interpreter failure reach heuristic image generation.
      // Revalidate before replying, including when deletion raced the call.
      try {
        await readCurrentPhotoConversationState(ctx);
      } catch {
        ctx.suppressFallback?.();
        return { handled: true };
      }
      if (error instanceof MessengerSpendBudgetExceededError) {
        const dailyLimit =
          error.limit === "user_daily" || error.limit === "daily";
        await ctx.sendText(
          dailyLimit
            ? ctx.lang === "en"
              ? "The daily processing limit has been reached. Your credits are kept; this request has not started. You can continue tomorrow."
              : "De daglimiet voor beeldverwerking is bereikt. Je credits blijven behouden; deze aanvraag is niet gestart. Je kunt morgen weer verder."
            : ctx.lang === "en"
              ? "The bot's usage budget is currently unavailable. Your credits are kept; this request has not started."
              : "Het gebruiksbudget van de bot is momenteel niet beschikbaar. Je credits blijven behouden; deze aanvraag is niet gestart."
        );
        return { handled: true };
      }
      await ctx.sendText(
        ctx.lang === "en"
          ? "I couldn't process that just now. Could you try again?"
          : "Dat kon ik net niet verwerken. Wil je het nog eens proberen?"
      );
    }
    return { handled: true };
  },
};
