console.log('[墨问 Background] 🏁 Service Worker Script Loaded');
import {
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NotePart,
  NoteCreateResult,
  ImageFailureReason,
} from '../types';
import { getSettings } from '../utils/storage';
import { formatDate, debugLog, sleep } from '../utils/helpers';
import { createNote, uploadImageWithFallback, ImageUploadResult } from '../services/api';

const SAFE_LIMIT = 19000;
const MAX_RETRY_ROUNDS = 3;
const IMAGE_TIMEOUT = 30000;  // 30 seconds per image (increased for local upload)

// Cancel mechanism for save operation
let isCancelRequested = false;
let saveAbortController: AbortController | null = null;

interface SaveNotePayload {
  extractResult: ExtractResult;
  isPublic: boolean;
  includeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
}

// Helper to proxy logs to Content Script console for debugging
async function logToContentScript(msg: string) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'LOG_DEBUG', payload: `[BG] ${msg}` }).catch(() => { });
    }
  } catch { }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[墨问 Background] Received message:', message.type);

  if (message.type === 'PING') {
    console.log('[墨问 Background] 🏓 PING received');
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

  const { extractResult, isPublic, includeImages, maxImages, createIndexNote } = payload;

  // Reset cancel flag and create new AbortController
  isCancelRequested = false;
  saveAbortController = new AbortController();

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
      const imagesToLink = images.slice(maxImages);

      // Upload images with concurrency control
      imageResults = await processImages(settings.apiKey, imagesToProcess);

      // Replace image URLs in content
      processedContent = replaceImageUrls(processedContent, imageResults, imagesToLink);

      // Debug: Log processed content to verify img tags have data-mowen-uid
      const imgTagsWithUid = processedContent.match(/<img[^>]*data-mowen-uid[^>]*>/gi);
      logToContentScript(`🔍 处理后的图片标签数: ${imgTagsWithUid?.length || 0}`);
      if (imgTagsWithUid && imgTagsWithUid.length > 0) {
        logToContentScript(`🔍 第一个图片标签: ${imgTagsWithUid[0].substring(0, 150)}`);
      } else {
        // Check for any img tags
        const allImgTags = processedContent.match(/<img[^>]*>/gi);
        logToContentScript(`⚠️ 无 data-mowen-uid 图片, 总图片标签数: ${allImgTags?.length || 0}`);
        if (allImgTags && allImgTags.length > 0) {
          logToContentScript(`⚠️ 第一个图片标签: ${allImgTags[0].substring(0, 150)}`);
        }
      }
    } else if (images.length > 0) {
      // Convert all images to links
      processedContent = convertAllImagesToLinks(processedContent, images);
    }

    // Step 2: Add metadata header
    const metaHeader = createMetaHeader(extractResult);
    processedContent = metaHeader + processedContent;

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
          result = await createNote(settings.apiKey, part.title, part.content, isPublic, logToContentScript, extractResult.sourceUrl);
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
    if (createIndexNote && parts.length > 1 && createdNotes.length > 1) {
      console.log('[墨问 Background] Creating index note...');
      const indexContent = createIndexNoteContent(
        extractResult.title,
        extractResult.sourceUrl,
        createdNotes
      );
      const indexResult = await createNote(
        settings.apiKey,
        `${extractResult.title}（合集）`,
        indexContent,
        isPublic,
        undefined,
        extractResult.sourceUrl
      );

      if (indexResult.success) {
        createdNotes.unshift({
          partIndex: -1,
          noteUrl: indexResult.noteUrl!,
          noteId: indexResult.noteId!,
          isIndex: true,
        });
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.log(`[img] fetchBlob: no active tab`);
      return null;
    }

    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_IMAGE', payload: { url: imageUrl } }),
      new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Timeout' }), 15000)
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

// Image processing functions - using serial processing to respect API rate limits
async function processImages(
  apiKey: string,
  images: ImageCandidate[]
): Promise<ImageProcessResult[]> {
  console.log(`[img] ========== START PROCESSING ${images.length} IMAGES ==========`);
  logToContentScript(`🖼️ 开始处理 ${images.length} 张图片...`);

  const results: ImageProcessResult[] = [];
  const totalImages = images.length;

  // Process images serially to respect API rate limiting
  for (let i = 0; i < images.length; i++) {
    // Check if cancel was requested
    if (isCancelRequested) {
      console.log('[img] ⚠️ Cancel requested, stopping image processing');
      logToContentScript('⚠️ 用户取消，停止图片上传');
      break;
    }

    const image = images[i];
    const imageIndex = i + 1;

    console.log(`[img] processing ${imageIndex}/${totalImages}: ${image.url.substring(0, 50)}...`);
    logToContentScript(`🖼️ 处理图片 ${imageIndex}/${totalImages}...`);

    try {
      const result = await processImage(apiKey, image);
      results.push(result);

      if (result.success) {
        logToContentScript(`✅ 图片 ${imageIndex} 上传成功, uid=${result.uid || 'N/A'}`);
      } else {
        logToContentScript(`❌ 图片 ${imageIndex} 上传失败: ${result.failureReason || 'unknown'}`);
      }

      sendProgressUpdate({
        type: 'uploading_images',
        uploadedImages: imageIndex,
        totalImages,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[img] processImage ${imageIndex} exception:`, err);
      logToContentScript(`❌ 图片 ${imageIndex} 处理异常: ${errMsg}`);
      results.push({
        id: image.id,
        originalUrl: image.url,
        success: false,
        failureReason: 'UNKNOWN',
      });
    }
  }

  // Summary logging
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  console.log(`[img] ========== DONE: success=${successCount} failed=${failCount} ==========`);
  logToContentScript(`🖼️ 图片处理完成: 成功=${successCount}, 失败=${failCount}`);

  return results;
}

async function processImage(
  apiKey: string,
  image: ImageCandidate
): Promise<ImageProcessResult> {
  const imageIndex = image.order + 1;

  try {
    // Create blob fetch function for this image
    const fetchBlobFn = async (): Promise<{ blob: Blob; mimeType: string } | null> => {
      return fetchImageBlobFromCS(image.url);
    };

    // Use uploadImageWithFallback with timeout
    let result: ImageUploadResult;
    try {
      result = await Promise.race([
        uploadImageWithFallback(apiKey, image.url, imageIndex, fetchBlobFn),
        new Promise<ImageUploadResult>((resolve) =>
          setTimeout(() => resolve({
            success: false,
            uploadMethod: 'degraded',
            degradeReason: 'timeout',
          }), IMAGE_TIMEOUT)
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
        fileId: result.fileId, // This is the correct file ID (ends with -TMP)
        uid: result.uuid,      // Use uuid (which is fileId) for the uid field used by replaceImageUrls
      };
    }

    // Map degradeReason to ImageFailureReason
    let failureReason: ImageFailureReason = 'UNKNOWN';
    if (result.degradeReason) {
      if (result.degradeReason.includes('timeout')) {
        failureReason = 'TIMEOUT_OR_NET';
      } else if (result.degradeReason.includes('size')) {
        failureReason = 'UNKNOWN'; // Size limit exceeded
      } else if (result.degradeReason.includes('blob')) {
        failureReason = 'CORS_OR_BLOCKED';
      }
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

function replaceImageUrls(
  content: string,
  imageResults: ImageProcessResult[],
  extraImages: ImageCandidate[]
): string {
  let processed = content;
  let successCount = 0;
  let failCount = 0;

  console.log(`[sw] replaceImageUrls: processing ${imageResults.length} results`);

  // Replace successfully uploaded images
  for (let i = 0; i < imageResults.length; i++) {
    const result = imageResults[i];
    const imageIndex = i + 1; // 1-based index for display

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

      // Strategy 1: Try exact URL match first
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

      if (!matched) {
        console.warn(`[sw] replaceImageUrls: NO MATCH for url=${originalUrl.substring(0, 80)}`);
      }
    } else if (!result.success) {
      failCount++;
      // Convert failed images to links with actual image position
      processed = convertImageToLink(processed, result.originalUrl, String(imageIndex));
    } else {
      // Missing uid or assetUrl but success=true - this shouldn't happen
      console.warn(`[sw] replaceImageUrls: success=true but missing uid or assetUrl`, result);
    }
  }

  // Convert extra images (beyond maxImages) to links
  extraImages.forEach((img, index) => {
    processed = convertImageToLink(processed, img.url, String(index + imageResults.length + 1));
  });

  console.log(`[sw] image replace done: success=${successCount}, failed=${failCount}, converted_to_link=${extraImages.length}`);

  return processed;
}


function convertImageToLink(content: string, imageUrl: string, index: string): string {
  const escapedUrl = escapeRegExp(imageUrl);
  const linkHtml = `<p><a href="${imageUrl}" target="_blank" rel="noopener noreferrer">📷 图片链接（原文第 ${index} 张）：打开图片</a></p>`;

  // Try to replace the img tag
  const imgRegex = new RegExp(`<img[^>]*src=["']${escapedUrl}["'][^>]*>`, 'gi');
  if (imgRegex.test(content)) {
    return content.replace(imgRegex, linkHtml);
  }

  return content;
}

function convertAllImagesToLinks(content: string, images: ImageCandidate[]): string {
  let processed = content;
  images.forEach((img, index) => {
    processed = convertImageToLink(processed, img.url, String(index + 1));
  });
  return processed;
}

function createMetaHeader(_extractResult: ExtractResult): string {
  // User preference: only include title and body content, no metadata
  return '';
}

function splitContent(
  originalTitle: string,
  content: string,
  limit: number
): NotePart[] {
  const textLength = getTextLengthFromHtml(content);

  if (textLength <= limit) {
    return [
      {
        index: 0,
        total: 1,
        title: originalTitle,
        content,
      },
    ];
  }

  const parts: NotePart[] = [];
  const chunks = splitHtmlByLength(content, limit);

  chunks.forEach((chunk, index) => {
    parts.push({
      index,
      total: chunks.length,
      title: `${originalTitle}（${index + 1}/${chunks.length}）`,
      content: chunk,
    });
  });

  return parts;
}

function splitHtmlByLength(html: string, maxLength: number): string[] {
  const chunks: string[] = [];

  // Split HTML while preserving tag structure (Service Worker compatible)
  // This is a simplified approach that splits by block-level elements
  let currentChunk = '';
  let currentLength = 0;

  // Split by block-level tags
  const blocks = html.split(/(<\/?(?:h[1-6]|p|div|li|blockquote|pre|ul|ol|hr)[^>]*>)/gi);

  for (const block of blocks) {
    // Skip empty strings
    if (!block) continue;

    // Extract text from this block
    const textLength = stripHtmlTags(block).length;

    // Check if adding this block would exceed the limit
    if (currentLength + textLength > maxLength && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
      currentLength = 0;
    }

    currentChunk += block;
    currentLength += textLength;
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [html];
}

function getTextLengthFromHtml(html: string): number {
  // Pure string-based HTML text extraction (Service Worker compatible)
  return stripHtmlTags(html).length;
}

/**
 * Remove HTML tags from string using regex
 * This replaces DOMParser for Service Worker compatibility
 */
function stripHtmlTags(html: string): string {
  // Remove script tags and their content
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove style tags and their content
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Remove all other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  text = decodeHtmlEntities(text);
  return text.trim();
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&euro;': '€',
    '&pound;': '£',
    '&yen;': '¥',
    '&cent;': '¢',
  };
  return text.replace(/&[a-zA-Z0-9#]+;/g, (entity) => entities[entity] || entity);
}

function createIndexNoteContent(
  _title: string,
  _sourceUrl: string,
  notes: Array<{ partIndex: number; noteUrl: string; shareUrl?: string; isIndex?: boolean }>
): string {
  const partNotes = notes.filter((n) => !n.isIndex).sort((a, b) => a.partIndex - b.partIndex);

  // Note: Title and source link are added automatically by createNote()
  // So we only generate the list of parts here
  // Use noteUrl which respects public/private setting (/detail/ for public, /editor/ for private)
  let content = `<p>共拆分为 ${partNotes.length} 篇笔记：</p>\n`;
  content += '<ul>\n';

  partNotes.forEach((note) => {
    content += `<li><a href="${note.noteUrl}" target="_blank">第 ${note.partIndex + 1} 篇</a></li>\n`;
  });

  content += '</ul>\n';
  content += `<p>剪藏时间：${formatDate()}</p>`;

  return content;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Open side panel when clicking the extension icon
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Initialize
console.log('[墨问笔记助手] Background service worker started');
