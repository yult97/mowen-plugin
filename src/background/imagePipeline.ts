import {
  ImageCandidate,
  ImageFailureReason,
  ImageProcessResult,
  SaveProgress,
} from '../types';
import { uploadImageWithFallback, ImageUploadResult } from '../services/api';
import { GlobalRateLimiter } from '../utils/rateLimiter';
import { sleep } from '../utils/helpers';

interface ImagePipelineDeps {
  imageTimeout: number;
  formatErrorForLog: (error: unknown) => string;
  logToContentScript: (msg: string, tabId?: number) => void;
  waitForTaskRunnable: (tabId: number, taskId: string, progress?: SaveProgress) => Promise<'running' | 'cancelled'>;
  sendProgressUpdate: (progress: {
    type: 'uploading_images' | 'creating_note';
    uploadedImages?: number;
    totalImages?: number;
    currentPart?: number;
    totalParts?: number;
  }, tabId: number, taskId: string) => void;
}

export async function fetchImageBlobFromContentScript(
  imageUrl: string,
  tabId: number
): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    if (!tabId) {
      return null;
    }

    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'FETCH_IMAGE', payload: { url: imageUrl } }),
      new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Timeout' }), 10000)
      ),
    ]) as { success: boolean; data?: { base64: string; mimeType: string }; error?: string };

    if (!response?.success || !response.data) {
      return null;
    }

    let pureBase64 = response.data.base64;
    if (pureBase64.startsWith('data:')) {
      const commaIdx = pureBase64.indexOf(',');
      if (commaIdx > 0) {
        pureBase64 = pureBase64.substring(commaIdx + 1);
      }
    }

    const binaryString = atob(pureBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return {
      blob: new Blob([bytes], { type: response.data.mimeType || 'image/jpeg' }),
      mimeType: response.data.mimeType || 'image/jpeg',
    };
  } catch {
    return null;
  }
}

function decodeDataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';

  try {
    if (isBase64) {
      const binaryString = atob(payload);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return {
        blob: new Blob([bytes], { type: mimeType }),
        mimeType,
      };
    }

    return {
      blob: new Blob([decodeURIComponent(payload)], { type: mimeType }),
      mimeType,
    };
  } catch {
    return null;
  }
}

async function processImageWithBlob(
  apiKey: string,
  image: ImageCandidate,
  imageTimeout: number,
  fetchBlobFn: () => Promise<{ blob: Blob; mimeType: string } | null>
): Promise<ImageProcessResult> {
  const imageIndex = image.order + 1;

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
          }), imageTimeout)
        ),
      ]);
    } catch {
      return {
        id: image.id,
        originalUrl: image.url,
        success: false,
        failureReason: 'TIMEOUT_OR_NET',
      };
    }

    if (result.success && result.uuid) {
      return {
        id: image.id,
        originalUrl: image.url,
        success: true,
        assetUrl: result.url,
        fileId: result.fileId,
        uid: result.uuid,
      };
    }

    let failureReason: ImageFailureReason = 'UNKNOWN';
    if (result.degradeReason) {
      if (result.degradeReason.includes('timeout')) failureReason = 'TIMEOUT_OR_NET';
      else if (result.degradeReason.includes('blob')) failureReason = 'CORS_OR_BLOCKED';
    }

    return {
      id: image.id,
      originalUrl: image.url,
      success: false,
      failureReason,
    };
  } catch {
    return {
      id: image.id,
      originalUrl: image.url,
      success: false,
      failureReason: 'UNKNOWN',
    };
  }
}

/**
 * 图片处理流水线：
 * 前半段并发抓取，后半段严格串行上传，避免突破全局限流。
 */
export async function processImages(
  apiKey: string,
  images: ImageCandidate[],
  tabId: number,
  taskId: string,
  signal: AbortSignal,
  deps: ImagePipelineDeps
): Promise<ImageProcessResult[]> {
  const {
    imageTimeout,
    formatErrorForLog,
    logToContentScript,
    waitForTaskRunnable,
    sendProgressUpdate,
  } = deps;

  const totalImages = images.length;
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

  const FETCH_CONCURRENCY = 3;
  const fetchResults: ({ blob: Blob; mimeType: string } | null)[] = new Array(totalImages);
  let fetchCursor = 0;

  const fetchNext = async () => {
    if (signal.aborted) return;

    const index = fetchCursor++;
    if (index >= totalImages) return;

    const image = images[index];
    const imageIndex = index + 1;

    try {
      const fetchBlobFn = async (): Promise<{ blob: Blob; mimeType: string } | null> => {
        if (image.normalizedUrl.startsWith('data:')) {
          return decodeDataUrlToBlob(image.normalizedUrl);
        }

        const normalizedResult = await fetchImageBlobFromContentScript(image.normalizedUrl, tabId);
        if (normalizedResult) {
          return normalizedResult;
        }

        if (image.normalizedUrl !== image.url) {
          return fetchImageBlobFromContentScript(image.url, tabId);
        }

        return null;
      };

      fetchResults[index] = await fetchBlobFn();
    } catch (error) {
      console.error(`[img] Fetch blob ${imageIndex} error: ${formatErrorForLog(error)}`);
      fetchResults[index] = null;
    }

    await fetchNext();
  };

  const fetchPromises: Promise<void>[] = [];
  for (let i = 0; i < Math.min(FETCH_CONCURRENCY, totalImages); i++) {
    fetchPromises.push(fetchNext());
  }

  for (let i = 0; i < totalImages; i++) {
    const runnableState = await waitForTaskRunnable(tabId, taskId, pausedProgress(i));
    if (runnableState === 'cancelled') {
      break;
    }

    if (signal.aborted) {
      logToContentScript('⚠️ 用户取消，停止图片上传', tabId);
      break;
    }

    const image = images[i];
    const imageIndex = i + 1;

    while (fetchResults[i] === undefined && !signal.aborted) {
      await sleep(50);
    }

    logToContentScript(`🖼️ 上传图片 ${imageIndex}/${totalImages}...`, tabId);

    try {
      const blobData = fetchResults[i] || null;
      const preFetchedFn = async () => blobData;
      const result = await GlobalRateLimiter.schedule(async () => (
        processImageWithBlob(apiKey, image, imageTimeout, preFetchedFn)
      ));

      results[i] = result;

      if (result.success) {
        logToContentScript(`✅ [${imageIndex}/${totalImages}] 上传成功`, tabId);
      } else {
        logToContentScript(`❌ [${imageIndex}/${totalImages}] 上传失败: ${result.failureReason}`, tabId);
      }
    } catch (error) {
      console.error(`[img] Upload ${imageIndex} exception: ${formatErrorForLog(error)}`);
      results[i] = {
        id: image.id,
        originalUrl: image.url,
        success: false,
        failureReason: 'UNKNOWN',
      };
    }

    sendProgressUpdate({
      type: 'uploading_images',
      uploadedImages: imageIndex,
      totalImages,
    }, tabId, taskId);
  }

  await Promise.all(fetchPromises);
  return results.filter((result) => result !== undefined);
}

export async function processImage(
  apiKey: string,
  image: ImageCandidate,
  imageTimeout: number
): Promise<ImageProcessResult> {
  console.warn('Deprecated processImage called without tabId');
  return processImageWithBlob(apiKey, image, imageTimeout, async () => null);
}
