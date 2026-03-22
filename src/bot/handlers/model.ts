import { Context, InlineKeyboard } from "grammy";
import { selectModel, fetchCurrentModel, getModelSelectionLists } from "../../model/manager.js";
import { formatModelForDisplay } from "../../model/types.js";
import type { FavoriteModel, ModelInfo } from "../../model/types.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { logger } from "../../utils/logger.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { getStoredAgent } from "../../agent/manager.js";
import { pinnedMessageManager } from "../../platform/telegram/pinned-manager.js";
import { keyboardManager } from "../../platform/telegram/keyboard-manager.js";
import {
  appendInlineMenuCancelButton,
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "./inline-menu.js";
import { t } from "../../i18n/index.js";
import { config } from "../../config.js";

const MODEL_PAGE_CALLBACK_PREFIX = "model:page:";

/**
 * Cache for model callbacks to avoid Telegram's 64-byte limit.
 * Maps short identifiers to model data.
 */
const modelCallbackCache = new Map<string, { providerID: string; modelID: string }>();
let modelCallbackCounter = 0;

/**
 * Generate a short callback identifier for a model.
 * Telegram callback data must be ≤64 bytes. "model:provider:modelID" can exceed this.
 */
function encodeModelCallback(providerID: string, modelID: string): string {
  const shortId = `${modelCallbackCounter++}`;
  modelCallbackCache.set(shortId, { providerID, modelID });

  // Clean old entries if cache grows too large (keep last 200)
  if (modelCallbackCache.size > 200) {
    const keysToDelete: string[] = [];
    let count = 0;
    for (const key of modelCallbackCache.keys()) {
      if (count < modelCallbackCache.size - 200) {
        keysToDelete.push(key);
        count++;
      } else {
        break;
      }
    }
    for (const key of keysToDelete) {
      modelCallbackCache.delete(key);
    }
  }
  return `model:${shortId}`;
}

/**
 * Decode a model callback identifier back to providerID and modelID.
 */
function decodeModelCallback(data: string): { providerID: string; modelID: string } | null {
  const shortId = data.slice("model:".length);
  return modelCallbackCache.get(shortId) ?? null;
}

export interface ModelListItem {
  model: FavoriteModel;
  isFavorite: boolean;
}

interface ModelsPaginationRange {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

export function parseModelPageCallback(data: string): number | null {
  if (!data.startsWith(MODEL_PAGE_CALLBACK_PREFIX)) {
    return null;
  }
  const raw = data.slice(MODEL_PAGE_CALLBACK_PREFIX.length);
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 0) {
    return null;
  }
  return page;
}

export function buildCombinedModelList(
  favorites: FavoriteModel[],
  recent: FavoriteModel[],
): ModelListItem[] {
  return [
    ...favorites.map((model) => ({ model, isFavorite: true })),
    ...recent.map((model) => ({ model, isFavorite: false })),
  ];
}

export function calculateModelsPaginationRange(
  totalModels: number,
  page: number,
  pageSize: number,
): ModelsPaginationRange {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalModels / safePageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalModels);
  return { page: normalizedPage, totalPages, startIndex, endIndex };
}

function buildModelMenuText(
  currentModel: ModelInfo | undefined,
  page: number,
  totalPages: number,
): string {
  const baseText =
    currentModel && currentModel.providerID && currentModel.modelID
      ? t("model.menu.current", {
          name: formatModelForDisplay(currentModel.providerID, currentModel.modelID),
        })
      : t("model.menu.select");

  if (totalPages <= 1) {
    return baseText;
  }

  return `${baseText}

${t("model.menu.page_indicator", {
  current: String(page + 1),
  total: String(totalPages),
})}`;
}

function buildModelKeyboard(
  combined: ModelListItem[],
  page: number,
  currentModel: ModelInfo | undefined,
  pageSize: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  } = calculateModelsPaginationRange(combined.length, page, pageSize);

  combined.slice(startIndex, endIndex).forEach(({ model, isFavorite }) => {
    const isActive =
      currentModel &&
      model.providerID === currentModel.providerID &&
      model.modelID === currentModel.modelID;
    const prefix = isFavorite ? "⭐" : "📝";
    const label = `${prefix} ${model.providerID}/${model.modelID}`;
    const labelWithCheck = isActive ? `✅ ${label}` : label;
    const callbackData = encodeModelCallback(model.providerID, model.modelID);
    keyboard.text(labelWithCheck, callbackData).row();
  });

  if (totalPages > 1) {
    if (normalizedPage > 0) {
      keyboard.text(
        t("model.menu.prev_page"),
        `${MODEL_PAGE_CALLBACK_PREFIX}${normalizedPage - 1}`,
      );
    }
    if (normalizedPage < totalPages - 1) {
      keyboard.text(
        t("model.menu.next_page"),
        `${MODEL_PAGE_CALLBACK_PREFIX}${normalizedPage + 1}`,
      );
    }
  }

  return keyboard;
}

/**
 * Handle model selection callback (model select OR page navigation)
 * @param ctx grammY context
 * @returns true if handled, false otherwise
 */
export async function handleModelSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith("model:")) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "model");
  if (!isActiveMenu) {
    return true;
  }

  logger.debug(`[ModelHandler] Received callback: ${callbackQuery.data}`);

  // Page navigation
  const pageNum = parseModelPageCallback(callbackQuery.data);
  if (pageNum !== null) {
    try {
      const pageSize = config.bot.modelsListLimit;
      const currentModel = fetchCurrentModel();
      const modelLists = await getModelSelectionLists();
      const combined = buildCombinedModelList(modelLists.favorites, modelLists.recent);

      if (combined.length === 0) {
        await ctx.answerCallbackQuery({ text: t("model.menu.page_empty_callback") });
        return true;
      }

      const { totalPages } = calculateModelsPaginationRange(combined.length, pageNum, pageSize);
      const keyboard = buildModelKeyboard(combined, pageNum, currentModel, pageSize);
      appendInlineMenuCancelButton(keyboard, "model");
      const text = buildModelMenuText(currentModel, pageNum, totalPages);

      await ctx.editMessageText(text, { reply_markup: keyboard });
      await ctx.answerCallbackQuery();
    } catch (err) {
      logger.error("[ModelHandler] Error loading models page:", err);
      await ctx
        .answerCallbackQuery({ text: t("model.menu.page_load_error_callback") })
        .catch(() => {});
    }
    return true;
  }

  // Model selection
  try {
    if (ctx.chat) {
      keyboardManager.initialize(ctx.api, ctx.chat.id);
    }

    // Decode model from short callback identifier
    const modelData = decodeModelCallback(callbackQuery.data);
    if (!modelData) {
      logger.error(`[ModelHandler] Invalid callback data: ${callbackQuery.data}`);
      clearActiveInlineMenu("model_select_invalid_callback");
      await ctx.answerCallbackQuery({ text: t("model.change_error_callback") }).catch(() => {});
      return true;
    }

    const { providerID, modelID } = modelData;

    const modelInfo: ModelInfo = {
      providerID,
      modelID,
      variant: "default", // Reset to default when switching models
    };

    selectModel(modelInfo);
    keyboardManager.updateModel(modelInfo);
    await pinnedMessageManager.refreshContextLimit();

    const currentAgent = getStoredAgent();
    const contextInfo =
      pinnedMessageManager.getContextInfo() ??
      (pinnedMessageManager.getContextLimit() > 0
        ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() }
        : null);

    if (contextInfo) {
      keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
    }

    const variantName = formatVariantForButton(modelInfo.variant || "default");
    const keyboard = createMainKeyboard(
      currentAgent,
      modelInfo,
      contextInfo ?? undefined,
      variantName,
    );
    const displayName = formatModelForDisplay(modelInfo.providerID, modelInfo.modelID);

    clearActiveInlineMenu("model_selected");
    await ctx.answerCallbackQuery({ text: t("model.changed_callback", { name: displayName }) });
    await ctx.reply(t("model.changed_message", { name: displayName }), {
      reply_markup: keyboard,
    });
    await ctx.deleteMessage().catch(() => {});
    return true;
  } catch (err) {
    clearActiveInlineMenu("model_select_error");
    logger.error("[ModelHandler] Error handling model select:", err);
    await ctx.answerCallbackQuery({ text: t("model.change_error_callback") }).catch(() => {});
    return false;
  }
}

/**
 * Show model selection menu (first page)
 * @param ctx grammY context
 */
export async function showModelSelectionMenu(ctx: Context): Promise<void> {
  try {
    const pageSize = config.bot.modelsListLimit;
    const currentModel = fetchCurrentModel();
    const modelLists = await getModelSelectionLists();
    const combined = buildCombinedModelList(modelLists.favorites, modelLists.recent);

    if (combined.length === 0) {
      await ctx.reply(t("model.menu.empty"));
      return;
    }

    const { totalPages } = calculateModelsPaginationRange(combined.length, 0, pageSize);
    const keyboard = buildModelKeyboard(combined, 0, currentModel, pageSize);
    const text = buildModelMenuText(currentModel, 0, totalPages);

    await replyWithInlineMenu(ctx, {
      menuKind: "model",
      text,
      keyboard,
    });
  } catch (err) {
    logger.error("[ModelHandler] Error showing model menu:", err);
    await ctx.reply(t("model.menu.error"));
  }
}
