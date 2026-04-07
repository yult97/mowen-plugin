import {
  ContentBlock,
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NoteCreateResult,
  SaveProgress,
} from '../types';
import { createNote, createNoteWithBody } from '../services/api';
import { GlobalRateLimiter } from '../utils/rateLimiter';
import { sleep } from '../utils/helpers';

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

export interface NoteSplitPart {
  index: number;
  total: number;
  title: string;
  content?: string;
  body?: NoteAtomDoc;
  isIndex?: boolean;
}

interface CreatedNote {
  partIndex: number;
  noteUrl: string;
  noteId: string;
  shareUrl?: string;
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

export async function prepareContentForSave(params: {
  extractResult: ExtractResult;
  includeImages: boolean;
  maxImages: number;
  apiKey: string;
  tabId: number;
  taskId: string;
  signal: AbortSignal;
  processImages: (
    apiKey: string,
    images: ImageCandidate[],
    tabId: number,
    taskId: string,
    signal: AbortSignal
  ) => Promise<ImageProcessResult[]>;
  replaceImageUrls: (content: string, imageResults: ImageProcessResult[], extraImages: ImageCandidate[]) => string;
  injectUploadedImages: (content: string, imageResults: ImageProcessResult[]) => string;
  removeAllImageTags: (content: string) => string;
  logToContentScript: (msg: string, tabId?: number) => void;
}): Promise<{
  processedContent: string;
  processedBlocks: ContentBlock[];
  imageResults: ImageProcessResult[];
}> {
  const {
    extractResult,
    includeImages,
    maxImages,
    apiKey,
    tabId,
    taskId,
    signal,
    processImages,
    replaceImageUrls,
    injectUploadedImages,
    removeAllImageTags,
    logToContentScript,
  } = params;

  let processedContent = extractResult.contentHtml;
  let processedBlocks = (extractResult.blocks || []).map((block) => ({ ...block }));
  let imageResults: ImageProcessResult[] = [];
  const images = extractResult.images || [];

  if (includeImages && images.length > 0) {
    logToContentScript(`🖼️ Found ${images.length} images, processing...`, tabId);
    const imagesToProcess = images.slice(0, maxImages);
    const extraImages = images.slice(maxImages);

    imageResults = await processImages(apiKey, imagesToProcess, tabId, taskId, signal);
    processedContent = replaceImageUrls(processedContent, imageResults, extraImages);
    processedContent = injectUploadedImages(processedContent, imageResults);
    processedBlocks = processedBlocks.map((block) => ({
      ...block,
      html: injectUploadedImages(replaceImageUrls(block.html, imageResults, extraImages), imageResults),
    }));

    const imgTagsWithUid = processedContent.match(/<img[^>]*data-mowen-uid[^>]*>/gi);
    logToContentScript(`🔍 处理后的图片标签数: ${imgTagsWithUid?.length || 0}`, tabId);
  } else if (images.length > 0) {
    processedContent = removeAllImageTags(processedContent);
    processedBlocks = processedBlocks.map((block) => ({
      ...block,
      html: removeAllImageTags(block.html),
    }));
  }

  return { processedContent, processedBlocks, imageResults };
}

export async function createSplitNotes(params: {
  parts: NoteSplitPart[];
  maxRetryRounds: number;
  tabId: number;
  taskId: string;
  signal: AbortSignal;
  apiKey: string;
  isPublic: boolean;
  enableAutoTag?: boolean;
  sourceUrl: string;
  logToContentScript: (msg: string, tabId?: number) => void;
  waitForTaskRunnable: (tabId: number, taskId: string, progress?: SaveProgress) => Promise<'running' | 'cancelled'>;
  getPersistedProgress: () => Promise<SaveProgress | undefined>;
  sendProgressUpdate: (progress: {
    type: 'uploading_images' | 'creating_note';
    uploadedImages?: number;
    totalImages?: number;
    currentPart?: number;
    totalParts?: number;
  }, tabId: number, taskId: string) => void;
}): Promise<CreatedNote[]> {
  const {
    parts,
    maxRetryRounds,
    tabId,
    taskId,
    signal,
    apiKey,
    isPublic,
    enableAutoTag,
    sourceUrl,
    logToContentScript,
    waitForTaskRunnable,
    getPersistedProgress,
    sendProgressUpdate,
  } = params;

  const createdNotes: CreatedNote[] = [];

  for (const part of parts) {
    const runnableState = await waitForTaskRunnable(tabId, taskId, {
      ...((await getPersistedProgress()) || {}),
      status: 'paused',
    });
    if (runnableState === 'cancelled' || signal.aborted) {
      break;
    }

    sendProgressUpdate({
      type: 'creating_note',
      currentPart: part.index + 1,
      totalParts: parts.length,
    }, tabId, taskId);

    let result: NoteCreateResult = { success: false, error: 'Not executed', errorCode: 'UNKNOWN' };
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetryRounds) {
      const retryRunnableState = await waitForTaskRunnable(tabId, taskId, {
        type: 'creating_note',
        currentPart: part.index + 1,
        totalParts: parts.length,
        status: 'paused',
      } as SaveProgress);
      if (retryRunnableState === 'cancelled' || signal.aborted) {
        break;
      }

      retryCount++;
      logToContentScript(`📝 正在创建第 ${part.index + 1}/${parts.length} 部分 (第 ${retryCount} 次尝试)...`, tabId);

      try {
        result = await GlobalRateLimiter.schedule(async () => {
          if (part.body) {
            return createNoteWithBody(
              apiKey,
              part.body as unknown as Record<string, unknown>,
              isPublic,
              enableAutoTag,
              signal
            );
          }

          const logWrapper = async (msg: string) => { logToContentScript(msg, tabId); };
          return createNote(
            apiKey,
            part.title,
            part.content || '',
            isPublic,
            logWrapper,
            sourceUrl,
            enableAutoTag,
            signal
          );
        });
      } catch (apiErr) {
        const errMsg = apiErr instanceof Error ? apiErr.message : 'Exception';
        logToContentScript(`❌ 创建异常: ${errMsg}`, tabId);
        result = {
          success: false,
          error: errMsg,
          errorCode: 'EXCEPTION',
        };
      }

      if (result.success) {
        success = true;
        logToContentScript(`✅ 第 ${part.index + 1} 部分创建成功: ${result.noteUrl}`, tabId);
        createdNotes.push({
          partIndex: part.index,
          noteUrl: result.noteUrl!,
          noteId: result.noteId!,
          shareUrl: result.shareUrl!,
        });
        break;
      }

      logToContentScript(`⚠️ 第 ${part.index + 1} 部分失败: ${result.error}`, tabId);
      if (!shouldRetryCreateFailure(result)) {
        break;
      }

      if (retryCount < maxRetryRounds) {
        logToContentScript(`⏳ 等待 ${(1000 * retryCount) / 1000} 秒后重试...`, tabId);
        await sleep(1000 * retryCount);
      }
    }

    if (!success) {
      logToContentScript(`❌ 第 ${part.index + 1} 部分在重试后仍然失败，放弃。`, tabId);
    }
  }

  return createdNotes;
}

export async function createIndexNoteIfNeeded(params: {
  createIndexNote: boolean;
  parts: NoteSplitPart[];
  createdNotes: CreatedNote[];
  title: string;
  sourceUrl: string;
  apiKey: string;
  isPublic: boolean;
  enableAutoTag?: boolean;
  signal: AbortSignal;
  tabId: number;
  taskId: string;
  logToContentScript: (msg: string, tabId?: number) => void;
  waitForTaskRunnable: (tabId: number, taskId: string, progress?: SaveProgress) => Promise<'running' | 'cancelled'>;
  createIndexNoteAtom: (title: string, sourceUrl: string, notes: Array<{ partIndex: number; noteUrl: string; noteId: string }>) => Record<string, unknown>;
  formatErrorForLog: (error: unknown) => string;
}): Promise<CreatedNote[]> {
  const {
    createIndexNote,
    parts,
    createdNotes,
    title,
    sourceUrl,
    apiKey,
    isPublic,
    enableAutoTag,
    signal,
    tabId,
    taskId,
    logToContentScript,
    waitForTaskRunnable,
    createIndexNoteAtom,
    formatErrorForLog,
  } = params;

  if (!(createIndexNote && parts.length > 1 && createdNotes.length > 1 && !signal.aborted)) {
    return createdNotes;
  }

  logToContentScript('📚 正在创建合集笔记（内链格式）...', tabId);
  const indexBody = createIndexNoteAtom(title, sourceUrl, createdNotes);

  const indexRunnableState = await waitForTaskRunnable(tabId, taskId, {
    type: 'creating_note',
    currentPart: parts.length,
    totalParts: parts.length,
    status: 'paused',
  } as SaveProgress);
  if (indexRunnableState === 'cancelled') {
    return createdNotes;
  }

  const indexResult = await GlobalRateLimiter.schedule(async () => (
    createNoteWithBody(apiKey, indexBody, isPublic, enableAutoTag, signal)
  ));

  if (indexResult.success) {
    return [
      {
        partIndex: -1,
        noteUrl: indexResult.noteUrl!,
        noteId: indexResult.noteId!,
        isIndex: true,
      },
      ...createdNotes,
    ];
  }

  console.error(`[墨问 Background] 合集笔记创建失败: ${formatErrorForLog(indexResult.error || 'Unknown error')}`);
  logToContentScript(`⚠️ 合集笔记创建失败: ${indexResult.error || '未知错误'}`, tabId);
  return createdNotes;
}
