console.log('[墨问 Background] 🏁 Service Worker Script Loaded');
import {
  ClipKind,
  ContentBlock,
  CreateNoteRequest,
  ExtractResult,
  ImageCandidate,
  ImageProcessResult,
  NoteCreateResult,
  SaveHighlightPayload,
  HighlightSaveResult,
  Highlight,
} from '../types';
import { getSettings, saveSettings } from '../utils/storage';
import { isValidPageTitle, extractTitleFromText, formatErrorForLog } from '../utils/helpers';

import { createNote, buildNoteBody, editNote } from '../services/api';
import { LIMITS, backgroundLogger as logger } from '../utils/constants';
import { TaskStore } from '../utils/taskStore';
import { htmlToNoteAtom } from '../utils/noteAtom';
import { stabilizeLatinHanLineBreaks } from '../utils/mixedLanguage';
import { registerSidePanelHandlers } from './sidePanel';
import { registerContextMenuHandlers } from './contextMenu';
import {
  isAllowedImageProxyUrl,
  isAllowedMowenWebApiPath,
  isTrustedExtensionPageSender,
  shouldIncludeImageProxyCredentials,
} from './requestGuards';
import { registerBackgroundMessageRouter } from './messageRouter';
import {
  finalizeSaveTask,
  getRunningTask,
  notifyTaskWaiters,
  runningTasks,
  sendProgressUpdate,
  waitForTaskRunnable,
} from './saveTaskRuntime';
import { processImages } from './imagePipeline';
import {
  createIndexNoteIfNeeded,
  createSplitNotes,
  prepareContentForSave,
} from './saveNoteFlow';
import { planTwitterSaveRequests } from './twitterSavePlan';

const SAFE_LIMIT = LIMITS.SAFE_CONTENT_LENGTH;
const MAX_RETRY_ROUNDS = LIMITS.MAX_RETRY_ROUNDS;
const IMAGE_TIMEOUT = LIMITS.IMAGE_UPLOAD_TIMEOUT;
const MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024;

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

interface NoteBlockEntry {
  node: NoteAtomNode;
  groupId?: string;
}

registerSidePanelHandlers({ formatErrorForLog });
registerContextMenuHandlers({
  getSettings,
  handleSaveHighlight,
  formatErrorForLog,
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
registerBackgroundMessageRouter({
  logger,
  formatErrorForLog,
  runningTasks,
  getRunningTask,
  notifyTaskWaiters,
  taskStore: {
    clear: TaskStore.clear,
    updateProgress: TaskStore.updateProgress,
  },
  saveSettings,
  handleSaveNote,
  handleSaveHighlight,
  isTrustedExtensionPageSender,
  isAllowedMowenWebApiPath,
  isAllowedImageProxyUrl,
  shouldIncludeImageProxyCredentials,
  maxProxyImageBytes: MAX_PROXY_IMAGE_BYTES,
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

  try {
    const { processedContent, processedBlocks } = await prepareContentForSave({
      extractResult,
      includeImages,
      maxImages,
      apiKey: settings.apiKey,
      tabId,
      taskId,
      signal,
      processImages: (apiKey, imagesToProcess, currentTabId, currentTaskId, currentSignal) => (
        processImages(apiKey, imagesToProcess, currentTabId, currentTaskId, currentSignal, {
          imageTimeout: IMAGE_TIMEOUT,
          formatErrorForLog,
          logToContentScript,
          waitForTaskRunnable,
          sendProgressUpdate: (progress, currentTabId2, currentTaskId2) => {
            sendProgressUpdate(progress, currentTabId2, currentTaskId2, formatErrorForLog);
          },
        })
      ),
      replaceImageUrls,
      injectUploadedImages,
      removeAllImageTags,
      logToContentScript,
    });

    if (signal.aborted) {
      console.log('[墨问 Background] ⚠️ Cancel requested, aborting note creation');
      return finalizeSaveTask(tabId, taskId, { success: false, error: '已取消保存', errorCode: 'CANCELLED' }, formatErrorForLog, { clearTask: true });
    }

    const clipKind = resolveClipKind(extractResult);
    const normalizedTitle = extractResult.title;

    const parts = clipKind === 'twitter-post' || clipKind === 'x-longform'
      ? planTwitterSaveRequests({
        clipKind,
        title: normalizedTitle,
        sourceUrl: extractResult.sourceUrl,
        content: processedContent,
        limit: SAFE_LIMIT,
        blocks: processedBlocks,
      })
      : splitContent(
        normalizedTitle,
        extractResult.sourceUrl,
        processedContent,
        SAFE_LIMIT,
        processedBlocks
      );

    console.log(`[note] create start title="${normalizedTitle.substring(0, 30)}..." partsCount=${parts.length}`);
    logToContentScript(`创建 ${parts.length} 篇笔记...`, tabId);
    let createdNotes = await createSplitNotes({
      parts,
      maxRetryRounds: MAX_RETRY_ROUNDS,
      tabId,
      taskId,
      signal,
      apiKey: settings.apiKey,
      isPublic,
      enableAutoTag,
      sourceUrl: extractResult.sourceUrl,
      logToContentScript,
      waitForTaskRunnable,
      getPersistedProgress: async () => (await TaskStore.get(tabId))?.progress,
      sendProgressUpdate: (progress, currentTabId, currentTaskId) => {
        sendProgressUpdate(progress, currentTabId, currentTaskId, formatErrorForLog);
      },
    });

    if (signal.aborted) {
      console.log('[墨问 Background] ⚠️ Cancel requested after note creation loop');
      return finalizeSaveTask(tabId, taskId, { success: false, error: '已取消保存', errorCode: 'CANCELLED' }, formatErrorForLog, { clearTask: true });
    }

    console.log(`[墨问 Background] 🔍 合集创建条件检查: createIndexNote=${createIndexNote}, parts.length=${parts.length}, createdNotes.length=${createdNotes.length}`);
    logToContentScript(`🔍 合集检查: 开关=${createIndexNote}, 分块=${parts.length}, 成功=${createdNotes.length}`, tabId);
    createdNotes = await createIndexNoteIfNeeded({
      createIndexNote,
      parts,
      createdNotes,
      title: normalizedTitle,
      sourceUrl: extractResult.sourceUrl,
      apiKey: settings.apiKey,
      isPublic,
      enableAutoTag,
      signal,
      tabId,
      taskId,
      logToContentScript,
      waitForTaskRunnable,
      createIndexNoteAtom,
      formatErrorForLog,
    });

    console.log('[墨问 Background] 📊 Final note count:', createdNotes.length);

    if (createdNotes.length === 0) {
      console.error('[墨问 Background] ❌ No notes were created');
      return finalizeSaveTask(tabId, taskId, { success: false, error: '创建笔记失败', errorCode: 'UNKNOWN' }, formatErrorForLog);
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

    return finalizeSaveTask(tabId, taskId, result, formatErrorForLog);
  } catch (error) {
    console.error(`[墨问 Background] Save process failed with exception: ${formatErrorForLog(error)}`);
    const errorResult = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: 'UNKNOWN',
    };
    return finalizeSaveTask(tabId, taskId, errorResult, formatErrorForLog);
  }
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


function cloneNoteBlockEntry(entry: NoteBlockEntry): NoteBlockEntry {
  return {
    node: cloneNoteAtomNode(entry.node),
    groupId: entry.groupId,
  };
}

function isTwitterSourceUrl(sourceUrl: string): boolean {
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(sourceUrl);
}

function resolveClipKind(extractResult: ExtractResult): ClipKind {
  if (!isTwitterSourceUrl(extractResult.sourceUrl)) {
    return 'default';
  }

  if (extractResult.clipKind === 'twitter-post' || extractResult.clipKind === 'x-longform') {
    return extractResult.clipKind;
  }

  return 'twitter-post';
}

function convertExtractBlocksToNoteBlocks(blocks: ContentBlock[]): NoteBlockEntry[] {
  const noteBlocks: NoteBlockEntry[] = [];

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];

    if (block.layout?.preserveInlineParagraphs === true && block.layout?.role === 'spacer') {
      noteBlocks.push({
        node: {
          type: 'paragraph',
          content: [],
        },
        groupId: block.layout?.groupId,
      });
      continue;
    }

    const atom = htmlToNoteAtom(block.html, {
      preserveInlineParagraphs: block.layout?.preserveInlineParagraphs === true,
    }) as unknown as NoteAtomDoc;
    const atomBlocks = Array.isArray(atom.content) ? atom.content : [];

    if (atomBlocks.length > 0) {
      noteBlocks.push(...atomBlocks.map((node) => ({
        node: cloneNoteAtomNode(node),
        groupId: block.layout?.groupId,
      })));
      continue;
    }

    const text = block.text?.trim();
    if (!text) {
      continue;
    }

    if (block.type === 'quote') {
      noteBlocks.push({
        node: {
          type: 'quote',
          content: [{ type: 'text', text: stabilizeLatinHanLineBreaks(text) }],
        },
        groupId: block.layout?.groupId,
      });
      continue;
    }

    noteBlocks.push({
      node: {
        type: 'paragraph',
        content: [{ type: 'text', text: stabilizeLatinHanLineBreaks(text) }],
      },
      groupId: block.layout?.groupId,
    });
  }

  return noteBlocks;
}

function normalizeTitleForComparison(text: string): string {
  return text.replace(/[\s.,;:!?。，；：！？\u200B]/g, '').toLowerCase();
}

function isEmptyParagraphNode(node: NoteAtomNode): boolean {
  return node.type === 'paragraph' && getNodeTextLength(node) === 0;
}

function isLeadMediaNode(node: NoteAtomNode): boolean {
  return node.type === 'image';
}

function shouldRemoveDuplicateTitleNode(node: NoteAtomNode, title: string, normalizedTitle: string): boolean {
  const blockText = getNodeText(node).trim();
  if (!blockText || normalizeTitleForComparison(blockText) !== normalizedTitle) {
    return false;
  }

  if (node.type === 'heading') {
    return true;
  }

  if (node.type === 'paragraph') {
    return blockText.length <= title.trim().length * 1.5;
  }

  return false;
}

function shouldTrimDuplicateTitlePrefixNode(node: NoteAtomNode, title: string, normalizedTitle: string): boolean {
  if (node.type !== 'paragraph' && node.type !== 'quote') {
    return false;
  }

  const blockText = getNodeText(node).trim();
  if (!blockText || !blockText.startsWith(title)) {
    return false;
  }

  const normalizedBlock = normalizeTitleForComparison(blockText);
  if (!normalizedBlock.startsWith(normalizedTitle) || normalizedBlock === normalizedTitle) {
    return false;
  }

  const trailingText = blockText.slice(title.length);
  if (!trailingText) {
    return false;
  }

  return /^[\s\u00a0\-–—:：|丨、,.，。!?！？/()（）]+/.test(trailingText);
}

function trimDuplicateTitlePrefixNode(node: NoteAtomNode, title: string): NoteAtomNode | null {
  const blockText = getNodeText(node).trim();
  if (!blockText.startsWith(title)) {
    return cloneNoteAtomNode(node);
  }

  const trimmedText = blockText
    .slice(title.length)
    .replace(/^[\s\u00a0\-–—:：|丨、,.，。!?！？/()（）]+/, '')
    .trim();

  if (!trimmedText) {
    return null;
  }

  return {
    ...cloneNoteAtomNode(node),
    content: [{ type: 'text', text: stabilizeLatinHanLineBreaks(trimmedText) }],
  };
}

function findLeadingTitleCandidateIndex(blocks: NoteBlockEntry[]): number {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (isEmptyParagraphNode(block.node) || isLeadMediaNode(block.node)) {
      continue;
    }
    return index;
  }

  return -1;
}

function trimAdjacentEmptyParagraphs(blocks: NoteBlockEntry[], index: number): void {
  let currentIndex = index;

  while (currentIndex < blocks.length && isEmptyParagraphNode(blocks[currentIndex].node)) {
    blocks.splice(currentIndex, 1);
  }

  while (currentIndex - 1 >= 0 && isEmptyParagraphNode(blocks[currentIndex - 1].node)) {
    blocks.splice(currentIndex - 1, 1);
    currentIndex--;
  }
}

function removeLeadingDuplicateTitleBlocks(blocks: NoteBlockEntry[], title: string): NoteBlockEntry[] {
  const trimmedTitle = title.trim();
  if (!trimmedTitle || blocks.length === 0) {
    return blocks;
  }

  const normalizedTitle = normalizeTitleForComparison(trimmedTitle);
  if (!normalizedTitle) {
    return blocks;
  }

  const remainingBlocks = blocks.map((block) => cloneNoteBlockEntry(block));
  let removed = false;

  while (remainingBlocks.length > 0) {
    const firstContentIndex = findLeadingTitleCandidateIndex(remainingBlocks);
    if (firstContentIndex === -1) {
      break;
    }

    const firstContentBlock = remainingBlocks[firstContentIndex];
    if (!shouldRemoveDuplicateTitleNode(firstContentBlock.node, trimmedTitle, normalizedTitle)) {
      if (shouldTrimDuplicateTitlePrefixNode(firstContentBlock.node, trimmedTitle, normalizedTitle)) {
        const trimmedBlock = trimDuplicateTitlePrefixNode(firstContentBlock.node, trimmedTitle);
        console.log(`[bg] Trimming duplicate title prefix from block-based save path: "${getNodeText(firstContentBlock.node).trim().slice(0, 50)}"`);
        if (trimmedBlock) {
          remainingBlocks[firstContentIndex] = {
            ...firstContentBlock,
            node: trimmedBlock,
          };
        } else {
          remainingBlocks.splice(firstContentIndex, 1);
        }
        trimAdjacentEmptyParagraphs(remainingBlocks, firstContentIndex);
        removed = true;
      }
      break;
    }

    const removedBlock = remainingBlocks[firstContentIndex];
    console.log(`[bg] Removing duplicate title block from block-based save path: "${getNodeText(removedBlock!.node).trim().slice(0, 50)}"`);
    remainingBlocks.splice(firstContentIndex, 1);
    trimAdjacentEmptyParagraphs(remainingBlocks, firstContentIndex);
    removed = true;
  }

  return removed ? remainingBlocks : blocks;
}

function splitOversizedEntry(entry: NoteBlockEntry, limit: number): NoteBlockEntry[] {
  return splitOversizedBlock(entry.node, limit).map((node) => ({
    node,
    groupId: entry.groupId,
  }));
}

function getEntryTextLength(entry: NoteBlockEntry): number {
  return getNodeTextLength(entry.node);
}

function expandEntryAtomicGroups(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
  const atomicGroups: NoteBlockEntry[][] = [];
  let currentGroupId: string | undefined;
  let currentGroup: NoteBlockEntry[] = [];

  const flushCurrentGroup = () => {
    if (currentGroup.length === 0) {
      return;
    }

    const clonedGroup = currentGroup.map((entry) => cloneNoteBlockEntry(entry));
    const groupLength = clonedGroup.reduce((sum, entry) => sum + Math.max(getEntryTextLength(entry), 1), 0);
    if (currentGroupId && groupLength <= limit) {
      atomicGroups.push(clonedGroup);
    } else {
      clonedGroup.forEach((entry) => {
        atomicGroups.push([entry]);
      });
    }

    currentGroup = [];
    currentGroupId = undefined;
  };

  for (const entry of entries) {
    if (!entry.groupId) {
      flushCurrentGroup();
      atomicGroups.push([cloneNoteBlockEntry(entry)]);
      continue;
    }

    if (currentGroupId === entry.groupId) {
      currentGroup.push(entry);
      continue;
    }

    flushCurrentGroup();
    currentGroupId = entry.groupId;
    currentGroup = [entry];
  }

  flushCurrentGroup();
  return atomicGroups;
}

function groupEntriesByLimit(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
  const atomicGroups = expandEntryAtomicGroups(entries, limit);
  const groupedEntries: NoteBlockEntry[][] = [];
  let currentGroup: NoteBlockEntry[] = [];
  let currentLength = 0;

  for (const atomicGroup of atomicGroups) {
    const atomicLength = atomicGroup.reduce((sum, entry) => sum + Math.max(getEntryTextLength(entry), 1), 0);

    if (currentGroup.length > 0 && currentLength + atomicLength > limit) {
      groupedEntries.push(currentGroup);
      currentGroup = [];
      currentLength = 0;
    }

    currentGroup.push(...atomicGroup.map((entry) => cloneNoteBlockEntry(entry)));
    currentLength += atomicLength;
  }

  if (currentGroup.length > 0) {
    groupedEntries.push(currentGroup);
  }

  return groupedEntries;
}

function splitContent(
  title: string,
  sourceUrl: string,
  content: string,
  limit: number,
  blocks?: ContentBlock[]
): CreateNoteRequest[] {
  const convertedBlockEntries = blocks && blocks.length > 0
    ? convertExtractBlocksToNoteBlocks(blocks)
    : null;
  const contentBody = convertedBlockEntries
    ? { type: 'doc', content: convertedBlockEntries.map((entry) => entry.node) }
    : (htmlToNoteAtom(content) as unknown as NoteAtomDoc);
  const rawContentBlocks = Array.isArray(contentBody.content) ? contentBody.content : [];
  const contentEntries = convertedBlockEntries
    ? removeLeadingDuplicateTitleBlocks(convertedBlockEntries, title)
    : rawContentBlocks.map((block) => ({ node: cloneNoteAtomNode(block) }));
  const totalTextLength = contentEntries.reduce((sum, entry) => sum + getEntryTextLength(entry), 0);

  if (totalTextLength <= limit) {
    if (blocks && blocks.length > 0) {
      return [{
        createMode: 'body',
        index: 0,
        total: 1,
        title,
        body: buildMultipartBody(title, sourceUrl, contentEntries.map((entry) => entry.node)),
      }];
    }

    return [{
      createMode: 'html',
      index: 0,
      total: 1,
      title,
      content,
      sourceUrl,
    }];
  }

  console.log(`[bg] Text length ${totalTextLength} > ${limit}, splitting by NoteAtom blocks...`);

  const normalizedEntries = contentEntries.flatMap((entry) => splitOversizedEntry(entry, limit));
  const groupedBlocks = groupEntriesByLimit(normalizedEntries, limit);

  const total = groupedBlocks.length;
  if (total <= 1) {
    return [{
      createMode: 'html',
      index: 0,
      total: 1,
      title,
      content,
      sourceUrl,
    }];
  }

  return groupedBlocks.map((blocks, index) => {
    const partTitle = index === 0 ? title : `${title} (${index + 1})`;
    return {
      createMode: 'body' as const,
      index,
      total,
      title: partTitle,
      body: buildMultipartBody(partTitle, sourceUrl, blocks.map((entry) => entry.node)),
    };
  });
}

function buildMultipartBody(
  title: string,
  sourceUrl: string,
  blocks: NoteAtomNode[]
): NoteAtomDoc {
  const metaBody = buildNoteBody(title, '', sourceUrl) as unknown as NoteAtomDoc;
  const metaBlocks = Array.isArray(metaBody.content)
    ? metaBody.content.map((block) => cloneNoteAtomNode(block))
    : [];
  const needsSourceSpacer = Boolean(sourceUrl && blocks.length > 0);

  return {
    type: 'doc',
    content: [
      ...metaBlocks,
      ...(needsSourceSpacer ? [{ type: 'paragraph', content: [] } as NoteAtomNode] : []),
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
