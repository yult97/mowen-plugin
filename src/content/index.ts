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
import { fetchImageAsBase64 } from './imageFetcher';
import { ExtractResult } from '../types';
import { initHighlighter } from './highlighter';

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
  if (message.type === 'PING') {
    sendResponse({ success: true, status: 'ready' });
    return false;
  }

  // START_EXTRACTION: Enable observer and trigger extraction
  if (message.type === 'START_EXTRACTION') {
    console.log('[content] 🚀 START_EXTRACTION received');
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
  if (message.type === 'STOP_EXTRACTION') {
    console.log('[content] 🛑 STOP_EXTRACTION received');
    stopAutoExtraction();
    sendResponse({ success: true });
    return false;
  }

  // GET_CACHED_CONTENT: Return cached content if available
  if (message.type === 'GET_CACHED_CONTENT') {
    console.log('[content] 💾 GET_CACHED_CONTENT request');
    const cached = getCachedResult();
    const isExtracting = isExtractingContent();

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
  if (message.type === 'FETCH_IMAGE') {
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
    console.log(`[🔍 Extension Log] ${message.payload}`);
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
    ? (result.isAppend ? '✓ 已追加到划线笔记' : '✓ 已创建划线笔记')
    : (result.error || '保存失败');

  let html = `
    <span class="mowen-toast-icon">${result.success ? '✓' : '✕'}</span>
    <span class="mowen-toast-message">${message}</span>
  `;

  if (result.success && result.noteUrl) {
    html += `<a href="${result.noteUrl}" target="_blank" class="mowen-toast-link">查看笔记 →</a>`;
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
 * 注入 Toast 样式
 */
function injectToastStyles(): void {
  if (document.getElementById('mowen-toast-styles')) return;

  const style = document.createElement('style');
  style.id = 'mowen-toast-styles';
  style.textContent = `
    .mowen-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: rgba(31, 41, 55, 0.95);
      backdrop-filter: blur(10px);
      color: #FFFFFF;
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
      animation: mowen-toast-in 0.3s ease-out forwards;
    }
    @keyframes mowen-toast-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .mowen-toast-out {
      animation: mowen-toast-out 0.2s ease-in forwards;
    }
    @keyframes mowen-toast-out {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(10px); }
    }
    .mowen-toast-link {
      color: #60A5FA;
      text-decoration: none;
      margin-left: 8px;
    }
    .mowen-toast-link:hover { text-decoration: underline; }
    .mowen-toast.success .mowen-toast-icon { color: #34D399; }
    .mowen-toast.error .mowen-toast-icon { color: #F87171; }
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
      if (mutation.type !== 'childList') return false;

      return mutation.addedNodes.length > 0 &&
        Array.from(mutation.addedNodes).some((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            return !['SCRIPT', 'STYLE', 'IFRAME'].includes(el.tagName) &&
              (el.children.length > 0 || (el.textContent?.length || 0) > 50);
          }
          return false;
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
// It will be triggered by the sidepanel/popup sending 'START_EXTRACTION'

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
