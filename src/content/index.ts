/**
 * Content Script Entry Point
 * 
 * This is the main entry point for the content script.
 * It handles message passing and initializes auto-extraction.
 * 
 * The heavy lifting is done by specialized modules:
 * - extractor.ts: Content extraction logic
 * - images.ts: Image extraction and filtering
 * - imageNormalizer.ts: CDN URL normalization
 * - imageFetcher.ts: Image data fetching for upload
 */

import {
  extractContent,
  getCachedResult,
  isExtractingContent,
  clearCache
} from './extractor';
import { clearQuoteUrlCache } from './twitterExtractor';
import { isTwitterPage } from './twitterExtractor';
import {
  getTwitterRuntimeReadinessSnapshot,
  shouldReuseTwitterCachedResult,
} from './twitter/runtime';
import { fetchImageAsBase64 } from './imageFetcher';
import { ExtractResult } from '../types';
import { initHighlighter } from './highlighter';

const CONTENT_SCRIPT_VERSION = '2026-04-21-v2';

const contentScriptGlobal = globalThis as typeof globalThis & {
  __mowenContentScriptLoaded__?: boolean;
  __mowenContentScriptBootstrapped__?: boolean;
  __mowenContentScriptVersion__?: string;
};

contentScriptGlobal.__mowenContentScriptLoaded__ = true;
const isSameVersionBootstrapped =
  contentScriptGlobal.__mowenContentScriptBootstrapped__ === true &&
  contentScriptGlobal.__mowenContentScriptVersion__ === CONTENT_SCRIPT_VERSION;
contentScriptGlobal.__mowenContentScriptVersion__ = CONTENT_SCRIPT_VERSION;

if (isSameVersionBootstrapped) {
  console.log('[content] Content script bootstrap already completed, skipping duplicate setup');
} else {
  contentScriptGlobal.__mowenContentScriptBootstrapped__ = true;

// State for auto-extraction
let observer: MutationObserver | null = null;
let isObserving = false;
let extractScheduled = false;

// URL 变化检测（用于 SPA 路由）
let lastKnownUrl = window.location.href;

// 定期检测 URL 变化（用于 Twitter 等 SPA）
setInterval(() => {
  if (window.location.href !== lastKnownUrl) {
    console.log(`[content] 🔄 URL changed: ${lastKnownUrl} -> ${window.location.href}`);
    lastKnownUrl = window.location.href;
    clearCache();
    clearQuoteUrlCache(); // 同时清理 Quote URL 缓存
    // 如果正在观察，触发新的提取
    if (isObserving) {
      scheduleExtraction();
    }
  }
}, 500);

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // console.log('[content] Received message:', message.type);

  // PING: Health check
  if (message.type === 'PING_V2') {
    sendResponse({ success: true, status: 'ready' });
    return false;
  }

  // START_EXTRACTION: Enable observer and trigger extraction
  if (message.type === 'START_EXTRACTION_V2') {
    console.log('[content] 🚀 START_EXTRACTION_V2 received');
    startAutoExtraction();

    // 内容稳定性检测：连续两次提取结果字数差异 < 5% 时认为内容已稳定
    const extractWithStability = async (maxAttempts: number, interval: number, stabilityThreshold: number = 0.05) => {
      let lastResult: ExtractResult | null = null;
      let lastWordCount = 0;

      for (let i = 0; i < maxAttempts; i++) {
        try {
          const result = await extractContent();
          const currentWordCount = result.wordCount;

          // 计算与上次提取的字数差异比例
          const diff = lastWordCount > 0
            ? Math.abs(currentWordCount - lastWordCount) / lastWordCount
            : 1; // 首次提取，差异设为 100%

          console.log(`[content] 提取 #${i + 1}: ${currentWordCount} 字, 变化: ${(diff * 100).toFixed(1)}%`);

          // 稳定性判定：字数变化 < 阈值 且 字数 > 50 且 有标题
          if (diff < stabilityThreshold && currentWordCount > 50 && result.title) {
            console.log(`[content] ✅ 内容已稳定，返回结果`);
            return result;
          }

          lastResult = result;
          lastWordCount = currentWordCount;
        } catch (error) {
          console.error(`[content] ⚠️ 提取 #${i + 1} 失败:`, error);
        }

        if (i < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, interval));
        }
      }

      if (lastResult) {
        console.log(`[content] ⏱️ 达到最大尝试次数，返回最后结果 (${lastResult.wordCount} 字)`);
        return lastResult;
      }
      throw new Error('All extraction attempts failed');
    };

    // 使用稳定性检测提取内容
    // 最多尝试 6 次，每次间隔 500ms，稳定阈值 1%（更严格）
    extractWithStability(6, 500, 0.01)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // STOP_EXTRACTION: Disable observer
  if (message.type === 'STOP_EXTRACTION_V2') {
    console.log('[content] 🛑 STOP_EXTRACTION_V2 received');
    stopAutoExtraction();
    sendResponse({ success: true });
    return false;
  }

  // GET_CACHED_CONTENT: Return cached content if available
  if (message.type === 'GET_CACHED_CONTENT_V2') {
    console.log('[content] 💾 GET_CACHED_CONTENT_V2 request');
    let cached = getCachedResult();
    const isExtracting = isExtractingContent();

    if (cached && isTwitterPage(window.location.href)) {
      const snapshot = getTwitterRuntimeReadinessSnapshot(document);
      if (!shouldReuseTwitterCachedResult(cached, snapshot)) {
        console.log('[content] ♻️ Twitter cache is incomplete for hydrated DOM, forcing fresh extraction', {
          cachedWordCount: cached.wordCount,
          cachedBlocks: cached.blocks?.length || 0,
          articleCount: snapshot.articleCount,
          tweetTextCount: snapshot.tweetTextCount,
          tweetTextLength: snapshot.tweetTextLength,
        });
        clearCache();
        cached = null;
      }
    }

    console.log('[content] Cache status:', {
      hasCache: !!cached,
      isExtracting,
      extractScheduled,
      isObserving,
    });

    if (cached) {
      sendResponse({
        success: true,
        data: cached,
        fromCache: true,
      });
      return false;
    }

    if (isExtracting) {
      sendResponse({
        success: false,
        extracting: true,
        error: 'Extraction in progress',
      });
      return false;
    }

    // If we are not observing, we might need to start it, or just do a one-off extraction
    // But usually GET_CACHED_CONTENT implies we want something fast.
    // If no cache, trigger extraction (same as before)
    extractContent()
      .then((result) => {
        sendResponse({ success: true, data: result, fromCache: false });
      })
      .catch((error) => {
        console.error('[content] ❌ Extraction failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // EXTRACT_CONTENT: Force fresh extraction
  if (message.type === 'EXTRACT_CONTENT') {
    // If we receive this, we should also ensure observer is running if the user expects auto-updates
    if (!isObserving) {
      startAutoExtraction();
    }

    extractContent()
      .then((result) => {
        console.log('[content] Extraction successful, word count:', result.wordCount);
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        console.error('[content] ❌ Extraction failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // FETCH_IMAGE: Fetch image as base64 for upload
  if (message.type === 'FETCH_IMAGE_V2') {
    fetchImageAsBase64(message.payload.url)
      .then((result) => {
        if (result) {
          sendResponse({ success: true, data: result });
        } else {
          sendResponse({ success: false, error: 'Failed to fetch image' });
        }
      })
      .catch((error) => {
        console.error('[content] ❌ FETCH_IMAGE error:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // LOG_DEBUG: Debug logging proxy from background
  if (message.type === 'LOG_DEBUG') {
    sendResponse({ success: true });
    return false;
  }

  // HIGHLIGHT_RESULT: 处理右键菜单保存结果（显示 Toast）
  if (message.type === 'HIGHLIGHT_RESULT') {
    const result = message.payload as { success: boolean; noteUrl?: string; isAppend?: boolean; error?: string };
    showHighlightResultToast(result);
    sendResponse({ success: true });
    return false;
  }

  // Unknown message types
  return false;
});

/**
 * 显示划线保存结果 Toast（用于右键菜单保存）
 * 样式与 HighlightManager 的 showToast 保持一致
 */
function showHighlightResultToast(result: { success: boolean; noteUrl?: string; isAppend?: boolean; error?: string }): void {
  // 移除已有的 toast
  const existingToast = document.querySelector('.mowen-toast');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  const type = result.success ? 'success' : 'error';
  toast.className = `mowen-toast ${type}`;

  const message = result.success
    ? '保存成功'
    : (result.error || '保存失败');

  // 根据类型选择图标（与 HighlightManager 一致）
  const iconHtml = result.success
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 7H19V19C19 20.1046 18.1046 21 17 21H7C5.89543 21 5 20.1046 5 19V7Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M8 7V5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 10L12.9 12.2L15 12.5L13.5 14L13.8 16.5L12 15.4L10.2 16.5L10.5 14L9 12.5L11.1 12.2L12 10Z" fill="currentColor"/>
       </svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/>
        <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
       </svg>`;

  let html = `
    <span class="mowen-toast-icon">${iconHtml}</span>
    <span class="mowen-toast-message">${message}</span>
  `;

  // 如果有链接，添加操作按钮
  if (result.success && result.noteUrl) {
    html += `<a href="${result.noteUrl}" target="_blank" class="mowen-toast-action">去墨问笔记查看</a>`;
  }

  toast.innerHTML = html;

  // 注入 Toast 样式（如果尚未注入）
  injectToastStyles();

  document.body.appendChild(toast);

  // 3秒后自动消失
  setTimeout(() => {
    toast.classList.add('mowen-toast-out');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

/**
 * 注入 Toast 样式（与 HighlightManager 一致）
 */
function injectToastStyles(): void {
  if (document.getElementById('mowen-toast-styles')) return;

  const style = document.createElement('style');
  style.id = 'mowen-toast-styles';
  style.textContent = `
    .mowen-toast {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      background: #FFFFFF;
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      color: #1F2937;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
      animation: mowen-toast-in 0.3s ease-out forwards;
    }
    @keyframes mowen-toast-in {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .mowen-toast-out {
      animation: mowen-toast-out 0.2s ease-in forwards;
    }
    @keyframes mowen-toast-out {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-10px); }
    }
    .mowen-toast-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }
    .mowen-toast-icon svg {
      width: 24px;
      height: 24px;
    }
    .mowen-toast-message {
      flex: 1;
      color: #1F2937;
      white-space: nowrap;
    }
    .mowen-toast-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.04);
      border: none;
      border-radius: 20px;
      color: #6B7280;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .mowen-toast-action:hover {
      background: rgba(0, 0, 0, 0.08);
      color: #374151;
    }
    .mowen-toast.success .mowen-toast-icon { color: #BF4045; }
    .mowen-toast.error .mowen-toast-icon { color: #EF4444; }
  `;
  document.head.appendChild(style);
}

/**
 * Schedule content extraction with debouncing.
 */
function scheduleExtraction(): void {
  if (extractScheduled) {
    console.log('[content] ⏸️ Extraction already scheduled, skipping');
    return;
  }

  extractScheduled = true;
  console.log('[content] 📅 Scheduling extraction in 1.5s');

  setTimeout(() => {
    extractScheduled = false;
    console.log('[content] ⏰ Scheduled extraction triggered');
    extractContent()
      .then((result) => {
        // Notify popup/sidepanel about the update
        chrome.runtime.sendMessage({
          type: 'CONTENT_UPDATED',
          data: result
        }).catch(() => {
          // Ignore error if popup is closed
        });
      })
      .catch((err) => {
        console.error('[content] ❌ Auto-extraction failed:', err);
      });
  }, 1500);
}

/**
 * Start auto-extraction (MutationObserver)
 */
function startAutoExtraction(): void {
  if (isObserving) {
    console.log('[content] ✅ Already observing');
    return;
  }

  console.log('[content] 🎯 Starting auto-extraction observer');

  // Watch for dynamic content changes
  console.log('[content] 👁️ Setting up MutationObserver');

  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    const hasSignificantChanges = mutations.some((mutation) => {
      if (mutation.type === 'characterData') {
        return (mutation.target.textContent || '').trim().length > 50;
      }

      if (mutation.type !== 'childList') {
        return false;
      }

      return mutation.addedNodes.length > 0 &&
        Array.from(mutation.addedNodes).some((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            return !['SCRIPT', 'STYLE', 'IFRAME'].includes(el.tagName) &&
              (el.children.length > 0 || (el.textContent?.length || 0) > 50);
          }

          return node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length || 0) > 50;
        });
    });

    if (hasSignificantChanges) {
      console.log('[content] 🔄 Significant page change detected, invalidating cache');
      clearCache();
      scheduleExtraction();
    }
  });

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  isObserving = true;
}

/**
 * Stop auto-extraction
 */
function stopAutoExtraction(): void {
  if (!isObserving) return;

  console.log('[content] 🛑 Stopping auto-extraction observer');
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  isObserving = false;
}

// Initialize
console.log('[墨问笔记助手] Content script loaded (Lazy Mode)');
console.log('[content] Page URL:', window.location.href);

// Note: We NO LONGER automatically call startAutoExtraction()
// It will be triggered by the sidepanel/popup sending 'START_EXTRACTION_V2'

// Notify popup/sidepanel that content script is ready
// This enables event-driven communication instead of polling
setTimeout(() => {
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }).catch(() => {
    // Ignore error if popup is not open
  });
}, 100);

// ============================================
// 划线功能初始化
// ============================================
// 默认启用划线功能
// 延迟初始化，确保页面 DOM 已就绪
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initHighlighter();
  });
} else {
  // DOM 已就绪，直接初始化
  setTimeout(() => {
    initHighlighter();
  }, 500);
}
}
