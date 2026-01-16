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
  clearCache,
} from './extractor';
import { fetchImageAsBase64 } from './imageFetcher';

// State to prevent duplicate scheduled extractions
let extractScheduled = false;

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[content] Received message:', message.type);

  // PING: Health check
  if (message.type === 'PING') {
    sendResponse({ success: true, status: 'ready' });
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

    // No cache, trigger extraction
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
        console.log('[content] ❌ FETCH_IMAGE error:', error.message);
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

  // Unknown message types
  return false;
});

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
    extractContent().catch((err) => {
      console.error('[content] ❌ Auto-extraction failed:', err);
    });
  }, 1500);
}

/**
 * Initialize auto-extraction on page load.
 */
function initializeAutoExtraction(): void {
  console.log('[content] 🎯 Initializing auto-extraction, readyState:', document.readyState);

  const triggerExtraction = (): void => {
    setTimeout(() => {
      extractContent().catch((err) => {
        console.error('[content] ❌ Initial extraction failed:', err);
      });
    }, 2000);
  };

  if (document.readyState === 'complete') {
    console.log('[content] ✅ Page already loaded');
    triggerExtraction();
  } else {
    console.log('[content] ⏳ Waiting for page load...');
    window.addEventListener('load', () => {
      console.log('[content] ✅ Page load event fired');
      triggerExtraction();
    });
  }

  // Watch for dynamic content changes
  console.log('[content] 👁️ Setting up MutationObserver');
  const observer = new MutationObserver((mutations) => {
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

  console.log('[content] ✅ Auto-extraction initialized');
}

// Initialize
console.log('[墨问笔记助手] Content script loaded');
console.log('[content] Page URL:', window.location.href);
initializeAutoExtraction();
