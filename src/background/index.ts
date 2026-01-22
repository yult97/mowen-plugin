console.log('[墨问 Background] 🏁 Service Worker Script Loaded');
import {
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NotePart,
  NoteCreateResult,
  ImageFailureReason,
} from '../types';
import { getSettings, saveSettings } from '../utils/storage';
import { debugLog, sleep } from '../utils/helpers';

import { createNote, createNoteWithBody, uploadImageWithFallback, ImageUploadResult } from '../services/api';
import { LIMITS, backgroundLogger as logger } from '../utils/constants';

const SAFE_LIMIT = LIMITS.SAFE_CONTENT_LENGTH;
const MAX_RETRY_ROUNDS = LIMITS.MAX_RETRY_ROUNDS;
const IMAGE_TIMEOUT = LIMITS.IMAGE_UPLOAD_TIMEOUT;

// Cancel mechanism for save operation
let isCancelRequested = false;
let saveAbortController: AbortController | null = null;

// 缓存活动标签页 ID，避免处理图片时标签页失去焦点
let cachedActiveTabId: number | null = null;

// 笔记 API 速率限制器：追踪最后一次调用时间，确保遵守 1 QPS 限制
let lastNoteApiCallTime = 0;
const NOTE_API_MIN_INTERVAL = 1100; // 1.1 秒，留一点余量

/**
 * 智能等待：确保距离上次笔记 API 调用至少间隔 1.1 秒
 * 如果已经过了足够时间，则不等待
 */
async function waitForNoteApiRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNoteApiCallTime;
  if (elapsed < NOTE_API_MIN_INTERVAL && lastNoteApiCallTime > 0) {
    const waitTime = NOTE_API_MIN_INTERVAL - elapsed;
    console.log(`[墨问 Background] ⏱️ API 速率限制：等待 ${waitTime}ms`);
    await sleep(waitTime);
  }
}

/**
 * 记录笔记 API 调用时间
 */
function markNoteApiCall(): void {
  lastNoteApiCallTime = Date.now();
}

// Initialize Side Panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[墨问 Background] ❌ Failed to set side panel behavior:', error));

interface SaveNotePayload {
  extractResult: ExtractResult;
  isPublic: boolean;
  includeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  enableAutoTag?: boolean;  // 是否自动添加「墨问剪藏」标签
}

// Helper to proxy logs to Content Script console for debugging
async function logToContentScript(msg: string): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'LOG_DEBUG', payload: `[BG] ${msg}` }).catch((error) => {
        // Silently ignore - content script may not be available
        if (chrome.runtime.lastError) {
          // Clear the error to prevent "unchecked lastError" warnings
          void chrome.runtime.lastError;
        }
        logger.debug('Log proxy to content script failed:', error instanceof Error ? error.message : 'Unknown');
      });
    }
  } catch (error) {
    // Tab query failed - popup may have closed
    logger.debug('logToContentScript failed:', error instanceof Error ? error.message : 'Unknown');
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
    console.log('[墨问 Background] ❌ CANCEL_SAVE received');
    isCancelRequested = true;
    // Abort any in-flight requests
    if (saveAbortController) {
      saveAbortController.abort();
      console.log('[墨问 Background] 🛑 AbortController.abort() called');
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
      return;
    }

    // Send immediate acknowledgment to prevent message channel timeout
    sendResponse({ success: true, acknowledged: true });

    // Process save asynchronously without blocking the message channel
    console.log('[墨问 Background] ⏳ Calling handleSaveNote...');
    try {
      handleSaveNote(message.payload)
        .then((result) => {
          console.log('[墨问 Background] 📤 Sending SAVE_NOTE_COMPLETE:', result.success);
          // Send result via a separate message to popup
          chrome.runtime.sendMessage({
            type: 'SAVE_NOTE_COMPLETE',
            result,
          }).catch((err) => {
            // Popup might be closed, log for debugging
            console.error('[墨问 Background] ❌ Failed to send SAVE_NOTE_COMPLETE:', err);
            console.error('[墨问 Background] This is normal if the popup was closed');
          });
        })
        .catch((error) => {
          console.error('[墨问 Background] ❌ Save process failed:', error);
          // Send error via a separate message to popup
          chrome.runtime.sendMessage({
            type: 'SAVE_NOTE_COMPLETE',
            result: {
              success: false,
              error: error.message || 'Unknown error',
            },
          }).catch((err) => {
            console.error('[墨问 Background] ❌ Failed to send SAVE_NOTE_COMPLETE error:', err);
            console.error('[墨问 Background] This is normal if the popup was closed');
          });
        });
    } catch (e) {
      console.error('[墨问 Background] ❌ CRITICAL: Synchronous error calling handleSaveNote:', e);
    }

    // Return false as we're not using sendResponse asynchronously anymore
    return false;
  }

  if (message.type === 'TEST_CONNECTION') {
    import('../services/api').then(async ({ testConnection }) => {
      const result = await testConnection(message.payload.apiKey);
      // Safely send response, checking if channel is still open
      try {
        sendResponse(result);
      } catch (e) {
        // Channel already closed, ignore
        debugLog('TEST_CONNECTION: Channel closed, could not send response');
      }
      // Clear lastError to prevent warning
      void chrome.runtime.lastError;
    }).catch((error) => {
      try {
        sendResponse({ success: false, error: error.message });
      } catch (e) {
        // Channel already closed, ignore
        debugLog('TEST_CONNECTION: Channel closed, could not send error response');
      }
      // Clear lastError to prevent warning
      void chrome.runtime.lastError;
    });

    // Keep message channel open
    return true;
  }

  // For unknown message types, don't keep channel open
  return false;
});

async function handleSaveNote(payload: SaveNotePayload): Promise<{
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

  console.log('[墨问 Background] 🚀 handleSaveNote started');
  logToContentScript('🚀 handleSaveNote started');

  let settings;
  try {
    settings = await getSettings();
    console.log('[墨问 Background] ✅ Settings loaded');
    logToContentScript('✅ Settings loaded');
  } catch (err) {
    console.error('[墨问 Background] ❌ Failed to load settings:', err);
    return { success: false, error: '无法加载设置', errorCode: 'SETTINGS_ERROR' };
  }

  const { extractResult, isPublic, includeImages, maxImages, createIndexNote, enableAutoTag } = payload;

  // Reset cancel flag and create new AbortController
  isCancelRequested = false;
  saveAbortController = new AbortController();

  // 在处理开始时缓存活动标签页 ID，避免后续图片处理时标签页失去焦点
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    cachedActiveTabId = activeTab?.id ?? null;
    console.log(`[墨问 Background] 📌 缓存活动标签页 ID: ${cachedActiveTabId}`);
  } catch (e) {
    cachedActiveTabId = null;
    console.log(`[墨问 Background] ⚠️ 无法获取活动标签页 ID`);
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
      logToContentScript(`🖼️ Found ${images.length} images, processing...`);
      const imagesToProcess = images.slice(0, maxImages);
      // const imagesToLink = images.slice(maxImages); // Unused currently, removed to fix lint error
      // If we want to use it: const imagesToLink = ...; and pass to replaceImageUrls if needed but currently replaceImageUrls ignores extraImages

      // Upload images with concurrency control
      imageResults = await processImages(settings.apiKey, imagesToProcess);

      // Replace image URLs in content (for images that exist in contentHtml)
      processedContent = replaceImageUrls(processedContent, imageResults, []);

      // Inject uploaded images that weren't matched (e.g., when contentHtml doesn't have img tags)
      processedContent = injectUploadedImages(processedContent, imageResults);

      // Debug: Log processed content to verify img tags have data-mowen-uid
      const imgTagsWithUid = processedContent.match(/<img[^>]*data-mowen-uid[^>]*>/gi);
      logToContentScript(`🔍 处理后的图片标签数: ${imgTagsWithUid?.length || 0}`);
    } else if (images.length > 0) {
      // 包含图片开关关闭：移除所有 img 标签（不转换为链接）
      processedContent = removeAllImageTags(processedContent);
      console.log(`[墨问 Background] 🚫 包含图片已关闭，移除 ${images.length} 张图片`);
    }

    // Step 2: Add metadata header - REMOVED per user request
    // processedContent = metaHeader + processedContent;
    // Keeping processedContent as is


    // Step 3: Split content if needed
    const parts = splitContent(
      extractResult.title,
      processedContent,
      SAFE_LIMIT
    );

    // Step 4: Create notes
    console.log(`[note] create start title="${extractResult.title.substring(0, 30)}..." partsCount=${parts.length}`);
    logToContentScript(`创建 ${parts.length} 篇笔记...`);
    const createdNotes: Array<{ partIndex: number; noteUrl: string; noteId: string; shareUrl?: string; isIndex?: boolean }> = [];

    for (const part of parts) {
      // Send progress update
      try {
        sendProgressUpdate({
          type: 'creating_note',
          currentPart: part.index + 1,
          totalParts: parts.length,
        });
      } catch (err) { /* ignore */ }

      let result: NoteCreateResult = { success: false, error: 'Not executed', errorCode: 'UNKNOWN' };
      let retryCount = 0;
      let success = false;

      // Retry loop
      while (retryCount < MAX_RETRY_ROUNDS) {
        retryCount++;
        console.log(`[note] part ${part.index + 1}/${parts.length} attempt ${retryCount}`);
        logToContentScript(`📝 正在创建第 ${part.index + 1}/${parts.length} 部分 (第 ${retryCount} 次尝试)...`);

        try {
          // Pass logToContentScript to createNote so internal logs are visible to user
          result = await createNote(settings.apiKey, part.title, part.content, isPublic, logToContentScript, extractResult.sourceUrl, enableAutoTag);
        } catch (apiErr) {
          const errMsg = apiErr instanceof Error ? apiErr.message : 'Exception';
          console.log(`[note] part ${part.index + 1} exception: ${errMsg}`);
          logToContentScript(`❌ 创建异常: ${errMsg}`);
          result = {
            success: false,
            error: errMsg,
            errorCode: 'EXCEPTION'
          };
        }

        if (result.success) {
          success = true;
          markNoteApiCall(); // 记录 API 调用时间，用于速率限制
          console.log(`[note] create ok noteId=${result.noteId} url=${result.noteUrl}`);
          logToContentScript(`✅ 第 ${part.index + 1} 部分创建成功: ${result.noteUrl}`);
          createdNotes.push({
            partIndex: part.index,
            noteUrl: result.noteUrl!,
            noteId: result.noteId!,
            shareUrl: result.shareUrl!,  // For collection links
          });
          break; // Success, exit retry loop
        } else {
          console.log(`[note] part ${part.index + 1} fail: ${result.error} code=${result.errorCode}`);
          logToContentScript(`⚠️ 第 ${part.index + 1} 部分失败: ${result.error}`);
          // If content too long, logic for splitting further would go here
          // Simplified: just wait and retry
          if (retryCount < MAX_RETRY_ROUNDS) {
            logToContentScript(`⏳ 等待 ${(1000 * retryCount) / 1000} 秒后重试...`);
            await sleep(1000 * retryCount);
          }
        }
      }

      if (!success) {
        console.error(`[note] part ${part.index + 1} FAILED after ${MAX_RETRY_ROUNDS} retries`);
        logToContentScript(`❌ 第 ${part.index + 1} 部分在重试后仍然失败，放弃。`);
      }
    }

    // Step 5: Create index note if multiple parts and enabled
    console.log(`[墨问 Background] 🔍 合集创建条件检查: createIndexNote=${createIndexNote}, parts.length=${parts.length}, createdNotes.length=${createdNotes.length}`);
    logToContentScript(`🔍 合集检查: 开关=${createIndexNote}, 分块=${parts.length}, 成功=${createdNotes.length}`);

    if (createIndexNote && parts.length > 1 && createdNotes.length > 1) {
      console.log('[墨问 Background] Creating index note with internal links...');
      logToContentScript('📚 正在创建合集笔记（内链格式）...');

      // 智能等待：确保遵守 API 速率限制
      await waitForNoteApiRateLimit();

      // 使用内链笔记格式构建合集 body
      const indexBody = createIndexNoteAtom(
        extractResult.title,
        extractResult.sourceUrl,
        createdNotes
      );

      const indexResult = await createNoteWithBody(
        settings.apiKey,
        indexBody,
        isPublic,
        enableAutoTag
      );

      if (indexResult.success) {
        markNoteApiCall(); // 记录 API 调用时间，用于速率限制
        createdNotes.unshift({
          partIndex: -1,
          noteUrl: indexResult.noteUrl!,
          noteId: indexResult.noteId!,
          isIndex: true,
        });
        logToContentScript('✅ 合集笔记创建成功');
      } else {
        // 合集创建失败不阻断整体流程，但要记录错误
        console.error('[墨问 Background] ❌ 合集笔记创建失败:', indexResult.error);
        logToContentScript(`⚠️ 合集笔记创建失败: ${indexResult.error || '未知错误'}`);
      }
    }

    console.log('[墨问 Background] 📊 Final note count:', createdNotes.length);

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

    return {
      success: true,
      notes: createdNotes.map((n) => ({
        partIndex: n.partIndex,
        noteUrl: n.noteUrl,
        isIndex: n.isIndex,
      })),
    };
  } catch (error) {
    console.error('[墨问 Background] ❌ Save process failed with exception:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
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
}) {
  chrome.runtime.sendMessage({
    type: 'SAVE_NOTE_PROGRESS',
    progress,
  }).catch(() => {
    // Popup might be closed, ignore error
  });
}

/**
 * Fetch image blob from Content Script
 * This allows us to get the image data with the page's credentials/cookies
 */
async function fetchImageBlobFromCS(imageUrl: string): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    // 优先使用缓存的标签页 ID，避免处理过程中标签页失去焦点
    let tabId = cachedActiveTabId;
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id ?? null;
    }
    if (!tabId) {
      console.log(`[img] fetchBlob: no active tab (cached=${cachedActiveTabId})`);
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
  images: ImageCandidate[]
): Promise<ImageProcessResult[]> {
  console.log(`[img] ========== START PROCESSING ${images.length} IMAGES (Pipeline) ==========`);
  logToContentScript(`🖼️ 开始处理 ${images.length} 张图片 (流水线模式)...`);

  const totalImages = images.length;
  // Initialize results array
  const results: ImageProcessResult[] = new Array(totalImages);

  sendProgressUpdate({
    type: 'uploading_images',
    uploadedImages: 0,
    totalImages,
  });

  // 1. Fetch Queue: Concurrently fetch image blobs from Content Script
  // We limit fetch concurrency to avoid overwhelming the browser/content script
  const FETCH_CONCURRENCY = 3;

  // Helper to process fetch with concurrency limit
  const fetchResults: ({ blob: Blob; mimeType: string } | null)[] = new Array(totalImages);
  let fetchCursor = 0;

  // Function to grab the next image and fetch it
  const fetchNext = async () => {
    if (isCancelRequested) return;

    // Atomically grab an index
    const index = fetchCursor++;
    if (index >= totalImages) return;

    const image = images[index];
    const imageIndex = index + 1;

    try {
      // Logic from processImage's fetchBlobFn extracted here
      const fetchBlobFn = async (): Promise<{ blob: Blob; mimeType: string } | null> => {
        // Try normalized URL first
        const res = await fetchImageBlobFromCS(image.normalizedUrl);
        if (res) return res;
        // Fallback
        if (image.normalizedUrl !== image.url) {
          return fetchImageBlobFromCS(image.url);
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

  // 2. Upload Loop: Strictly Serial & Rate Limited
  // We define a minimum delay between uploads to respect 1 QPS
  const MIN_UPLOAD_INTERVAL = 1100; // ms (slightly > 1s for safety)
  let lastUploadTime = 0;

  for (let i = 0; i < totalImages; i++) {
    if (isCancelRequested) {
      console.log('[img] ⚠️ Cancel requested, stopping uploads');
      logToContentScript('⚠️ 用户取消，停止图片上传');
      break;
    }

    const image = images[i];
    const imageIndex = i + 1;

    // Poll/wait for fetchResults[i] to be ready
    while (fetchCursor <= i && fetchResults[i] === undefined && !isCancelRequested) {
      await new Promise(r => setTimeout(r, 50));
    }

    // Rate Limit Check
    const now = Date.now();
    const timeSinceLast = now - lastUploadTime;
    if (i > 0 && timeSinceLast < MIN_UPLOAD_INTERVAL) {
      const waitTime = MIN_UPLOAD_INTERVAL - timeSinceLast;
      await new Promise(r => setTimeout(r, waitTime));
    }

    logToContentScript(`🖼️ 上传图片 ${imageIndex}/${totalImages}...`);
    lastUploadTime = Date.now();

    try {
      const blobData = fetchResults[i] || null;
      // Construct a fake "fetchBlobFn" that returns the already-fetched data
      const preFetchedFn = async () => blobData;
      // Call processImageWithBlob (helper function)
      const result = await processImageWithBlob(apiKey, image, preFetchedFn);
      results[i] = result;

      if (result.success) {
        logToContentScript(`✅ [${imageIndex}/${totalImages}] 上传成功`);
      } else {
        logToContentScript(`❌ [${imageIndex}/${totalImages}] 上传失败: ${result.failureReason}`);
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
    });
  }

  // Ensure all fetches settle (cleanup)
  await Promise.all(fetchPromises);

  // Summary logging
  const finalResults = results.filter(r => r !== undefined);
  const successCount = finalResults.filter(r => r.success).length;
  const failCount = finalResults.filter(r => !r.success).length;
  console.log(`[img] ========== DONE: success=${successCount} failed=${failCount} ==========`);
  logToContentScript(`🖼️ 图片处理完成: 成功=${successCount}, 失败=${failCount}`);

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

// Wrapper for backward compatibility
export async function processImage(
  apiKey: string,
  image: ImageCandidate
): Promise<ImageProcessResult> {
  const fetchBlobFn = async (): Promise<{ blob: Blob; mimeType: string } | null> => {
    const result = await fetchImageBlobFromCS(image.normalizedUrl);
    if (result) return result;
    if (image.normalizedUrl !== image.url) {
      return fetchImageBlobFromCS(image.url);
    }
    return null;
  };
  return processImageWithBlob(apiKey, image, fetchBlobFn);
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
