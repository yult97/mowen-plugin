import { Highlight, HighlightSaveResult, SaveHighlightPayload } from '../types';

interface SettingsLike {
  defaultPublic: boolean;
  enableAutoTag: boolean;
}

interface HighlightCacheEntry {
  noteId?: string;
  body?: Record<string, unknown>;
  expiresAt?: string;
}

function getPageKey(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    return url;
  }
}

/**
 * 注册“保存到墨问笔记”右键菜单以及点击后的保存逻辑。
 * 该模块只编排上下文菜单交互，不直接依赖主剪藏保存状态机。
 */
export function registerContextMenuHandlers(deps: {
  getSettings: () => Promise<SettingsLike>;
  handleSaveHighlight: (payload: SaveHighlightPayload) => Promise<HighlightSaveResult>;
  formatErrorForLog: (error: unknown) => string;
}): void {
  const { getSettings, handleSaveHighlight, formatErrorForLog } = deps;

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'mowen-save-selection',
      title: '保存到墨问笔记',
      contexts: ['selection'],
    }, () => {
      if (chrome.runtime.lastError) {
        console.log('[墨问 Background] ⚠️ Context menu creation:', chrome.runtime.lastError.message);
      } else {
        console.log('[墨问 Background] ✅ Context menu registered');
      }
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'mowen-save-selection' || !info.selectionText || !tab?.id) {
      return;
    }

    console.log('[墨问 Background] 📝 Context menu clicked, selection:', info.selectionText.substring(0, 50));

    const pageUrl = info.pageUrl || tab.url || '';
    const pageTitle = tab.title || 'Unknown';
    const highlight: Highlight = {
      id: `ctx-${Date.now()}`,
      text: info.selectionText,
      sourceUrl: pageUrl,
      pageTitle,
      createdAt: new Date().toISOString(),
    };

    const settings = await getSettings();
    const cacheKey = `highlight_note_${getPageKey(pageUrl)}`;

    let existingNoteId: string | undefined;
    let existingBody: Record<string, unknown> | undefined;

    try {
      const cached = await chrome.storage.local.get([cacheKey]);
      const existingCache = cached[cacheKey] as HighlightCacheEntry | undefined;

      if (existingCache?.noteId) {
        const isExpired = existingCache.expiresAt && new Date(existingCache.expiresAt) < new Date();
        if (!isExpired) {
          existingNoteId = existingCache.noteId;
          existingBody = existingCache.body;
          console.log('[墨问 Background] ✅ Found existing noteId for context menu:', existingNoteId);
        } else {
          console.log('[墨问 Background] ⚠️ Cache expired for context menu save');
        }
      }
    } catch (error) {
      console.error(`[墨问 Background] Failed to get cache for context menu: ${formatErrorForLog(error)}`);
    }

    const payload: SaveHighlightPayload = {
      highlight,
      isPublic: settings.defaultPublic,
      enableAutoTag: settings.enableAutoTag,
      existingNoteId,
      existingBody,
    };

    try {
      const result = await handleSaveHighlight(payload);

      if (result.success && result.noteId) {
        const newCache = {
          noteId: result.noteId,
          noteUrl: result.noteUrl,
          pageUrl,
          pageTitle,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          highlightCount: 1,
          body: result.updatedBody,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
        await chrome.storage.local.set({ [cacheKey]: newCache });
        console.log('[墨问 Background] ✅ Cache updated for context menu save');
      }

      chrome.tabs.sendMessage(tab.id, {
        type: 'HIGHLIGHT_RESULT',
        payload: result,
      }).catch(() => {
        // Content script 可能未加载，忽略
      });

      console.log('[墨问 Background] ✅ Context menu save result:', result.success);
    } catch (error) {
      console.error(`[墨问 Background] Context menu save failed: ${formatErrorForLog(error)}`);
    }
  });
}
