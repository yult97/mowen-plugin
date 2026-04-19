import {
  HighlightSaveResult,
  SaveHighlightPayload,
  SaveProgress,
  NoteCreateResult,
} from '../types';

interface SaveTaskCompleteMessage {
  type: 'SAVE_NOTE_COMPLETE';
  tabId: number;
  taskId: string;
  result: NoteCreateResult;
}

interface SaveTaskResumedMessage {
  type: 'SAVE_NOTE_RESUMED';
  tabId: number;
  taskId: string;
}

interface RunningSaveTaskLike {
  taskId: string;
  controller: AbortController;
  status: 'running' | 'pause_requested' | 'paused' | 'cancelling';
  waiters: Array<() => void>;
}

/**
 * Background 消息路由层：
 * 只负责 message.type 分发、基础参数校验和异步响应通道管理，
 * 具体业务实现继续留在调用方提供的 handler 中。
 */
export function registerBackgroundMessageRouter(deps: {
  logger: { log: (...args: unknown[]) => void };
  formatErrorForLog: (error: unknown) => string;
  runningTasks: Map<number, RunningSaveTaskLike>;
  getRunningTask: (tabId: number, taskId: string) => RunningSaveTaskLike | null;
  notifyTaskWaiters: (task: RunningSaveTaskLike) => void;
  taskStore: {
    clear: (tabId: number, taskId?: string) => Promise<void>;
    updateProgress: (tabId: number, taskId: string, progress: SaveProgress) => Promise<void>;
  };
  saveSettings: (payload: Record<string, unknown>) => Promise<void>;
  handleSaveNote: (payload: any, tabId: number) => Promise<NoteCreateResult>;
  handleSaveMarkdownNote: (payload: any, tabId: number) => Promise<NoteCreateResult>;
  handleSaveHighlight: (payload: SaveHighlightPayload) => Promise<HighlightSaveResult>;
  isTrustedExtensionPageSender: (sender: chrome.runtime.MessageSender) => boolean;
  isAllowedMowenWebApiPath: (path: string) => boolean;
  isAllowedImageProxyUrl: (url: string) => boolean;
  shouldIncludeImageProxyCredentials: (url: string) => boolean;
  maxProxyImageBytes: number;
}): void {
  const {
    logger,
    formatErrorForLog,
    runningTasks,
    getRunningTask,
    notifyTaskWaiters,
    taskStore,
    saveSettings,
    handleSaveNote,
    handleSaveMarkdownNote,
    handleSaveHighlight,
    isTrustedExtensionPageSender,
    isAllowedMowenWebApiPath,
    isAllowedImageProxyUrl,
    shouldIncludeImageProxyCredentials,
    maxProxyImageBytes,
  } = deps;

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
        taskStore.clear(tabId, taskId).catch((error) => {
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
      taskStore.updateProgress(tabId, taskId, { status: 'creating' }).catch(() => { });
      chrome.runtime.sendMessage({
        type: 'SAVE_NOTE_RESUMED',
        tabId,
        taskId,
      } as SaveTaskResumedMessage).catch(() => { });
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'SAVE_SETTING') {
      (async () => {
        try {
          await saveSettings(message.payload);
          sendResponse({ success: true });
        } catch (error) {
          console.error(`[墨问 Background] Failed to save settings: ${formatErrorForLog(error)}`);
          sendResponse({ success: false, error: String(error) });
        }
      })();
      return true;
    }

    if (message.type === 'SAVE_NOTE' || message.type === 'SAVE_MARKDOWN_NOTE') {
      if (!message.payload) {
        sendResponse({ success: false, error: 'Payload is undefined' });
        return false;
      }

      if (!message.payload.taskId) {
        sendResponse({ success: false, error: 'taskId is required' });
        return false;
      }

      sendResponse({ success: true, acknowledged: true });

      (async () => {
        let targetTabId = message.payload?.tabId;
        const taskId = message.payload.taskId;
        if (!targetTabId) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = activeTab?.id;
        }

        if (!targetTabId) {
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
          const handler = message.type === 'SAVE_MARKDOWN_NOTE'
            ? handleSaveMarkdownNote
            : handleSaveNote;

          handler(message.payload, targetTabId)
            .then((result) => {
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

      return false;
    }

    if (message.type === 'SAVE_HIGHLIGHT') {
      handleSaveHighlight(message.payload as SaveHighlightPayload)
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          console.error(`[墨问 Background] SAVE_HIGHLIGHT error: ${formatErrorForLog(error)}`);
          const errorResult: HighlightSaveResult = {
            success: false,
            isAppend: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
          sendResponse(errorResult);
        });
      return true;
    }

    if (message.type === 'MOWEN_WEB_API_REQUEST') {
      const { path, body } = message.payload || {};

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

      return true;
    }

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
        const timeoutId = setTimeout(() => controller.abort(), 15000);

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
          if (Number.isFinite(responseLength) && responseLength > maxProxyImageBytes) {
            sendResponse({ success: false, error: '图片过大，无法导出' });
            return;
          }

          const blob = await response.blob();
          const mimeType = blob.type || 'image/jpeg';
          if (!mimeType.toLowerCase().startsWith('image/')) {
            sendResponse({ success: false, error: '仅支持图片资源' });
            return;
          }

          if (blob.size > maxProxyImageBytes) {
            sendResponse({ success: false, error: '图片过大，无法导出' });
            return;
          }

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

      return true;
    }

    if (message.type === 'OPEN_OPTIONS_PAGE') {
      chrome.runtime.openOptionsPage();
      sendResponse({ success: true });
      return false;
    }

    return false;
  });
}
