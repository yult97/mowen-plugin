console.log('[墨问 Background] 🏁 Service Worker Script Loaded');
import {
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NoteCreateResult,
  ImageFailureReason,
  SaveProgress,
  SaveHighlightPayload,
  HighlightSaveResult,
  Highlight,
} from '../types';
import { getSettings, saveSettings } from '../utils/storage';
import { sleep, isValidPageTitle, extractTitleFromText, formatErrorForLog } from '../utils/helpers';

import { createNote, createNoteWithBody, buildNoteBody, uploadImageWithFallback, ImageUploadResult, editNote } from '../services/api';
import { LIMITS, backgroundLogger as logger } from '../utils/constants';
import { TaskStore } from '../utils/taskStore';
import { GlobalRateLimiter } from '../utils/rateLimiter';
import { htmlToNoteAtom } from '../utils/noteAtom';

const SAFE_LIMIT = LIMITS.SAFE_CONTENT_LENGTH;
const MAX_RETRY_ROUNDS = LIMITS.MAX_RETRY_ROUNDS;
const IMAGE_TIMEOUT = LIMITS.IMAGE_UPLOAD_TIMEOUT;
const EXTENSION_PAGE_PREFIX = chrome.runtime.getURL('');
const MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MOWEN_WEB_API_PATHS = new Set([
  '/api/note/entry/v1/note/workbench',
  '/api/note/entry/v1/note/tops',
  '/api/note/wxa/v1/note/show',
  '/api/note/wxa/v1/gallery/infos',
  '/api/note/entry/v1/note/ref/infos',
]);

interface SaveTaskRuntimeMessage {
  type: 'SAVE_NOTE_PROGRESS' | 'SAVE_NOTE_COMPLETE' | 'SAVE_NOTE_PAUSED' | 'SAVE_NOTE_RESUMED';
  tabId: number;
  taskId: string;
}

interface SaveTaskCompleteMessage extends SaveTaskRuntimeMessage {
  type: 'SAVE_NOTE_COMPLETE';
  result: NoteCreateResult;
}

interface SaveTaskProgressMessage extends SaveTaskRuntimeMessage {
  type: 'SAVE_NOTE_PROGRESS';
  progress: {
    type: 'uploading_images' | 'creating_note';
    uploadedImages?: number;
    totalImages?: number;
    currentPart?: number;
    totalParts?: number;
  };
}

interface SaveTaskPausedMessage extends SaveTaskRuntimeMessage {
  type: 'SAVE_NOTE_PAUSED';
}

interface SaveTaskResumedMessage extends SaveTaskRuntimeMessage {
  type: 'SAVE_NOTE_RESUMED';
}

type RunningTaskStatus = 'running' | 'pause_requested' | 'paused' | 'cancelling';

interface RunningSaveTask {
  taskId: string;
  controller: AbortController;
  status: RunningTaskStatus;
  waiters: Array<() => void>;
}

interface NoteAtomMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface NoteAtomNode {
  type: string;
  text?: string;
  marks?: NoteAtomMark[];
  content?: NoteAtomNode[];
  attrs?: Record<string, unknown>;
}

interface NoteAtomDoc {
  type: string;
  content?: NoteAtomNode[];
}

interface NoteSplitPart {
  index: number;
  total: number;
  title: string;
  content?: string;
  body?: NoteAtomDoc;
  isIndex?: boolean;
}

const NON_RETRIABLE_CREATE_ERROR_CODES = new Set([
  'PERMISSION_DENIED',
  'AMBIGUOUS_CREATE',
  'CANCELLED',
]);

function shouldRetryCreateFailure(result: NoteCreateResult): boolean {
  if (!result.errorCode) {
    return true;
  }

  return !NON_RETRIABLE_CREATE_ERROR_CODES.has(result.errorCode);
}

// Running Tasks Map: tabId -> task context
const runningTasks = new Map<number, RunningSaveTask>();

function notifyTaskWaiters(task: RunningSaveTask): void {
  const pendingWaiters = task.waiters.splice(0);
  for (const resolve of pendingWaiters) {
    resolve();
  }
}

function getRunningTask(tabId: number, taskId: string): RunningSaveTask | null {
  const task = runningTasks.get(tabId);
  if (!task || task.taskId !== taskId) {
    return null;
  }

  return task;
}

async function waitForTaskRunnable(tabId: number, taskId: string, progress?: SaveProgress): Promise<'running' | 'cancelled'> {
  while (true) {
    const task = getRunningTask(tabId, taskId);
    if (!task) {
      return 'cancelled';
    }

    if (task.status === 'cancelling' || task.controller.signal.aborted) {
      return 'cancelled';
    }

    if (task.status === 'pause_requested') {
      task.status = 'paused';
      await TaskStore.setPaused(tabId, taskId, progress);
      chrome.runtime.sendMessage({
        type: 'SAVE_NOTE_PAUSED',
        tabId,
        taskId,
      } as SaveTaskPausedMessage).catch(() => { });
    }

    if (task.status === 'paused') {
      await new Promise<void>((resolve) => {
        const latestTask = getRunningTask(tabId, taskId);
        if (!latestTask || latestTask.status !== 'paused') {
          resolve();
          return;
        }
        latestTask.waiters.push(resolve);
      });
      continue;
    }

    return 'running';
  }
}

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_PAGE_PREFIX);
}

function isAllowedMowenWebApiPath(path: string): boolean {
  return ALLOWED_MOWEN_WEB_API_PATHS.has(path);
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;

  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;

  const private172 = normalized.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function isAllowedImageProxyUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    return !isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldIncludeImageProxyCredentials(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return /(^|\.)mowen\.cn$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

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
  .catch((error) => console.error(`[墨问 Background] Failed to set side panel behavior: ${formatErrorForLog(error)}`));

// 2. 默认在全局禁用 Side Panel（仅在特定 tab 启用）
chrome.sidePanel.setOptions({ enabled: false })
  .catch((error) => console.error(`[墨问 Background] Failed to set global side panel options: ${formatErrorForLog(error)}`));

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
      console.error(`[墨问 Background] Failed to open side panel: ${formatErrorForLog(error)}`);
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

    const pageUrl = info.pageUrl || tab.url || '';
    const pageTitle = tab.title || 'Unknown';

    // 构造划线数据
    const highlight: Highlight = {
      id: `ctx-${Date.now()}`,
      text: info.selectionText,
      sourceUrl: pageUrl,
      pageTitle: pageTitle,
      createdAt: new Date().toISOString(),
    };

    // 获取设置
    const settings = await getSettings();

    // 查询已有笔记缓存（与 HighlightManager 保持一致的逻辑）
    // 生成缓存 Key：使用 origin + pathname，忽略 hash 和 query
    const getPageKey = (url: string): string => {
      try {
        const urlObj = new URL(url);
        return `${urlObj.origin}${urlObj.pathname}`;
      } catch {
        return url;
      }
    };
    const pageKey = getPageKey(pageUrl);
    const cacheKey = `highlight_note_${pageKey}`;

    let existingNoteId: string | undefined;
    let existingBody: Record<string, unknown> | undefined;

    try {
      const cached = await chrome.storage.local.get([cacheKey]);
      const existingCache = cached[cacheKey] as {
        noteId?: string;
        body?: Record<string, unknown>;
        expiresAt?: string;
      } | undefined;

      if (existingCache?.noteId) {
        // 缓存过期检查（24小时）
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

    // 保存划线（包含缓存信息以支持追加）
    const payload: SaveHighlightPayload = {
      highlight,
      isPublic: settings.defaultPublic,
      enableAutoTag: settings.enableAutoTag,
      existingNoteId,
      existingBody,
    };

    try {
      const result = await handleSaveHighlight(payload);

      // 更新缓存（如果保存成功）
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
      console.error(`[墨问 Background] Context menu save failed: ${formatErrorForLog(error)}`);
    }
  }
});


interface SaveNotePayload {
  extractResult: ExtractResult;
  isPublic: boolean;
  includeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  taskId: string;
  enableAutoTag?: boolean;  // 是否自动添加「墨问剪藏」标签
  tabId?: number; // Optional, can be injected by sender
}

// Helper to proxy logs to Content Script
function logToContentScript(msg: string, tabId?: number): void {
  void msg;
  void tabId;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.log('Received message:', message.type);

  if (message.type === 'PING') {
    logger.log('🏓 PING received');
    sendResponse({ success: true, status: 'pong' });
    return false;
  }

  if (message.type === 'CANCEL_SAVE') {
    const tabId = message.payload?.tabId;
    const taskId = message.payload?.taskId;
    console.log(`[墨问 Background] ❌ CANCEL_SAVE received for tab ${tabId}, task ${taskId}`);

    if (!tabId || !taskId) {
      sendResponse({ success: false, error: 'INVALID_CANCEL_PAYLOAD' });
      return false;
    }

    const runningTask = runningTasks.get(tabId);
    if (runningTask && runningTask.taskId === taskId) {
      runningTask.status = 'cancelling';
      runningTask.controller.abort();
      notifyTaskWaiters(runningTask);
      console.log(`[墨问 Background] 🛑 Task for tab ${tabId} aborted`);
      TaskStore.clear(tabId, taskId).catch((error) => {
        console.error(`[墨问 Background] Failed to clear cancelled task store: ${formatErrorForLog(error)}`);
      });
      sendResponse({ success: true });
    } else {
      console.log(`[墨问 Background] ⚠️ No running task found for tab ${tabId}, task ${taskId}`);
      sendResponse({ success: false, error: 'TASK_NOT_FOUND' });
    }

    return false;
  }

  if (message.type === 'PAUSE_SAVE') {
    const tabId = message.payload?.tabId;
    const taskId = message.payload?.taskId;
    if (!tabId || !taskId) {
      sendResponse({ success: false, error: 'INVALID_PAUSE_PAYLOAD' });
      return false;
    }

    const runningTask = getRunningTask(tabId, taskId);
    if (!runningTask) {
      sendResponse({ success: false, error: 'TASK_NOT_FOUND' });
      return false;
    }

    if (runningTask.status === 'running') {
      runningTask.status = 'pause_requested';
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'RESUME_SAVE') {
    const tabId = message.payload?.tabId;
    const taskId = message.payload?.taskId;
    if (!tabId || !taskId) {
      sendResponse({ success: false, error: 'INVALID_RESUME_PAYLOAD' });
      return false;
    }

    const runningTask = getRunningTask(tabId, taskId);
    if (!runningTask) {
      sendResponse({ success: false, error: 'TASK_NOT_FOUND' });
      return false;
    }

    runningTask.status = 'running';
    notifyTaskWaiters(runningTask);
    TaskStore.updateProgress(tabId, taskId, { status: 'creating' }).catch(() => { });
    chrome.runtime.sendMessage({
      type: 'SAVE_NOTE_RESUMED',
      tabId,
      taskId,
    } as SaveTaskResumedMessage).catch(() => { });
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
        console.error(`[墨问 Background] Failed to save settings: ${formatErrorForLog(error)}`);
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

    if (!message.payload.taskId) {
      console.error('[墨问 Background] ❌ taskId is missing in SAVE_NOTE message');
      sendResponse({ success: false, error: 'taskId is required' });
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
      const taskId = message.payload.taskId;
      if (!targetTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = activeTab?.id;
      }

      if (!targetTabId) {
        console.error('[墨问 Background] ❌ Could not determine target tab ID');
        chrome.runtime.sendMessage({
          type: 'SAVE_NOTE_COMPLETE',
          tabId: -1,
          taskId,
          result: {
            success: false,
            error: '无法确定目标标签页',
            errorCode: 'INVALID_TAB',
          },
        } as SaveTaskCompleteMessage).catch(() => { });
        return;
      }

      try {
        handleSaveNote(message.payload, targetTabId)
          .then((result) => {
            console.log(`[墨问 Background] 📤 Sending SAVE_NOTE_COMPLETE for tab ${targetTabId}, task ${taskId}:`, result.success);
            chrome.runtime.sendMessage({
              type: 'SAVE_NOTE_COMPLETE',
              tabId: targetTabId,
              taskId,
              result,
            } as SaveTaskCompleteMessage).catch(() => { });
          })
          .catch((error) => {
            console.error(`[墨问 Background] Save process failed: ${formatErrorForLog(error)}`);
            chrome.runtime.sendMessage({
              type: 'SAVE_NOTE_COMPLETE',
              tabId: targetTabId,
              taskId,
              result: {
                success: false,
                error: error.message || 'Unknown error',
                errorCode: 'UNKNOWN',
              },
            } as SaveTaskCompleteMessage).catch(() => { });
          });
      } catch (e) {
        console.error(`[墨问 Background] Synchronous error calling handleSaveNote: ${formatErrorForLog(e)}`);
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
        console.error(`[墨问 Background] SAVE_HIGHLIGHT error: ${formatErrorForLog(error)}`);
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

  // 墨问 Web 内部 API 代理请求
  // 扩展页面（chrome-extension:// 协议）无法携带第三方网站 Cookie，
  // 因此通过 Background Service Worker 代理请求（host_permissions 已覆盖 <all_urls>）
  if (message.type === 'MOWEN_WEB_API_REQUEST') {
    const { path, body } = message.payload || {};
    console.log('[墨问 Background] 🌐 MOWEN_WEB_API_REQUEST:', path);

    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ success: false, error: '非法请求来源', errorCode: 'UNTRUSTED_SENDER' });
      return false;
    }

    if (!path) {
      sendResponse({ success: false, error: '缺少请求路径', errorCode: 'INVALID_REQUEST' });
      return false;
    }

    if (!isAllowedMowenWebApiPath(path)) {
      sendResponse({ success: false, error: '不支持的接口路径', errorCode: 'PATH_NOT_ALLOWED' });
      return false;
    }

    const WEB_API_BASE = 'https://note.mowen.cn';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    (async () => {
      try {
        const response = await fetch(`${WEB_API_BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const isAuthError = response.status === 401 || response.status === 403;
          sendResponse({
            success: false,
            error: isAuthError ? '请先在浏览器中登录墨问' : `请求失败 (HTTP ${response.status})`,
            errorCode: isAuthError ? 'NOT_LOGGED_IN' : 'REQUEST_FAILED',
            status: response.status,
          });
          return;
        }

        const data = await response.json();
        sendResponse({ success: true, data });
      } catch (error) {
        clearTimeout(timeoutId);
        const isAbort = error instanceof Error && error.name === 'AbortError';
        sendResponse({
          success: false,
          error: isAbort ? '请求超时，请检查网络连接' : (error instanceof Error ? error.message : '未知错误'),
          errorCode: isAbort ? 'TIMEOUT' : 'UNKNOWN',
          status: 0,
        });
      }
    })();

    return true; // 保持消息通道开放以便异步响应
  }

  // PDF 导出：通过 Background SW 代理下载图片并转为 data URL
  // 扩展页面（chrome-extension:// 协议）受 CORS 限制无法直接加载跨域图片到 Canvas，
  // 但 Background SW 拥有 host_permissions: <all_urls>，可以绕过
  if (message.type === 'FETCH_IMAGE_AS_DATA_URL') {
    const { url } = message.payload || {};

    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ success: false, error: '非法请求来源' });
      return false;
    }

    if (!url) {
      sendResponse({ success: false, error: '缺少图片 URL' });
      return false;
    }

    if (!isAllowedImageProxyUrl(url)) {
      sendResponse({ success: false, error: '不允许代理该图片地址' });
      return false;
    }

    (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 秒超时

      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: shouldIncludeImageProxyCredentials(url) ? 'include' : 'omit',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          sendResponse({ success: false, error: `HTTP ${response.status}` });
          return;
        }

        const responseType = (response.headers.get('content-type') || '').toLowerCase();
        if (responseType && !responseType.startsWith('image/')) {
          sendResponse({ success: false, error: '仅支持图片资源' });
          return;
        }

        const responseLength = Number(response.headers.get('content-length') || '0');
        if (Number.isFinite(responseLength) && responseLength > MAX_PROXY_IMAGE_BYTES) {
          sendResponse({ success: false, error: '图片过大，无法导出' });
          return;
        }

        const blob = await response.blob();
        const mimeType = blob.type || 'image/jpeg';
        if (!mimeType.toLowerCase().startsWith('image/')) {
          sendResponse({ success: false, error: '仅支持图片资源' });
          return;
        }

        if (blob.size > MAX_PROXY_IMAGE_BYTES) {
          sendResponse({ success: false, error: '图片过大，无法导出' });
          return;
        }

        // Blob → base64
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const dataUrl = `data:${mimeType};base64,${base64}`;

        sendResponse({ success: true, dataUrl });
      } catch (error) {
        clearTimeout(timeoutId);
        const isAbort = error instanceof Error && error.name === 'AbortError';
        sendResponse({
          success: false,
          error: isAbort ? '图片下载超时' : (error instanceof Error ? error.message : '未知错误'),
        });
      }
    })();

    return true; // 保持消息通道开放
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
      console.error(`[墨问 Background] Append failed: ${formatErrorForLog(error)}`);
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

  // 标题生成逻辑：
  // 1. 如果页面标题有效，使用 "划线笔记：{页面标题（截取30字）}"
  // 2. 如果页面标题无效，从划线内容中提取前 30 字作为标题
  // 注意：正文始终保留原始 HTML 格式（包括链接），不再从正文中移除标题文本
  let title: string;
  if (isValidPageTitle(highlight.pageTitle)) {
    // 页面标题有效，但也需要限制长度为30字
    const truncatedTitle = highlight.pageTitle.length > 30
      ? highlight.pageTitle.substring(0, 30) + '...'
      : highlight.pageTitle;
    title = `划线笔记：${truncatedTitle}`;
    console.log('[墨问 Background] ✅ Using page title (truncated):', title);
  } else {
    // 从划线内容中提取标题
    const { title: extractedTitle } = extractTitleFromText(highlight.text, 30);
    title = `划线笔记：${extractedTitle || '未命名'}`;
    console.log('[墨问 Background] 📝 Extracted title from content:', extractedTitle);
  }

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

async function handleSaveNote(payload: SaveNotePayload, tabId: number): Promise<NoteCreateResult> {
  // Defensive check for payload
  if (!payload) {
    console.error('[墨问 Background] ❌ Payload is undefined/null');
    return { success: false, error: 'Payload is undefined', errorCode: 'INVALID_PAYLOAD' };
  }

  console.log(`[墨问 Background] 🚀 handleSaveNote started for tab ${tabId}`);
  logToContentScript('🚀 handleSaveNote started', tabId);

  const {
    extractResult,
    isPublic,
    includeImages,
    maxImages,
    createIndexNote,
    enableAutoTag,
    taskId,
  } = payload;

  if (!taskId) {
    return { success: false, error: 'taskId 缺失', errorCode: 'INVALID_PAYLOAD' };
  }

  if (!extractResult) {
    console.error('[墨问 Background] ❌ extractResult is undefined/null');
    return { success: false, error: 'extractResult is undefined', errorCode: 'INVALID_PAYLOAD' };
  }

  if (!extractResult.contentHtml) {
    console.error('[墨问 Background] ❌ extractResult.contentHtml is empty');
    return { success: false, error: '页面内容为空', errorCode: 'EMPTY_CONTENT' };
  }

  let settings;
  try {
    settings = await getSettings();
    console.log('[墨问 Background] ✅ Settings loaded');
    logToContentScript('✅ Settings loaded', tabId);
  } catch (err) {
    console.error(`[墨问 Background] Failed to load settings: ${formatErrorForLog(err)}`);
    return { success: false, error: '无法加载设置', errorCode: 'SETTINGS_ERROR' };
  }

  if (!settings.apiKey) {
    console.error('[墨问 Background] ❌ No API key configured');
    return { success: false, error: 'API Key 未配置', errorCode: 'UNAUTHORIZED' };
  }

  const existingTask = runningTasks.get(tabId);
  if (existingTask && existingTask.taskId !== taskId) {
    existingTask.controller.abort();
    void TaskStore.clear(tabId, existingTask.taskId).catch(() => { });
  }

  const abortController = new AbortController();
  runningTasks.set(tabId, { taskId, controller: abortController, status: 'running', waiters: [] });
  const signal = abortController.signal;

  try {
    await TaskStore.init(tabId, taskId);
  } catch (e) {
    console.log(`[墨问 Background] ⚠️ 无法初始化 TaskStore for tab ${tabId}`);
  }

  const finalize = async (
    result: NoteCreateResult,
    options: { clearTask?: boolean } = {}
  ): Promise<NoteCreateResult> => {
    const currentTask = runningTasks.get(tabId);
    if (currentTask?.taskId === taskId) {
      runningTasks.delete(tabId);
    }

    try {
      if (options.clearTask) {
        await TaskStore.clear(tabId, taskId);
      } else {
        await TaskStore.complete(tabId, taskId, result);
      }
    } catch (storageError) {
      console.error(`[墨问 Background] Failed to finalize task state: ${formatErrorForLog(storageError)}`);
    }

    return result;
  };

  try {
    // Step 1: Process images (if enabled)
    let processedContent = extractResult.contentHtml;
    let imageResults: ImageProcessResult[] = [];
    const images = extractResult.images || [];

    if (includeImages && images.length > 0) {
      console.log(`[墨问 Background] 🖼️ Found ${images.length} images, processing...`);
      logToContentScript(`🖼️ Found ${images.length} images, processing...`, tabId);
      const imagesToProcess = images.slice(0, maxImages);
      const extraImages = images.slice(maxImages);

      // Upload images with concurrency control
      imageResults = await processImages(settings.apiKey, imagesToProcess, tabId, taskId, signal);

      processedContent = replaceImageUrls(processedContent, imageResults, extraImages);

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

    if (signal.aborted) {
      console.log('[墨问 Background] ⚠️ Cancel requested, aborting note creation');
      return finalize({ success: false, error: '已取消保存', errorCode: 'CANCELLED' }, { clearTask: true });
    }

    const parts = splitContent(
      extractResult.title,
      extractResult.sourceUrl,
      processedContent,
      SAFE_LIMIT
    );

    console.log(`[note] create start title="${extractResult.title.substring(0, 30)}..." partsCount=${parts.length}`);
    logToContentScript(`创建 ${parts.length} 篇笔记...`, tabId);
    const createdNotes: Array<{ partIndex: number; noteUrl: string; noteId: string; shareUrl?: string; isIndex?: boolean }> = [];

    for (const part of parts) {
      const runnableState = await waitForTaskRunnable(tabId, taskId, {
        ...((await TaskStore.get(tabId))?.progress || {}),
        status: 'paused',
      });
      if (runnableState === 'cancelled') {
        break;
      }

      if (signal.aborted) {
        console.log('[墨问 Background] ⚠️ Cancel requested, stopping note creation loop');
        break;
      }

      try {
        sendProgressUpdate({
          type: 'creating_note',
          currentPart: part.index + 1,
          totalParts: parts.length,
        }, tabId, taskId);
      } catch (err) { /* ignore */ }

      let result: NoteCreateResult = { success: false, error: 'Not executed', errorCode: 'UNKNOWN' };
      let retryCount = 0;
      let success = false;

      while (retryCount < MAX_RETRY_ROUNDS) {
        const retryRunnableState = await waitForTaskRunnable(tabId, taskId, {
          type: 'creating_note',
          currentPart: part.index + 1,
          totalParts: parts.length,
          status: 'paused',
        } as SaveProgress);
        if (retryRunnableState === 'cancelled') {
          break;
        }

        if (signal.aborted) break;

        retryCount++;
        console.log(`[note] part ${part.index + 1}/${parts.length} attempt ${retryCount}`);
        logToContentScript(`📝 正在创建第 ${part.index + 1}/${parts.length} 部分 (第 ${retryCount} 次尝试)...`, tabId);

        try {
          result = await GlobalRateLimiter.schedule(async () => {
            if (part.body) {
              return createNoteWithBody(
                settings.apiKey,
                part.body as unknown as Record<string, unknown>,
                isPublic,
                enableAutoTag,
                signal
              );
            }

            const logWrapper = async (msg: string) => { logToContentScript(msg, tabId); };
            return createNote(
              settings.apiKey,
              part.title,
              part.content || '',
              isPublic,
              logWrapper,
              extractResult.sourceUrl,
              enableAutoTag,
              signal
            );
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
          if (!shouldRetryCreateFailure(result)) {
            console.log(`[note] part ${part.index + 1} non-retriable error ${result.errorCode}, skip retry`);
            break;
          }
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

    if (signal.aborted) {
      console.log('[墨问 Background] ⚠️ Cancel requested after note creation loop');
      return finalize({ success: false, error: '已取消保存', errorCode: 'CANCELLED' }, { clearTask: true });
    }

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

      const indexRunnableState = await waitForTaskRunnable(tabId, taskId, {
        type: 'creating_note',
        currentPart: parts.length,
        totalParts: parts.length,
        status: 'paused',
      } as SaveProgress);
      if (indexRunnableState === 'cancelled') {
        return finalize({ success: false, error: '已取消保存', errorCode: 'CANCELLED' }, { clearTask: true });
      }

      const indexResult = await GlobalRateLimiter.schedule(async () => {
        return await createNoteWithBody(
          settings.apiKey,
          indexBody,
          isPublic,
          enableAutoTag,
          signal
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
        console.error(`[墨问 Background] 合集笔记创建失败: ${formatErrorForLog(indexResult.error || 'Unknown error')}`);
        logToContentScript(`⚠️ 合集笔记创建失败: ${indexResult.error || '未知错误'}`, tabId);
      }
    }

    console.log('[墨问 Background] 📊 Final note count:', createdNotes.length);

    if (createdNotes.length === 0) {
      console.error('[墨问 Background] ❌ No notes were created');
      return finalize({ success: false, error: '创建笔记失败', errorCode: 'UNKNOWN' });
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

    return finalize(result);
  } catch (error) {
    console.error(`[墨问 Background] Save process failed with exception: ${formatErrorForLog(error)}`);
    const errorResult = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: 'UNKNOWN',
    };
    return finalize(errorResult);
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
}, tabId: number, taskId: string) {
  chrome.runtime.sendMessage({
    type: 'SAVE_NOTE_PROGRESS',
    tabId,
    taskId,
    progress,
  } as SaveTaskProgressMessage).catch(() => {
    // Popup might be closed, ignore error
  });

  // 更新持久化状态
  if (tabId) {
    TaskStore.updateProgress(tabId, taskId, {
      ...progress,
      status: progress.type === 'uploading_images' ? 'uploading_images' : 'creating_note',
    }).catch((error) => console.error(`Failed to persist progress: ${formatErrorForLog(error)}`));
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
  taskId: string,
  signal: AbortSignal
): Promise<ImageProcessResult[]> {
  console.log(`[img] ========== START PROCESSING ${images.length} IMAGES (Pipeline) ==========`);
  logToContentScript(`🖼️ 开始处理 ${images.length} 张图片 (流水线模式)...`, tabId);

  const totalImages = images.length;
  // Initialize results array
  const results: ImageProcessResult[] = new Array(totalImages);
  const pausedProgress = (uploadedImages: number): SaveProgress => ({
    status: 'paused',
    uploadedImages,
    totalImages,
  });

  sendProgressUpdate({
    type: 'uploading_images',
    uploadedImages: 0,
    totalImages,
  }, tabId, taskId);

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
      console.error(`[img] Fetch blob ${imageIndex} error: ${formatErrorForLog(e)}`);
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
    const runnableState = await waitForTaskRunnable(tabId, taskId, pausedProgress(i));
    if (runnableState === 'cancelled') {
      console.log('[img] ⚠️ Cancel requested before upload step');
      break;
    }

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
      console.error(`[img] Upload ${imageIndex} exception: ${formatErrorForLog(err)}`);
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
    }, tabId, taskId);
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
  extraImages: ImageCandidate[]
): string {
  interface ImageReplacementAction {
    kind: 'inject_uid' | 'replace_with_link';
    originalUrl: string;
    uid?: string;
    label?: string;
  }

  const actions: ImageReplacementAction[] = [
    ...imageResults
      .filter((result) => result.success && result.uid)
      .map((result) => ({
        kind: 'inject_uid' as const,
        originalUrl: result.originalUrl,
        uid: result.uid!,
      })),
    ...imageResults
      .filter((result) => !result.success)
      .map((result) => ({
        kind: 'replace_with_link' as const,
        originalUrl: result.originalUrl,
      })),
    ...extraImages.map((image) => ({
      kind: 'replace_with_link' as const,
      originalUrl: image.url,
      label: buildImageFallbackLabel(image.alt),
    })),
  ];

  let successCount = 0;
  let failCount = 0;

  const processed = content.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const tagUrls = extractImageUrlsFromTag(imgTag);
    const action = actions.find((candidate) => tagUrls.some((url) => matchesImageUrl(url, candidate.originalUrl)));

    if (!action) {
      return imgTag;
    }

    if (action.kind === 'inject_uid' && action.uid) {
      if (imgTag.includes('data-mowen-uid=')) {
        return imgTag;
      }
      successCount++;
      return imgTag.replace(/\s*\/?>$/, ` data-mowen-uid="${escapeHtmlAttribute(action.uid)}">`);
    }

    const safeLinkUrl = [action.originalUrl, ...tagUrls].find((url) => isSafeHttpUrl(url));
    if (!safeLinkUrl) {
      return imgTag;
    }

    failCount++;
    return buildImageFallbackLinkHtml(
      safeLinkUrl,
      action.label || buildImageFallbackLabel(extractImageAltFromTag(imgTag))
    );
  });

  console.log(`[sw] replaceImageUrls: done replacements. Success: ${successCount}, Fail: ${failCount}`);
  return processed;
}

function buildImageFallbackLabel(alt?: string): string {
  const normalizedAlt = alt?.trim();
  if (!normalizedAlt) {
    return '查看原图';
  }
  return `查看原图：${normalizedAlt}`;
}

function buildImageFallbackLinkHtml(url: string, label: string): string {
  return `<p><a href="${escapeHtmlAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(label)}</a></p>`;
}

function extractImageUrlsFromTag(imgTag: string): string[] {
  const urls: string[] = [];
  const attributeNames = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc'];

  for (const attributeName of attributeNames) {
    const match = imgTag.match(new RegExp(`${attributeName}=["']([^"']+)["']`, 'i'));
    if (match?.[1]) {
      urls.push(match[1].trim());
    }
  }

  const srcsetNames = ['srcset', 'data-srcset'];
  for (const attributeName of srcsetNames) {
    const match = imgTag.match(new RegExp(`${attributeName}=["']([^"']+)["']`, 'i'));
    if (!match?.[1]) continue;
    const srcsetUrls = match[1]
      .split(',')
      .map((value) => value.trim().split(/\s+/)[0])
      .filter(Boolean);
    urls.push(...srcsetUrls);
  }

  return Array.from(new Set(urls));
}

function extractImageAltFromTag(imgTag: string): string {
  const captionMatch = imgTag.match(/data-mowen-caption=["']([^"']+)["']/i);
  if (captionMatch?.[1]) {
    return captionMatch[1].trim();
  }

  const altMatch = imgTag.match(/alt=["']([^"']+)["']/i);
  return altMatch?.[1]?.trim() || '';
}

function matchesImageUrl(candidateUrl: string, targetUrl: string): boolean {
  if (!candidateUrl || !targetUrl) {
    return false;
  }

  if (candidateUrl === targetUrl) {
    return true;
  }

  const candidateBase = stripUrlSearchAndHash(candidateUrl);
  const targetBase = stripUrlSearchAndHash(targetUrl);

  if (candidateBase === targetBase) {
    return true;
  }

  if (stripWidthSuffix(candidateBase) === stripWidthSuffix(targetBase)) {
    return true;
  }

  const candidateMediumId = extractMediumImageId(candidateUrl);
  const targetMediumId = extractMediumImageId(targetUrl);
  if (candidateMediumId && candidateMediumId === targetMediumId) {
    return true;
  }

  const candidateUniqueSegment = extractUniquePathSegment(candidateUrl);
  const targetUniqueSegment = extractUniquePathSegment(targetUrl);
  if (candidateUniqueSegment && candidateUniqueSegment === targetUniqueSegment) {
    return true;
  }

  const candidateFilename = extractImageFilename(candidateUrl);
  const targetFilename = extractImageFilename(targetUrl);
  if (candidateFilename && candidateFilename.length > 5 && candidateFilename === targetFilename) {
    return true;
  }

  return false;
}

function stripUrlSearchAndHash(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.split('#')[0].split('?')[0];
  }
}

function stripWidthSuffix(rawUrl: string): string {
  return rawUrl.replace(/\/\d{1,4}$/, '');
}

function extractImageFilename(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname.split('/').pop() || '';
  } catch {
    const cleanUrl = stripUrlSearchAndHash(rawUrl);
    return cleanUrl.split('/').pop() || '';
  }
}

function extractUniquePathSegment(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 10);
    return segments.sort((a, b) => b.length - a.length)[0] || '';
  } catch {
    return '';
  }
}

function extractMediumImageId(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const match = parsed.pathname.match(/(\d\*[A-Za-z0-9_-]+)/);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;' :
      char === '<' ? '&lt;' :
        char === '>' ? '&gt;' :
          char === '"' ? '&quot;' : '&#39;'
  ));
}

function escapeHtmlText(value: string): string {
  return escapeHtmlAttribute(value);
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


function splitContent(title: string, sourceUrl: string, content: string, limit: number): NoteSplitPart[] {
  const contentBody = htmlToNoteAtom(content) as unknown as NoteAtomDoc;
  const contentBlocks = Array.isArray(contentBody.content) ? contentBody.content : [];
  const totalTextLength = contentBlocks.reduce((sum, block) => sum + getNodeTextLength(block), 0);

  if (totalTextLength <= limit) {
    return [{
      index: 0,
      title,
      content,
      total: 1,
    }];
  }

  console.log(`[bg] Text length ${totalTextLength} > ${limit}, splitting by NoteAtom blocks...`);

  const normalizedBlocks = contentBlocks.flatMap((block) => splitOversizedBlock(block, limit));
  const groupedBlocks: NoteAtomNode[][] = [];
  let currentGroup: NoteAtomNode[] = [];
  let currentLength = 0;

  for (const block of normalizedBlocks) {
    const blockLength = Math.max(getNodeTextLength(block), 1);

    if (currentGroup.length > 0 && currentLength + blockLength > limit) {
      groupedBlocks.push(currentGroup);
      currentGroup = [];
      currentLength = 0;
    }

    currentGroup.push(cloneNoteAtomNode(block));
    currentLength += blockLength;

    if (blockLength > limit) {
      groupedBlocks.push(currentGroup);
      currentGroup = [];
      currentLength = 0;
    }
  }

  if (currentGroup.length > 0) {
    groupedBlocks.push(currentGroup);
  }

  const total = groupedBlocks.length;
  if (total <= 1) {
    return [{
      index: 0,
      total: 1,
      title,
      content,
    }];
  }

  return groupedBlocks.map((blocks, index) => {
    const partTitle = index === 0 ? title : `${title} (${index + 1})`;
    return {
      index,
      total,
      title: partTitle,
      body: buildMultipartBody(partTitle, sourceUrl, blocks),
    };
  });
}

function buildMultipartBody(title: string, sourceUrl: string, blocks: NoteAtomNode[]): NoteAtomDoc {
  const metaBody = buildNoteBody(title, '', sourceUrl) as unknown as NoteAtomDoc;
  return {
    type: 'doc',
    content: [
      ...(Array.isArray(metaBody.content) ? metaBody.content.map((block) => cloneNoteAtomNode(block)) : []),
      ...blocks.map((block) => cloneNoteAtomNode(block)),
    ],
  };
}

function splitOversizedBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const blockLength = getNodeTextLength(block);
  if (blockLength <= limit) {
    return [cloneNoteAtomNode(block)];
  }

  if (block.type === 'paragraph' || block.type === 'quote') {
    return splitTextBlock(block, limit);
  }

  if (block.type === 'codeblock') {
    return splitCodeBlock(block, limit);
  }

  return [cloneNoteAtomNode(block)];
}

function splitTextBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const content = Array.isArray(block.content) ? block.content : [];
  const fullText = content.map((node) => node.text || '').join('');
  if (!fullText) {
    return [cloneNoteAtomNode(block)];
  }

  const chunks: NoteAtomNode[] = [];
  let start = 0;

  while (start < fullText.length) {
    const nextEnd = findPreferredTextSplit(fullText, start, limit);
    const end = nextEnd > start ? nextEnd : Math.min(fullText.length, start + limit);
    const slicedContent = sliceInlineTextNodes(content, start, end);
    const slicedLength = slicedContent.reduce((sum, node) => sum + (node.text?.length || 0), 0);

    if (slicedLength === 0) {
      break;
    }

    chunks.push({
      ...cloneNoteAtomNode(block),
      content: slicedContent,
    });
    start = end;
  }

  return chunks.length > 0 ? chunks : [cloneNoteAtomNode(block)];
}

function findPreferredTextSplit(text: string, start: number, limit: number): number {
  const maxEnd = Math.min(text.length, start + limit);
  if (maxEnd >= text.length) {
    return text.length;
  }

  const window = text.slice(start, maxEnd);
  const newlineBoundary = window.lastIndexOf('\n');
  if (newlineBoundary > 0) {
    return start + newlineBoundary + 1;
  }

  const sentenceMatches = Array.from(window.matchAll(/[。！？!?；;](?:\s|$)|\.(?:\s|$)/g));
  if (sentenceMatches.length > 0) {
    const lastMatch = sentenceMatches[sentenceMatches.length - 1];
    return start + lastMatch.index + lastMatch[0].length;
  }

  const whitespaceBoundary = window.search(/\s+[^\s]*$/);
  if (whitespaceBoundary > 0) {
    return start + whitespaceBoundary + 1;
  }

  return maxEnd;
}

function sliceInlineTextNodes(content: NoteAtomNode[], start: number, end: number): NoteAtomNode[] {
  const result: NoteAtomNode[] = [];
  let offset = 0;

  for (const node of content) {
    const text = node.text || '';
    const nodeStart = offset;
    const nodeEnd = offset + text.length;
    offset = nodeEnd;

    if (nodeEnd <= start || nodeStart >= end) {
      continue;
    }

    const sliceStart = Math.max(0, start - nodeStart);
    const sliceEnd = Math.min(text.length, end - nodeStart);
    const nextText = text.slice(sliceStart, sliceEnd);
    if (!nextText) {
      continue;
    }

    result.push({
      ...cloneNoteAtomNode(node),
      text: nextText,
      content: undefined,
    });
  }

  return result;
}

function splitCodeBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const codeText = getNodeText(block);
  if (!codeText) {
    return [cloneNoteAtomNode(block)];
  }

  const lines = codeText.match(/[^\n]*\n?|[^\n]+/g)?.filter(Boolean) || [codeText];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    if (line.length > limit) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }

    if (currentChunk && currentChunk.length + line.length > limit) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    currentChunk += line;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.map((chunk) => ({
    ...cloneNoteAtomNode(block),
    content: [{ type: 'text', text: chunk }],
  }));
}

function getNodeTextLength(node: NoteAtomNode): number {
  const textLength = typeof node.text === 'string' ? node.text.length : 0;
  const childrenLength = Array.isArray(node.content)
    ? node.content.reduce((sum, child) => sum + getNodeTextLength(child), 0)
    : 0;
  const combinedLength = textLength + childrenLength;

  if (combinedLength > 0) {
    return combinedLength;
  }

  if (node.type === 'image' || node.type === 'note' || node.type === 'file') {
    return 1;
  }

  return 0;
}

function getNodeText(node: NoteAtomNode): string {
  if (typeof node.text === 'string') {
    return node.text;
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content.map((child) => getNodeText(child)).join('');
}

function cloneNoteAtomNode<T extends NoteAtomNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
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
