console.log('[墨问 Background] 🏁 Service Worker Script Loaded');
import {
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NotePart,
  NoteCreateResult,
  ImageFailureReason,
  SaveHighlightPayload,
  HighlightSaveResult,
  Highlight,
} from '../types';
import { getSettings, saveSettings } from '../utils/storage';
import { sleep } from '../utils/helpers';

import { createNote, createNoteWithBody, uploadImageWithFallback, ImageUploadResult, editNote } from '../services/api';
import { LIMITS, backgroundLogger as logger } from '../utils/constants';
import { TaskStore } from '../utils/taskStore';
import { GlobalRateLimiter } from '../utils/rateLimiter';
import { htmlToNoteAtom } from '../utils/noteAtom';

const SAFE_LIMIT = LIMITS.SAFE_CONTENT_LENGTH;
const MAX_RETRY_ROUNDS = LIMITS.MAX_RETRY_ROUNDS;
const IMAGE_TIMEOUT = LIMITS.IMAGE_UPLOAD_TIMEOUT;

// Running Tasks Map: tabId -> AbortController
const runningTasks = new Map<number, AbortController>();

// ============================================
// Side Panel 配置：Tab 级别可见性控制
// 原理：利用 setOptions({ tabId, enabled }) 在 Tab 切换时动态切换可见性
// 使用 chrome.storage.session 持久化状态，避免 Service Worker 重启后丢失
// ============================================

// Side Panel 状态持久化 key
const SIDE_PANEL_TABS_KEY = 'sidePanelOpenedTabs';

// 辅助函数：获取已开启 Side Panel 的 Tab 列表
async function getSidePanelOpenedTabs(): Promise<Set<number>> {
  const result = await chrome.storage.session.get(SIDE_PANEL_TABS_KEY);
  const tabs = result[SIDE_PANEL_TABS_KEY] || [];
  return new Set<number>(tabs);
}

// 辅助函数：添加 Tab 到已开启列表
async function addSidePanelTab(tabId: number): Promise<void> {
  const tabs = await getSidePanelOpenedTabs();
  tabs.add(tabId);
  await chrome.storage.session.set({ [SIDE_PANEL_TABS_KEY]: Array.from(tabs) });
}

// 辅助函数：从已开启列表移除 Tab
async function removeSidePanelTab(tabId: number): Promise<void> {
  const tabs = await getSidePanelOpenedTabs();
  tabs.delete(tabId);
  await chrome.storage.session.set({ [SIDE_PANEL_TABS_KEY]: Array.from(tabs) });
}

// 1. 禁用自动打开（需要手动控制以确保 enabled 先设置好）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error('[墨问 Background] ❌ Failed to set side panel behavior:', error));

// 2. 默认在全局禁用 Side Panel（仅在特定 tab 启用）
chrome.sidePanel.setOptions({ enabled: false })
  .catch((error) => console.error('[墨问 Background] ❌ Failed to set global side panel options:', error));

// 3. 当用户点击 Action 时，为当前 tab 启用并打开 Side Panel
// 关键：先同步调用 setOptions（不 await），然后立即 await open()
// 这样 open() 仍在用户手势上下文中
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    try {
      // 同步启动 setOptions（不等待完成）
      chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true,
      });

      // 立即调用 open()，此时仍在用户手势上下文中
      await chrome.sidePanel.open({ tabId: tab.id });

      // 持久化记录（open 成功后再保存）
      await addSidePanelTab(tab.id);

      console.log(`[墨问 Background] ✅ Side Panel opened for tab ${tab.id}`);
    } catch (error) {
      console.error('[墨问 Background] ❌ Failed to open side panel:', error);
    }
  }
});

// 4. 当切换 tab 时，根据该 tab 是否开启过 Side Panel 来切换 enabled 状态
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  const openedTabs = await getSidePanelOpenedTabs();
  const shouldEnable = openedTabs.has(tabId);

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: shouldEnable,
  });

  console.log(`[墨问 Background] 🔄 Tab ${tabId} activated, Side Panel enabled=${shouldEnable}`);

  // 通知 Side Panel 刷新当前 Tab 信息（解决内容跨 Tab 残留问题）
  // Side Panel 是持久化页面，需要主动通知它 Tab 已切换
  if (shouldEnable) {
    chrome.runtime.sendMessage({
      type: 'TAB_ACTIVATED',
      payload: { tabId, windowId },
    }).catch(() => {
      // Side Panel 可能未打开或未监听，忽略错误
    });
  }
});

// 5. 当 tab 关闭时，从记录中移除
chrome.tabs.onRemoved.addListener((tabId) => {
  removeSidePanelTab(tabId).catch(() => { });
});

// ============================================
// 右键菜单注册（用于划线保存）
// ============================================
chrome.runtime.onInstalled.addListener(() => {
  // 注册右键菜单：选中文本时显示"保存到墨问"
  chrome.contextMenus.create({
    id: 'mowen-save-selection',
    title: '保存到墨问笔记',
    contexts: ['selection'],
  }, () => {
    // 检查是否有错误（如菜单已存在）
    if (chrome.runtime.lastError) {
      console.log('[墨问 Background] ⚠️ Context menu creation:', chrome.runtime.lastError.message);
    } else {
      console.log('[墨问 Background] ✅ Context menu registered');
    }
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mowen-save-selection' && info.selectionText && tab?.id) {
    console.log('[墨问 Background] 📝 Context menu clicked, selection:', info.selectionText.substring(0, 50));

    // 构造划线数据
    const highlight: Highlight = {
      id: `ctx-${Date.now()}`,
      text: info.selectionText,
      sourceUrl: info.pageUrl || tab.url || '',
      pageTitle: tab.title || 'Unknown',
      createdAt: new Date().toISOString(),
    };

    // 获取设置
    const settings = await getSettings();

    // 保存划线
    const payload: SaveHighlightPayload = {
      highlight,
      isPublic: settings.defaultPublic,
      enableAutoTag: settings.enableAutoTag,
    };

    try {
      const result = await handleSaveHighlight(payload);

      // 通知 Content Script 显示结果
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'HIGHLIGHT_RESULT',
          payload: result,
        }).catch(() => {
          // Content script 可能未加载，忽略
        });
      }

      console.log('[墨问 Background] ✅ Context menu save result:', result.success);
    } catch (error) {
      console.error('[墨问 Background] ❌ Context menu save failed:', error);
    }
  }
});

interface SaveNotePayload {
  extractResult: ExtractResult;
  isPublic: boolean;
  includeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  enableAutoTag?: boolean;  // 是否自动添加「墨问剪藏」标签
  tabId?: number; // Optional, can be injected by sender
}

// Helper to proxy logs to Content Script
function logToContentScript(msg: string, tabId?: number): void {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'LOG_DEBUG', payload: `[BG] ${msg}` }).catch(() => {
      // Content script 可能未加载，忽略错误
    });
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  logger.log('Received message:', message.type);

  if (message.type === 'PING') {
    logger.log('🏓 PING received');
    sendResponse({ success: true, status: 'pong' });
    return false;
  }

  if (message.type === 'CANCEL_SAVE') {
    const tabId = message.payload?.tabId;
    console.log(`[墨问 Background] ❌ CANCEL_SAVE received for tab ${tabId}`);

    if (tabId && runningTasks.has(tabId)) {
      const controller = runningTasks.get(tabId);
      controller?.abort();
      runningTasks.delete(tabId);
      console.log(`[墨问 Background] 🛑 Task for tab ${tabId} aborted`);
    } else {
      console.log(`[墨问 Background] ⚠️ No running task found for tab ${tabId}`);
    }

    sendResponse({ success: true });
    return false;
  }

  // 通过 Background Script 保存设置，确保 Popup 关闭后设置仍能持久化
  if (message.type === 'SAVE_SETTING') {
    console.log('[墨问 Background] ⚙️ SAVE_SETTING received:', message.payload);
    (async () => {
      try {
        await saveSettings(message.payload);
        console.log('[墨问 Background] ✅ Settings saved successfully');
        sendResponse({ success: true });
      } catch (error) {
        console.error('[墨问 Background] ❌ Failed to save settings:', error);
        sendResponse({ success: false, error: String(error) });
      }
    })();
    return true; // 保持消息通道开放以便异步响应
  }

  if (message.type === 'SAVE_NOTE') {
    console.log('[墨问 Background] 💾 SAVE_NOTE request received');
    logToContentScript('💾 SAVE_NOTE received');
    try {
      if (message.payload) {
        console.log('[墨问 Background] Payload:', {
          title: message.payload?.extractResult?.title,
          wordCount: message.payload?.extractResult?.wordCount,
          images: message.payload?.extractResult?.images?.length,
        });
      } else {
        console.log('[墨问 Background] ⚠️ Message payload is missing');
        logToContentScript('⚠️ Message payload is missing');
      }
    } catch (e) {
      console.log('[墨问 Background] ⚠️ Error logging payload:', e);
    }

    if (!message.payload) {
      console.error('[墨问 Background] ❌ Payload is undefined/null in SAVE_NOTE message');
      sendResponse({ success: false, error: 'Payload is undefined' });
      return false;
    }

    // Send immediate acknowledgment to prevent message channel timeout
    sendResponse({ success: true, acknowledged: true });

    // Process save asynchronously without blocking the message channel
    console.log('[墨问 Background] ⏳ Calling handleSaveNote...');

    // Determine tabId: prioritize payload, then sender (if from cs), then active tab
    // Ideally Popup should send the target tabId in payload
    // If not, we query active tab at this moment (assuming user hasn't switched yet)

    (async () => {
      let targetTabId = message.payload?.tabId;
      if (!targetTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = activeTab?.id;
      }

      if (!targetTabId) {
        console.error('[墨问 Background] ❌ Could not determine target tab ID');
        return;
      }

      try {
        handleSaveNote(message.payload, targetTabId)
          .then((result) => {
            console.log(`[墨问 Background] 📤 Sending SAVE_NOTE_COMPLETE for tab ${targetTabId}:`, result.success);
            // Send result via a separate message to popup/content
            // We can't target popup easily, but sendMessage works if popup is listening
            chrome.runtime.sendMessage({
              type: 'SAVE_NOTE_COMPLETE',
              result,
            }).catch(() => { });
          })
          .catch((error) => {
            console.error('[墨问 Background] ❌ Save process failed:', error);
            chrome.runtime.sendMessage({
              type: 'SAVE_NOTE_COMPLETE',
              result: {
                success: false,
                error: error.message || 'Unknown error',
              },
            }).catch(() => { });
          });
      } catch (e) {
        console.error('[墨问 Background] ❌ CRITICAL: Synchronous error calling handleSaveNote:', e);
      }
    })();

    // Return false as we're not using sendResponse asynchronously anymore
    return false;
  }

  // 处理划线保存请求
  if (message.type === 'SAVE_HIGHLIGHT') {
    console.log('[墨问 Background] 📝 SAVE_HIGHLIGHT request received');
    console.log('[墨问 Background] 📝 SAVE_HIGHLIGHT payload:', message.payload);

    // 使用 Promise 包装确保 sendResponse 一定被调用
    handleSaveHighlight(message.payload as SaveHighlightPayload)
      .then((result) => {
        console.log('[墨问 Background] ✅ SAVE_HIGHLIGHT result:', result);
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[墨问 Background] ❌ SAVE_HIGHLIGHT error:', error);
        const errorResult: HighlightSaveResult = {
          success: false,
          isAppend: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
        console.log('[墨问 Background] ❌ SAVE_HIGHLIGHT sending error result:', errorResult);
        sendResponse(errorResult);
      });
    return true; // 保持消息通道开放以便异步响应
  }

  // 打开设置页
  if (message.type === 'OPEN_OPTIONS_PAGE') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  return false;
});
// I will only replace the SAVE_NOTE handler part + handleSaveNote signature

/**
 * 处理划线保存请求
 * 首次保存创建笔记，后续保存追加到同一笔记
 */
async function handleSaveHighlight(payload: SaveHighlightPayload): Promise<HighlightSaveResult> {
  const { highlight, isPublic, enableAutoTag, existingNoteId, existingBody } = payload;

  console.log(`[墨问 Background] 📝 handleSaveHighlight: existingNoteId=${existingNoteId || 'none'}, hasExistingBody=${!!existingBody}`);

  // 获取设置
  const settings = await getSettings();
  if (!settings.apiKey) {
    return {
      success: false,
      isAppend: false,
      error: 'API Key 未配置',
      errorCode: 'UNAUTHORIZED',
    };
  }

  const apiKey = settings.apiKey;

  // 如果有已存在的笔记，尝试追加
  if (existingNoteId) {
    console.log(`[墨问 Background] 📝 Attempting to append to existing note: ${existingNoteId}`);

    try {
      let originalBody: { type: string; content?: unknown[] } | null = null;

      // 优先使用本地缓存的 body
      if (existingBody) {
        console.log(`[墨问 Background] 📝 Using cached body from local storage`);
        originalBody = existingBody as { type: string; content?: unknown[] };
      } else {
        // 缓存丢失，跳过追加流程，直接创建新笔记
        console.log(`[墨问 Background] ⚠️ No cached body available, will create new note`);
      }

      if (originalBody && Array.isArray(originalBody.content)) {
        // 空行分隔
        const emptyParagraph = {
          type: 'paragraph',
          content: [],
        };

        // 时间标注 + 👇划线内容（符合墨问 API 规范：quote 的 content 直接是 text 节点数组）
        const timeQuote = {
          type: 'quote',
          content: [
            { type: 'text', text: `📌 ${new Date(highlight.createdAt).toLocaleString('zh-CN')}`, marks: [{ type: 'highlight' }] },
          ],
        };
        const highlightLabelQuote = {
          type: 'quote',
          content: [
            { type: 'text', text: '👇划线内容', marks: [{ type: 'highlight' }] },
          ],
        };

        // 将 HTML 转换为 NoteAtom 格式以保留格式（引用、加粗、换行等）
        // 直接使用原始 HTML，不强制包裹 blockquote，以保留用户选中内容的原始结构
        const highlightHtml = highlight.html || `<p>${highlight.text}</p>`;
        const highlightAtom = htmlToNoteAtom(highlightHtml);
        const highlightBlocks = highlightAtom.content || [];

        // 追加到 content 数组：空行 + 时间引用 + 👇划线内容 + 空行 + 划线内容
        originalBody.content.push(emptyParagraph, timeQuote, highlightLabelQuote, emptyParagraph, ...highlightBlocks);

        // 调用编辑 API
        const editResult = await editNote(apiKey, existingNoteId, originalBody);

        if (editResult.success) {
          const noteUrl = isPublic
            ? `https://note.mowen.cn/detail/${existingNoteId}`
            : `https://note.mowen.cn/editor/${existingNoteId}`;

          return {
            success: true,
            noteId: existingNoteId,
            noteUrl,
            isAppend: true,
            // 返回更新后的 body 供前端缓存
            updatedBody: originalBody,
          };
        } else {
          console.log(`[墨问 Background] ⚠️ Edit failed: ${editResult.error}, errorCode: ${editResult.errorCode}, falling back to create new note`);
        }
      } else {
        console.log(`[墨问 Background] ⚠️ No valid body found, falling back to create new note`);
      }
    } catch (error) {
      console.error('[墨问 Background] ❌ Append failed:', error);
      // 降级为创建新笔记
    }
  }

  // 创建新笔记
  console.log('[墨问 Background] 📝 Creating new highlight note');

  // 构建划线内容 HTML（用于创建新笔记）
  const highlightHtml = formatHighlightContent(highlight);

  // URL 安全验证：仅允许 http/https 协议
  const isValidUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };
  const safeSourceUrl = isValidUrl(highlight.sourceUrl) ? highlight.sourceUrl : '';

  const title = `划线笔记：${highlight.pageTitle.substring(0, 50)}`;
  // 格式：标题 + 来源链接（由 createNote 统一添加）+ 时间引用 + 👇划线内容 + 空行 + 划线内容
  // 注意：来源链接通过 sourceUrl 参数传递给 createNote，与剪藏笔记保持一致的处理方式
  const content = `
    <p></p>
    <blockquote><p><mark>📌 ${new Date(highlight.createdAt).toLocaleString('zh-CN')}</mark></p><p><mark>👇划线内容</mark></p></blockquote>
    <p></p>
    ${highlightHtml}
  `;

  const createResult = await createNote(
    apiKey,
    title,
    content,
    isPublic,
    undefined,
    safeSourceUrl || undefined, // 通过 sourceUrl 参数传递，与剪藏笔记保持一致
    enableAutoTag
  );

  if (createResult.success) {
    // 构建初始 body 结构（用于前端缓存，便于后续追加）
    // 生成与服务端笔记结构一致的 NoteAtom body
    // 注意：API 只支持 doc, paragraph, quote, image 类型，不支持 heading
    const contentAtom = htmlToNoteAtom(content);
    // 使用 paragraph + bold 表示标题（与 createNote 的结构一致）
    const titleParagraph = {
      type: 'paragraph',
      content: [{ type: 'text', text: title, marks: [{ type: 'bold' }] }],
    };
    // 空段落（用于标题和内容之间的分隔）
    const emptyParagraphAfterTitle = {
      type: 'paragraph',
      content: [],
    };
    // 来源链接段落（与 createNote 中 createOriginalLinkHtml 生成的结构一致）
    const sourceLinkParagraph = safeSourceUrl ? {
      type: 'paragraph',
      content: [
        { type: 'text', text: '📄 来源：' },
        { type: 'text', text: '查看原文', marks: [{ type: 'link', attrs: { href: safeSourceUrl } }] },
      ],
    } : null;
    // 构建完整的 body：标题段落 + 空行 + 来源链接（如有）+ 空行 + 内容
    const bodyContent: unknown[] = [titleParagraph, emptyParagraphAfterTitle];
    if (sourceLinkParagraph) {
      bodyContent.push(sourceLinkParagraph);
      // 来源链接后添加空行，与时间引用分隔
      bodyContent.push({ type: 'paragraph', content: [] });
    }
    bodyContent.push(...(contentAtom.content || []));
    const initialBody = {
      type: 'doc',
      content: bodyContent,
    } as unknown as Record<string, unknown>;
    console.log('[墨问 Background] 📝 Created note with initial body for caching (including title paragraph)');

    return {
      success: true,
      noteId: createResult.noteId,
      noteUrl: createResult.noteUrl,
      isAppend: false,
      updatedBody: initialBody,  // 返回初始 body 供前端缓存
    };
  } else {
    return {
      success: false,
      isAppend: false,
      error: createResult.error,
      errorCode: createResult.errorCode,
    };
  }
}

/**
 * 格式化划线内容为 HTML
 */
function formatHighlightContent(highlight: Highlight): string {
  // 基础 XSS 防护：移除危险内容
  const sanitizeHtml = (html: string): string => {
    return html
      // 移除 script 标签及其内容
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      // 移除 javascript: 协议
      .replace(/javascript:/gi, '')
      // 移除内联事件处理器（如 onclick, onerror 等）
      .replace(/\s+on\w+\s*=/gi, ' data-removed=');
  };

  // 如果有 HTML 格式，优先使用原始 HTML，保留用户选中内容的原始结构
  // 不强制包裹 blockquote，以免把不在引用块里的文字也变成引用块
  if (highlight.html) {
    return sanitizeHtml(highlight.html);
  }
  // 否则使用纯文本，作为普通段落
  return `<p>${highlight.text}</p>`;
}

async function handleSaveNote(payload: SaveNotePayload, tabId: number): Promise<{
  success: boolean;
  notes?: Array<{ partIndex: number; noteUrl: string; isIndex?: boolean }>;
  error?: string;
  errorCode?: string;
}> {
  // Defensive check for payload
  if (!payload) {
    console.error('[墨问 Background] ❌ Payload is undefined/null');
    return { success: false, error: 'Payload is undefined', errorCode: 'INVALID_PAYLOAD' };
  }

  console.log(`[墨问 Background] 🚀 handleSaveNote started for tab ${tabId}`);
  logToContentScript('🚀 handleSaveNote started', tabId);

  let settings;
  try {
    settings = await getSettings();
    console.log('[墨问 Background] ✅ Settings loaded');
    logToContentScript('✅ Settings loaded', tabId);
  } catch (err) {
    console.error('[墨问 Background] ❌ Failed to load settings:', err);
    return { success: false, error: '无法加载设置', errorCode: 'SETTINGS_ERROR' };
  }

  const { extractResult, isPublic, includeImages, maxImages, createIndexNote, enableAutoTag } = payload;

  // Create new AbortController and register it
  const abortController = new AbortController();
  runningTasks.set(tabId, abortController);
  const signal = abortController.signal;

  // 初始化任务状态
  try {
    await TaskStore.init(tabId);
  } catch (e) {
    console.log(`[墨问 Background] ⚠️ 无法初始化 TaskStore for tab ${tabId}`);
  }

  // Defensive check for extractResult
  if (!extractResult) {
    console.error('[墨问 Background] ❌ extractResult is undefined/null');
    return { success: false, error: 'extractResult is undefined', errorCode: 'INVALID_PAYLOAD' };
  }

  if (!extractResult.contentHtml) {
    console.error('[墨问 Background] ❌ extractResult.contentHtml is empty');
    return { success: false, error: '页面内容为空', errorCode: 'EMPTY_CONTENT' };
  }

  if (!settings.apiKey) {
    console.error('[墨问 Background] ❌ No API key configured');
    return { success: false, error: 'API Key 未配置', errorCode: 'UNAUTHORIZED' };
  }

  try {
    // Step 1: Process images (if enabled)
    let processedContent = extractResult.contentHtml;
    let imageResults: ImageProcessResult[] = [];
    const images = extractResult.images || [];

    if (includeImages && images.length > 0) {
      console.log(`[墨问 Background] 🖼️ Found ${images.length} images, processing...`);
      logToContentScript(`🖼️ Found ${images.length} images, processing...`, tabId);
      const imagesToProcess = images.slice(0, maxImages);

      // Upload images with concurrency control
      imageResults = await processImages(settings.apiKey, imagesToProcess, tabId, signal);

      // Replace image URLs in content (for images that exist in contentHtml)
      processedContent = replaceImageUrls(processedContent, imageResults, []);

      // Inject uploaded images that weren't matched (e.g., when contentHtml doesn't have img tags)
      processedContent = injectUploadedImages(processedContent, imageResults);

      // Debug: Log processed content to verify img tags have data-mowen-uid
      const imgTagsWithUid = processedContent.match(/<img[^>]*data-mowen-uid[^>]*>/gi);
      logToContentScript(`🔍 处理后的图片标签数: ${imgTagsWithUid?.length || 0}`, tabId);
    } else if (images.length > 0) {
      // 包含图片开关关闭：移除所有 img 标签（不转换为链接）
      processedContent = removeAllImageTags(processedContent);
      console.log(`[墨问 Background] 🚫 包含图片已关闭，移除 ${images.length} 张图片`);
    }

    // Step 3: Split content if needed
    if (signal.aborted) {
      console.log('[墨问 Background] ⚠️ Cancel requested, aborting note creation');
      return { success: false, error: '已取消保存', errorCode: 'CANCELLED' };
    }

    const parts = splitContent(
      extractResult.title,
      processedContent,
      SAFE_LIMIT
    );

    // Step 4: Create notes
    console.log(`[note] create start title="${extractResult.title.substring(0, 30)}..." partsCount=${parts.length}`);
    logToContentScript(`创建 ${parts.length} 篇笔记...`, tabId);
    const createdNotes: Array<{ partIndex: number; noteUrl: string; noteId: string; shareUrl?: string; isIndex?: boolean }> = [];

    for (const part of parts) {
      if (signal.aborted) {
        console.log('[墨问 Background] ⚠️ Cancel requested, stopping note creation loop');
        break;
      }

      // Send progress update
      try {
        sendProgressUpdate({
          type: 'creating_note',
          currentPart: part.index + 1,
          totalParts: parts.length,
        }, tabId);
      } catch (err) { /* ignore */ }

      let result: NoteCreateResult = { success: false, error: 'Not executed', errorCode: 'UNKNOWN' };
      let retryCount = 0;
      let success = false;

      // Retry loop
      while (retryCount < MAX_RETRY_ROUNDS) {
        if (signal.aborted) break;

        retryCount++;
        console.log(`[note] part ${part.index + 1}/${parts.length} attempt ${retryCount}`);
        logToContentScript(`📝 正在创建第 ${part.index + 1}/${parts.length} 部分 (第 ${retryCount} 次尝试)...`, tabId);

        try {
          // Pass logToContentScript to createNote so internal logs are visible to user
          // Wrap in GlobalRateLimiter to enforce 1 QPS
          result = await GlobalRateLimiter.schedule(async () => {
            // Create async wrapper for logToContentScript that matches expected signature
            const logWrapper = async (msg: string) => { logToContentScript(msg, tabId); };
            return await createNote(settings.apiKey, part.title, part.content, isPublic, logWrapper, extractResult.sourceUrl, enableAutoTag);
          });
        } catch (apiErr) {
          const errMsg = apiErr instanceof Error ? apiErr.message : 'Exception';
          console.log(`[note] part ${part.index + 1} exception: ${errMsg}`);
          logToContentScript(`❌ 创建异常: ${errMsg}`, tabId);
          result = {
            success: false,
            error: errMsg,
            errorCode: 'EXCEPTION'
          };
        }

        if (result.success) {
          success = true;
          // markNoteApiCall(); // Removed: Handled by RateLimiter
          console.log(`[note] create ok noteId=${result.noteId} url=${result.noteUrl}`);
          logToContentScript(`✅ 第 ${part.index + 1} 部分创建成功: ${result.noteUrl}`, tabId);
          createdNotes.push({
            partIndex: part.index,
            noteUrl: result.noteUrl!,
            noteId: result.noteId!,
            shareUrl: result.shareUrl!,  // For collection links
          });
          break; // Success, exit retry loop
        } else {
          console.log(`[note] part ${part.index + 1} fail: ${result.error} code=${result.errorCode}`);
          logToContentScript(`⚠️ 第 ${part.index + 1} 部分失败: ${result.error}`, tabId);
          // If content too long, logic for splitting further would go here
          // Simplified: just wait and retry
          if (retryCount < MAX_RETRY_ROUNDS) {
            logToContentScript(`⏳ 等待 ${(1000 * retryCount) / 1000} 秒后重试...`, tabId);
            await sleep(1000 * retryCount);
          }
        }
      }

      if (!success) {
        console.error(`[note] part ${part.index + 1} FAILED after ${MAX_RETRY_ROUNDS} retries`);
        logToContentScript(`❌ 第 ${part.index + 1} 部分在重试后仍然失败，放弃。`, tabId);
      }
    }

    // Step 5: Create index note if multiple parts and enabled
    console.log(`[墨问 Background] 🔍 合集创建条件检查: createIndexNote=${createIndexNote}, parts.length=${parts.length}, createdNotes.length=${createdNotes.length}`);
    logToContentScript(`🔍 合集检查: 开关=${createIndexNote}, 分块=${parts.length}, 成功=${createdNotes.length}`, tabId);

    if (createIndexNote && parts.length > 1 && createdNotes.length > 1 && !signal.aborted) {
      console.log('[墨问 Background] Creating index note with internal links...');
      logToContentScript('📚 正在创建合集笔记（内链格式）...', tabId);

      // 使用内链笔记格式构建合集 body
      const indexBody = createIndexNoteAtom(
        extractResult.title,
        extractResult.sourceUrl,
        createdNotes
      );

      const indexResult = await GlobalRateLimiter.schedule(async () => {
        return await createNoteWithBody(
          settings.apiKey,
          indexBody,
          isPublic,
          enableAutoTag
        );
      });

      if (indexResult.success) {
        createdNotes.unshift({
          partIndex: -1,
          noteUrl: indexResult.noteUrl!,
          noteId: indexResult.noteId!,
          isIndex: true,
        });
        logToContentScript('✅ 合集笔记创建成功', tabId);
      } else {
        // 合集创建失败不阻断整体流程，但要记录错误
        console.error('[墨问 Background] ❌ 合集笔记创建失败:', indexResult.error);
        logToContentScript(`⚠️ 合集笔记创建失败: ${indexResult.error || '未知错误'}`, tabId);
      }
    }

    console.log('[墨问 Background] 📊 Final note count:', createdNotes.length);

    // Clean up task from map if finished
    runningTasks.delete(tabId);

    if (createdNotes.length === 0) {
      console.error('[墨问 Background] ❌ No notes were created');
      return { success: false, error: '创建笔记失败', errorCode: 'UNKNOWN' };
    }

    console.log('[墨问 Background] ✅ Save process completed successfully!');
    console.log('[墨问 Background] 📋 Created notes:', createdNotes.map(n => ({
      partIndex: n.partIndex,
      noteUrl: n.noteUrl,
      isIndex: n.isIndex,
    })));

    const result = {
      success: true,
      notes: createdNotes.map((n) => ({
        partIndex: n.partIndex,
        noteUrl: n.noteUrl,
        isIndex: n.isIndex,
      })),
    };

    if (tabId) {
      await TaskStore.complete(tabId, result);
    }

    return result;
  } catch (error) {
    // Also clean up on error
    runningTasks.delete(tabId);
    console.error('[墨问 Background] ❌ Save process failed with exception:', error);
    const errorResult = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    if (tabId) {
      await TaskStore.complete(tabId, errorResult);
    }

    return errorResult;
  }
}

/**
 * Send progress update to popup (if it's still open)
 */
function sendProgressUpdate(progress: {
  type: 'uploading_images' | 'creating_note';
  uploadedImages?: number;
  totalImages?: number;
  currentPart?: number;
  totalParts?: number;
}, tabId: number) {
  chrome.runtime.sendMessage({
    type: 'SAVE_NOTE_PROGRESS',
    progress,
  }).catch(() => {
    // Popup might be closed, ignore error
  });

  // 更新持久化状态
  if (tabId) {
    TaskStore.updateProgress(tabId, {
      ...progress,
      status: progress.type === 'uploading_images' ? 'uploading_images' : 'creating_note',
    }).catch(e => console.error('Failed to persist progress:', e));
  }
}

/**
 * Fetch image blob from Content Script
 * This allows us to get the image data with the page's credentials/cookies
 */
async function fetchImageBlobFromCS(imageUrl: string, tabId: number): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    if (!tabId) {
      console.log(`[img] fetchBlob: no active tab`);
      return null;
    }

    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'FETCH_IMAGE', payload: { url: imageUrl } }),
      new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Timeout' }), 10000)
      ),
    ]) as { success: boolean; data?: { base64: string; mimeType: string }; error?: string };

    if (!response?.success || !response.data) {
      console.log(`[img] fetchBlob fail: ${response?.error || 'no data'}`);
      return null;
    }

    // Convert base64 to Blob
    const base64 = response.data.base64;
    const mimeType = response.data.mimeType || 'image/jpeg';

    // Handle data URL format
    let pureBase64 = base64;
    if (base64.startsWith('data:')) {
      const commaIdx = base64.indexOf(',');
      if (commaIdx > 0) pureBase64 = base64.substring(commaIdx + 1);
    }

    const binaryString = atob(pureBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });

    console.log(`[img] fetchBlob ok size=${blob.size} mime=${mimeType}`);
    return { blob, mimeType };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[img] fetchBlob exception: ${errMsg}`);
    return null;
  }
}

// Image processing functions - Pipelined: Concurrent Fetch + Serial Upload (Respects 1 QPS)
async function processImages(
  apiKey: string,
  images: ImageCandidate[],
  tabId: number,
  signal: AbortSignal
): Promise<ImageProcessResult[]> {
  console.log(`[img] ========== START PROCESSING ${images.length} IMAGES (Pipeline) ==========`);
  logToContentScript(`🖼️ 开始处理 ${images.length} 张图片 (流水线模式)...`, tabId);

  const totalImages = images.length;
  // Initialize results array
  const results: ImageProcessResult[] = new Array(totalImages);

  sendProgressUpdate({
    type: 'uploading_images',
    uploadedImages: 0,
    totalImages,
  }, tabId);

  // 1. Fetch Queue: Concurrently fetch image blobs from Content Script
  // We limit fetch concurrency to avoid overwhelming the browser/content script
  const FETCH_CONCURRENCY = 3;

  // Helper to process fetch with concurrency limit
  const fetchResults: ({ blob: Blob; mimeType: string } | null)[] = new Array(totalImages);
  let fetchCursor = 0;

  // Function to grab the next image and fetch it
  const fetchNext = async () => {
    if (signal.aborted) return;

    // Atomically grab an index
    const index = fetchCursor++;
    if (index >= totalImages) return;

    const image = images[index];
    const imageIndex = index + 1;

    try {
      // Logic from processImage's fetchBlobFn extracted here
      const fetchBlobFn = async (): Promise<{ blob: Blob; mimeType: string } | null> => {
        // Try normalized URL first
        const res = await fetchImageBlobFromCS(image.normalizedUrl, tabId);
        if (res) return res;
        // Fallback
        if (image.normalizedUrl !== image.url) {
          return fetchImageBlobFromCS(image.url, tabId);
        }
        return null;
      };

      const data = await fetchBlobFn();
      fetchResults[index] = data; // Store result
    } catch (e) {
      console.error(`[img] Fetch blob ${imageIndex} error:`, e);
      fetchResults[index] = null;
    }

    // Chain next
    await fetchNext();
  };

  // Start initial fetch workers
  const fetchPromises: Promise<void>[] = [];
  for (let i = 0; i < Math.min(FETCH_CONCURRENCY, totalImages); i++) {
    fetchPromises.push(fetchNext());
  }

  // 2. Upload Loop: Strictly Serial & Rate Limited via GlobalRateLimiter
  for (let i = 0; i < totalImages; i++) {
    if (signal.aborted) {
      console.log('[img] ⚠️ Cancel requested, stopping uploads');
      logToContentScript('⚠️ 用户取消，停止图片上传', tabId);
      break;
    }

    const image = images[i];
    const imageIndex = i + 1;

    // Poll/wait for fetchResults[i] to be ready
    // Fix: Remove fetchCursor <= i check which caused premature exit
    while (fetchResults[i] === undefined && !signal.aborted) {
      await new Promise(r => setTimeout(r, 50));
    }

    logToContentScript(`🖼️ 上传图片 ${imageIndex}/${totalImages}...`, tabId);

    try {
      const blobData = fetchResults[i] || null;
      // Construct a fake "fetchBlobFn" that returns the already-fetched data
      const preFetchedFn = async () => blobData;

      // Schedule upload through GlobalRateLimiter
      // This ensures global 1 QPS limit across all tabs
      // console.log(`[img] Scheduling upload for image ${imageIndex}`);
      const result = await GlobalRateLimiter.schedule(async () => {
        return await processImageWithBlob(apiKey, image, preFetchedFn);
      });

      results[i] = result;

      if (result.success) {
        logToContentScript(`✅ [${imageIndex}/${totalImages}] 上传成功`, tabId);
      } else {
        logToContentScript(`❌ [${imageIndex}/${totalImages}] 上传失败: ${result.failureReason}`, tabId);
      }
    } catch (err) {
      console.error(`[img] Upload ${imageIndex} exception:`, err);
      results[i] = {
        id: image.id,
        originalUrl: image.url,
        success: false,
        failureReason: 'UNKNOWN',
      };
    }

    // Update progress
    sendProgressUpdate({
      type: 'uploading_images',
      uploadedImages: imageIndex,
      totalImages,
    }, tabId);
  }

  // Ensure all fetches settle (cleanup)
  await Promise.all(fetchPromises);

  // Summary logging
  const finalResults = results.filter(r => r !== undefined);
  const successCount = finalResults.filter(r => r.success).length;
  const failCount = finalResults.filter(r => !r.success).length;
  console.log(`[img] ========== DONE: success=${successCount} failed=${failCount} ==========`);
  logToContentScript(`🖼️ 图片处理完成: 成功=${successCount}, 失败=${failCount}`, tabId);

  return finalResults;
}

// Extracted helper for pipelined processing
async function processImageWithBlob(
  apiKey: string,
  image: ImageCandidate,
  fetchBlobFn: () => Promise<{ blob: Blob; mimeType: string } | null>
): Promise<ImageProcessResult> {
  const imageIndex = image.order + 1;
  // Use constant from LIMITS
  const timeoutMs = IMAGE_TIMEOUT;

  try {
    let result: ImageUploadResult;
    try {
      result = await Promise.race([
        uploadImageWithFallback(apiKey, image.normalizedUrl, imageIndex, fetchBlobFn),
        new Promise<ImageUploadResult>((resolve) =>
          setTimeout(() => resolve({
            success: false,
            uploadMethod: 'degraded',
            degradeReason: 'timeout',
          }), timeoutMs)
        ),
      ]);
    } catch (raceError) {
      console.log(`[img] idx=${imageIndex} race error:`, raceError);
      return {
        id: image.id,
        originalUrl: image.url,
        success: false,
        failureReason: 'TIMEOUT_OR_NET',
      };
    }

    if (result.success && result.uuid) {
      console.log(`[img] idx=${imageIndex} ok method=${result.uploadMethod} uuid=${result.uuid}`);
      return {
        id: image.id,
        originalUrl: image.url,
        success: true,
        assetUrl: result.url,
        fileId: result.fileId,
        uid: result.uuid,
      };
    }

    // Map reasons
    let failureReason: ImageFailureReason = 'UNKNOWN';
    if (result.degradeReason) {
      if (result.degradeReason.includes('timeout')) failureReason = 'TIMEOUT_OR_NET';
      else if (result.degradeReason.includes('size')) failureReason = 'UNKNOWN';
      else if (result.degradeReason.includes('blob')) failureReason = 'CORS_OR_BLOCKED';
    }

    console.log(`[img] idx=${imageIndex} fail reason=${result.degradeReason || 'unknown'}`);
    return {
      id: image.id,
      originalUrl: image.url,
      success: false,
      failureReason,
    };

  } catch (error) {
    console.log(`[img] idx=${imageIndex} exception:`, error);
    return {
      id: image.id,
      originalUrl: image.url,
      success: false,
      failureReason: 'UNKNOWN',
    };
  }
}

// Wrapper for backward compatibility (not used mostly, but kept for signature)
export async function processImage(
  apiKey: string,
  image: ImageCandidate
): Promise<ImageProcessResult> {
  // Legacy support without tabId - will fail fetching blob if cross-origin
  console.warn('Deprecated processImage called without tabId');
  return processImageWithBlob(apiKey, image, async () => null);
}

function replaceImageUrls(
  content: string,
  imageResults: ImageProcessResult[],
  _extraImages: ImageCandidate[]
): string {
  let processed = content;
  let successCount = 0;
  let failCount = 0;

  console.log(`[sw] replaceImageUrls: processing ${imageResults.length} results`);

  // Replace successfully uploaded images
  for (let i = 0; i < imageResults.length; i++) {
    const result = imageResults[i];

    // Log result
    console.log(`[sw] replaceImageUrls: result for ${result.originalUrl.substring(0, 50)}...`, {
      success: result.success,
      assetUrl: result.assetUrl?.substring(0, 50),
      fileId: result.fileId,
      uid: result.uid,
    });

    if (result.success && result.assetUrl && result.uid) {
      successCount++;

      // Strategy: Find img tags that contain the original URL and inject data-mowen-uid attribute
      // We try multiple matching strategies to handle various URL formats

      const originalUrl = result.originalUrl;
      let matched = false;

      // Strategy 0: For WeChat images, use the unique path segment as identifier
      // WeChat URLs: https://mmbiz.qpic.cn/mmbiz_jpg/UNIQUE_ID/640?wx_fmt=jpeg
      // The UNIQUE_ID is the key identifier that's consistent across src and data-src
      if (originalUrl.includes('mmbiz.qpic.cn') || originalUrl.includes('mmbiz.qlogo.cn')) {
        try {
          const urlObj = new URL(originalUrl);
          const pathParts = urlObj.pathname.split('/').filter(p => p.length > 10);
          if (pathParts.length > 0) {
            // Use the longest path segment as identifier (usually the unique ID)
            const uniqueId = pathParts.reduce((a, b) => a.length > b.length ? a : b);
            const escapedId = escapeRegExp(uniqueId);
            const weixinRegex = new RegExp(`(<img[^>]*(?:src|data-src|data-original)=["'][^"']*${escapedId}[^"']*["'][^>]*)>`, 'gi');

            if (weixinRegex.test(processed)) {
              weixinRegex.lastIndex = 0;
              processed = processed.replace(weixinRegex, (match, imgTagContent) => {
                if (imgTagContent.includes('data-mowen-uid')) {
                  return match;
                }
                console.log(`[sw] replaceImageUrls: WeChat ID match (${uniqueId.substring(0, 20)}...), injecting uid=${result.uid}`);
                matched = true;
                return `${imgTagContent} data-mowen-uid="${result.uid}">`;
              });
            }
          }
        } catch (e) {
          // URL parsing failed, continue to other strategies
        }
      }

      // Strategy 1: Try exact URL match first
      if (!matched) {
        const exactUrlEscaped = escapeRegExp(originalUrl);
        const exactRegex = new RegExp(`(<img[^>]*(?:src|data-src|data-original)=["']${exactUrlEscaped}["'][^>]*)>`, 'gi');

        if (exactRegex.test(processed)) {
          exactRegex.lastIndex = 0; // Reset regex state
          processed = processed.replace(exactRegex, (match, imgTagContent) => {
            if (imgTagContent.includes('data-mowen-uid')) {
              return match;
            }
            console.log(`[sw] replaceImageUrls: exact match, injecting uid=${result.uid}`);
            matched = true;
            return `${imgTagContent} data-mowen-uid="${result.uid}">`;
          });
        }
      }

      // Strategy 2: Try URL without query params
      if (!matched) {
        const urlParts = originalUrl.split('?');
        const baseUrl = urlParts[0];
        const baseUrlEscaped = escapeRegExp(baseUrl);
        const baseUrlRegex = new RegExp(`(<img[^>]*(?:src|data-src|data-original)=["'][^"']*${baseUrlEscaped}[^"']*["'][^>]*)>`, 'gi');

        if (baseUrlRegex.test(processed)) {
          baseUrlRegex.lastIndex = 0;
          processed = processed.replace(baseUrlRegex, (match, imgTagContent) => {
            if (imgTagContent.includes('data-mowen-uid')) {
              return match;
            }
            console.log(`[sw] replaceImageUrls: base URL match, injecting uid=${result.uid}`);
            matched = true;
            return `${imgTagContent} data-mowen-uid="${result.uid}">`;
          });
        }
      }

      // Strategy 3: Try matching by URL identifier (last 50 chars, removing width suffix)
      if (!matched) {
        const urlParts = originalUrl.split('?');
        const baseUrl = urlParts[0];
        const urlWithoutWidthSuffix = baseUrl.replace(/\/\d{1,4}$/, '');
        const urlIdentifier = urlWithoutWidthSuffix.slice(-50);
        const escapedIdentifier = escapeRegExp(urlIdentifier);
        const identifierRegex = new RegExp(`(<img[^>]*(?:src|data-src|data-original)=["'][^"']*${escapedIdentifier}[^"']*["'][^>]*)>`, 'gi');

        if (identifierRegex.test(processed)) {
          identifierRegex.lastIndex = 0;
          processed = processed.replace(identifierRegex, (match, imgTagContent) => {
            if (imgTagContent.includes('data-mowen-uid')) {
              return match;
            }
            console.log(`[sw] replaceImageUrls: identifier match, injecting uid=${result.uid}`);
            matched = true;
            return `${imgTagContent} data-mowen-uid="${result.uid}">`;
          });
        }
      }

      // Strategy 4: Try matching by filename (last segment of path)
      if (!matched) {
        try {
          const urlObj = new URL(originalUrl);
          const pathname = urlObj.pathname;
          const filename = pathname.split('/').pop();
          if (filename && filename.length > 5) {
            const filenameEscaped = escapeRegExp(filename);
            const filenameRegex = new RegExp(`(<img[^>]*(?:src|data-src|data-original)=["'][^"']*${filenameEscaped}[^"']*["'][^>]*)>`, 'gi');

            if (filenameRegex.test(processed)) {
              filenameRegex.lastIndex = 0;
              processed = processed.replace(filenameRegex, (match, imgTagContent) => {
                if (imgTagContent.includes('data-mowen-uid')) {
                  return match;
                }
                console.log(`[sw] replaceImageUrls: filename match, injecting uid=${result.uid}`);
                matched = true;
                return `${imgTagContent} data-mowen-uid="${result.uid}">`;
              });
            }
          }
        } catch (e) {
          // URL parsing failed, skip this strategy
        }
      }

      // Strategy 5: Medium/CDN specific - match by unique image ID in path
      // Medium URLs like: https://miro.medium.com/v2/resize:fit:1400/1*ZIcUbGyIASJ3iXrD5oTeoA.jpeg
      // After normalization: https://miro.medium.com/v2/1*ZIcUbGyIASJ3iXrD5oTeoA.jpeg
      // We need to extract the image ID (1*...) and match it in the HTML
      if (!matched && originalUrl.includes('miro.medium.com')) {
        try {
          const urlObj = new URL(originalUrl);
          const pathname = urlObj.pathname;
          // Extract the image ID: usually looks like "1*XXXX" or just a hash
          const imageIdMatch = pathname.match(/(\d\*[A-Za-z0-9_-]+)/);
          if (imageIdMatch && imageIdMatch[1]) {
            const imageId = imageIdMatch[1];
            const escapedId = escapeRegExp(imageId);
            // Match any img src containing this image ID
            const mediumRegex = new RegExp(`(<img[^>]*(?:src|data-src|srcset)=["'][^"']*${escapedId}[^"']*["'][^>]*)>`, 'gi');

            if (mediumRegex.test(processed)) {
              mediumRegex.lastIndex = 0;
              processed = processed.replace(mediumRegex, (match, imgTagContent) => {
                if (imgTagContent.includes('data-mowen-uid')) {
                  return match;
                }
                console.log(`[sw] replaceImageUrls: Medium ID match, injecting uid=${result.uid}`);
                matched = true;
                return `${imgTagContent} data-mowen-uid="${result.uid}">`;
              });
            }
          }
        } catch (e) {
          // Ignore
        }
      }
    } else {
      failCount++;
    }
  }

  // Handle remaining images that should be linked but not processed (if any)
  // Currently we only process up to maxImages. The rest are untouched or handled below if we want to convert them to links.
  // The logic for converting extra images to links is currently not fully implemented in replaceImageUrls
  // It handles imageResults (processed images). extraImages passed in are just candidates.

  console.log(`[sw] replaceImageUrls: done replacements. Success: ${successCount}, Fail: ${failCount}`);
  return processed;
}

function injectUploadedImages(
  content: string,
  imageResults: ImageProcessResult[]
): string {
  const processed = content;
  // Check if content already has all uploaded images
  // Logic: Iterate results, if result.success and we can't find its uid in processed, append it
  // This is a safety net for images that were extracted but not found in the final HTML (e.g. background images or removed by cleanup)
  // For now, we only log missing ones to avoid cluttering the note with duplicate images if regex failed

  const missingImages = imageResults.filter(r => r.success && r.uid && !processed.includes(r.uid));

  if (missingImages.length > 0) {
    console.log(`[sw] injectUploadedImages: found ${missingImages.length} uploaded images not matched in content`);
    // Optional: Append them to bottom? Or just ignore?
    // Current decision: Ignore to avoid duplicates, as regex matching is the primary way
  }

  return processed;
}

function removeAllImageTags(content: string): string {
  // Replace all img tags with empty string
  return content.replace(/<img[^>]*>/gi, '');
}

// function createMetaHeader removed


function splitContent(title: string, content: string, limit: number): NotePart[] {
  // 辅助函数：移除 HTML 标签获取纯文本长度
  const getTextLength = (html: string) => html.replace(/<[^>]*>/g, '').length;

  const textLength = getTextLength(content);

  // 使用纯文本长度判断，而非 HTML 长度
  if (textLength <= limit) {
    return [{
      index: 0,
      title: title,
      content: content,
      total: 1
    }];
  }

  // If content is too long, we need to split it
  // Logic: Split by headers (h1, h2, h3) or paragraphs, trying to keep chunks under limit
  console.log(`[bg] Text length ${textLength} > ${limit}, splitting...`);

  const parts: NotePart[] = [];
  let currentPartContent = '';
  let currentPartTextLength = 0; // 追踪当前分块的纯文本长度
  let partIndex = 0;

  // Use a simple regex to split by logical blocks
  // Split by closing tags of block elements to keep HTML structure integrity
  // Note: This is a simplistic splitter and might break complex HTML. 
  // Ideally we should use a DOM parser but we are in SW/Background.
  const blocks = content.split(/(<\/p>|<\/div>|<\/h[1-6]>|<\/blockquote>|<\/ul>|<\/ol>|<\/table>)/i);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockTextLength = getTextLength(block);

    // 使用纯文本长度判断是否需要分割
    if ((currentPartTextLength + blockTextLength) > limit && currentPartContent.length > 0) {
      // Current part full, push it and start new
      parts.push({
        index: partIndex,
        title: partIndex === 0 ? title : `${title} (${partIndex + 1})`,
        content: currentPartContent,
        total: 0 // Will update later
      });
      partIndex++;
      currentPartContent = block;
      currentPartTextLength = blockTextLength;
    } else {
      currentPartContent += block;
      currentPartTextLength += blockTextLength;
    }
  }

  // Push remaining content
  if (currentPartContent.length > 0) {
    parts.push({
      index: partIndex,
      title: partIndex === 0 ? title : `${title} (${partIndex + 1})`,
      content: currentPartContent,
      total: 0 // Will update later
    });
  }

  // Update total count
  const total = parts.length;
  parts.forEach(p => p.total = total);

  return parts;
}


/**
 * 创建合集笔记的 NoteAtom body（使用内链笔记格式）
 * 
 * 格式：
 * - 标题：{title}（合集）
 * - 来源引用块
 * - 说明段落
 * - 每个子笔记作为独立的内链笔记 block（type: 'note'）
 */
function createIndexNoteAtom(
  title: string,
  sourceUrl: string,
  notes: Array<{ partIndex: number; noteUrl: string; noteId: string }>
): Record<string, unknown> {
  // 按 partIndex 排序
  const sortedNotes = [...notes].sort((a, b) => a.partIndex - b.partIndex);

  // 构建 NoteAtom body
  const content: Record<string, unknown>[] = [
    // 1. 标题
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `${title}（合集）`,
          marks: [{ type: 'bold' }]
        }
      ]
    },
    // 空行
    { type: 'paragraph' },
    // 2. 来源引用块
    {
      type: 'quote',
      content: [
        { type: 'text', text: '📄 来源：' },
        {
          type: 'text',
          text: sourceUrl,
          marks: [{ type: 'link', attrs: { href: sourceUrl } }]
        }
      ]
    },
    // 空行
    { type: 'paragraph' },
    // 3. 说明段落
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `由于文章过长，已自动拆分为 ${sortedNotes.length} 个部分：`
        }
      ]
    },
    // 空行
    { type: 'paragraph' },
    // 4. 每个子笔记作为内链笔记 block
    ...sortedNotes.map(note => ({
      type: 'note',
      attrs: {
        uuid: note.noteId
      }
    }))
  ];

  return {
    type: 'doc',
    content
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');
}
