import type { Context } from "grammy";
import type { NormalizedInput } from "../../types.js";

/**
 * Normalize a grammY Context into a platform-agnostic NormalizedInput
 * for use by the interaction guard and other platform-agnostic logic.
 */
export function normalizeInput(ctx: Context): NormalizedInput {
  if (ctx.callbackQuery?.data !== undefined) {
    return { type: "callback", callbackData: ctx.callbackQuery.data };
  }
  if (ctx.message?.text !== undefined) {
    return { type: "text", text: ctx.message.text };
  }
  if (ctx.message?.photo !== undefined) {
    const photo = ctx.message.photo;
    const largest = photo[photo.length - 1];
    return { type: "photo", fileId: largest?.file_id };
  }
  if (ctx.message?.voice !== undefined) {
    return { type: "voice", fileId: ctx.message.voice.file_id };
  }
  if (ctx.message?.document !== undefined) {
    return { type: "document", fileId: ctx.message.document.file_id };
  }
  return { type: "unknown" };
}
