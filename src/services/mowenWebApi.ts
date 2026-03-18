/**
 * 墨问 Web 内部 API 封装
 *
 * 这些接口来自墨问 Web 端（note.mowen.cn），非 Open API。
 * 认证通过浏览器 Cookie 完成，用户必须先在浏览器中登录墨问。
 *
 * 接口说明：
 * - /note/workbench：获取笔记列表（分页）
 * - /note/show：获取笔记详情（完整 HTML 或 NoteAtom JSON）
 * - /note/ref/infos：获取合集子笔记信息
 */

import { MowenNoteItem, MowenNoteDetail, NoteListPaging, NoteListFilter, MowenLoginStatusResult } from '../types';
import {
  normalizeMowenHtmlForExport,
  noteAtomToHtml,
  parseNoteAtomJson,
  resolveMowenImageUrl,
} from '../utils/noteAtom';

/**
 * 统一的 Web API 请求方法
 * 
 * Chrome 扩展中，从扩展页面（chrome-extension:// 协议）向 note.mowen.cn 发起 fetch，
 * 即使设置 credentials: 'include' 也无法自动携带第三方网站的 Cookie。
 * 因此需要通过 Background Service Worker 代理请求，
 * Background SW 的 fetch 在 host_permissions 匹配时可以携带 Cookie。
 */
async function webApiRequest<T>(path: string, body: object): Promise<T> {
  // 尝试通过 Background Script 代理请求
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'MOWEN_WEB_API_REQUEST',
      payload: { path, body },
    });

    if (!response) {
      throw new MowenWebApiError('后台服务无响应', 'BG_NO_RESPONSE', 0);
    }

    if (!response.success) {
      throw new MowenWebApiError(
        response.error || '请求失败',
        response.errorCode || 'REQUEST_FAILED',
        response.status || 0
      );
    }

    return response.data as T;
  } catch (error) {
    if (error instanceof MowenWebApiError) {
      throw error;
    }
    throw new MowenWebApiError(
      error instanceof Error ? error.message : '未知错误',
      'UNKNOWN',
      0
    );
  }
}

/**
 * 自定义错误类型
 */
export class MowenWebApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'MowenWebApiError';
    this.code = code;
    this.status = status;
  }
}

// ============================================
// workbench API 响应类型
// ============================================

interface WorkbenchNoteBase {
  title?: string;
  digest?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface WorkbenchNoteData {
  base?: WorkbenchNoteBase;
  tag?: { name?: string }[];
  cover?: { url?: string };
  noteType?: number; // 判断是否为合集
}

interface WorkbenchResponse {
  noteIds?: string[];
  topNoteIds?: string[];  // 置顶笔记 ID 列表（合集通常在此）
  notes?: Record<string, WorkbenchNoteData>;
  paging?: {
    next?: string;
    total?: number;
  };
}

// ============================================
// show API 响应类型
// ============================================

interface ShowResponse {
  detail?: {
    noteBase?: {
      title?: string;
      // show API 返回的 content 可能是：
      // 1. HTML 字符串
      // 2. NoteAtom JSON 字符串
      // 3. NoteAtom JSON 对象（被 response.json() 递归反序列化）
      content?: string | Record<string, unknown>;
      uuid?: string;
    };
    noteTags?: Array<{ name?: string }>;
    noteFile?: {
      images?: Record<string, {
        fileUuid?: string;
        url?: string;
        scale?: Record<string, string | undefined>;
        uuid?: string;
      }>;
      audios?: Record<string, unknown>;
      docs?: Record<string, unknown>;
    };
    noteFileTree?: {
      imageAttach?: unknown[];
      imageInline?: unknown[];
      audio?: unknown[];
      speech?: Record<string, unknown>;
      imageCover?: unknown[];
      doc?: unknown[];
    };
    // 笔记引用的其他笔记 UUID 列表（合集子笔记）
    noteRef?: string[];
    // 嵌入引用信息
    noteEmbed?: {
      ref?: {
        all?: string[];
      };
    };
    // 画廊数据：每个画廊包含的图片 UUID 列表
    noteGallery?: {
      gallerys?: Record<string, { fileUuids?: string[] } | undefined>;
    };
  };
}

// ============================================
// ref/infos API 响应类型
// ============================================

interface RefInfoItem {
  uuid?: string;
  title?: string;
  digest?: string;
}

interface RefInfosResponse {
  notes?: Record<string, RefInfoItem>;
}

// ============================================
// 公开方法
// ============================================

function mergeUniqueNoteIds(...groups: Array<Array<string | undefined> | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (!group) continue;

    for (const value of group) {
      const uuid = typeof value === 'string' ? value.trim() : '';
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      merged.push(uuid);
    }
  }

  return merged;
}

function getNotesMapIds(notesMap: Record<string, unknown> | undefined): string[] {
  return Object.keys(notesMap || {});
}

/**
 * 获取置顶笔记列表
 * 置顶笔记来自独立的 /note/tops 接口（不在 workbench 响应中）
 */
async function fetchTopNotes(): Promise<{
  noteIds: string[];
  notesMap: Record<string, WorkbenchNoteData>;
}> {
  try {
    const data = await webApiRequest<WorkbenchResponse>(
      '/api/note/entry/v1/note/tops',
      { scene: 1 }
    );
    const notesMap = data.notes || {};
    return {
      noteIds: mergeUniqueNoteIds(data.topNoteIds, data.noteIds, getNotesMapIds(notesMap)),
      notesMap,
    };
  } catch (error) {
    // 置顶接口失败不影响主列表
    console.warn('[mowenWebApi] fetchTopNotes 失败，跳过置顶笔记:', error);
    return { noteIds: [], notesMap: {} };
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNoteDigest(title: string, digest: string): string {
  const normalizedTitle = title.trim();
  const normalizedDigest = digest.trim();

  if (!normalizedTitle || !normalizedDigest) {
    return normalizedDigest;
  }

  if (normalizedDigest === normalizedTitle) {
    return '';
  }

  const titleVariants = [
    normalizedTitle,
    `「${normalizedTitle}」`,
    `『${normalizedTitle}』`,
    `“${normalizedTitle}”`,
    `"${normalizedTitle}"`,
    `【${normalizedTitle}】`,
  ];

  for (const variant of titleVariants) {
    const pattern = new RegExp(
      `^${escapeRegExp(variant)}(?:[\\s\\u00A0\\u200B]*[-—–:：|｜·•,.，。!！?？、]*)*[\\s\\u00A0\\u200B]*`
    );

    if (pattern.test(normalizedDigest)) {
      return normalizedDigest.replace(pattern, '').trim();
    }
  }

  return normalizedDigest;
}

function appendUniqueUuid(target: string[], value: unknown): void {
  const uuid = typeof value === 'string' ? value.trim() : '';
  if (!uuid) return;
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(uuid)) return;
  if (!target.includes(uuid)) {
    target.push(uuid);
  }
}

function isCollectionNote(uuid: string, noteData: WorkbenchNoteData): boolean {
  return (
    (noteData.noteType ?? 0) > 0 ||
    uuid.startsWith('kpt-')
  );
}

function canExpandCollectionNote(uuid: string, noteData: WorkbenchNoteData): boolean {
  return (
    (noteData.noteType ?? 0) > 0 ||
    uuid.startsWith('kpt-')
  );
}

function collectSupplementalNoteIds(
  notesMap: Record<string, WorkbenchNoteData>,
  referencedIds: string[],
  predicate?: (uuid: string, noteData: WorkbenchNoteData) => boolean
): string[] {
  const referencedSet = new Set(referencedIds);

  return Object.entries(notesMap)
    .filter(([uuid, noteData]) => {
      if (referencedSet.has(uuid)) return false;
      if (typeof noteData !== 'object' || noteData === null) return false;
      return predicate ? predicate(uuid, noteData) : true;
    })
    .map(([uuid]) => uuid);
}

function collectChildNoteIdsFromAtomNode(node: unknown, target: string[]): void {
  if (!node || typeof node !== 'object') return;

  const maybeNode = node as {
    type?: string;
    attrs?: { uuid?: unknown };
    content?: unknown[];
  };

  if (maybeNode.type === 'note') {
    appendUniqueUuid(target, maybeNode.attrs?.uuid);
  }

  if (Array.isArray(maybeNode.content)) {
    for (const child of maybeNode.content) {
      collectChildNoteIdsFromAtomNode(child, target);
    }
  }
}

function extractChildNoteIdsFromHtml(html: string, target: string[]): void {
  if (!html) return;

  const patterns = [
    /<note\b[^>]*uuid="([^"]+)"/g,
    /data-note-uuid="([^"]+)"/g,
    /data-mowen-note-uuid="([^"]+)"/g,
    /<q\b[^>]*uuid="([^"]+)"/g,
    /\bcite="(?:https?:\/\/[^/"?#]+)?\/detail\/([^"?#/]+)"/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      appendUniqueUuid(target, match[1]);
    }
  }
}

/**
 * 将 API 返回的笔记数据转换为标准化 MowenNoteItem
 */
function convertToNoteItem(
  uuid: string,
  noteData: WorkbenchNoteData | undefined,
  isTop: boolean
): MowenNoteItem | null {
  if (!noteData) {
    console.warn('[mowenWebApi] 笔记数据缺失');
    return null;
  }

  return {
    uuid,
    title: noteData.base?.title || '无标题',
    digest: normalizeNoteDigest(noteData.base?.title || '', noteData.base?.digest || ''),
    createdAt: noteData.base?.createdAt ?? '',
    tags: noteData.tag?.map(t => t.name || '').filter(Boolean),
    coverImage: noteData.cover?.url,
    isCollection: isCollectionNote(uuid, noteData),
    canExpandChildren: canExpandCollectionNote(uuid, noteData),
    isTop,
  };
}

/**
 * 获取笔记列表（包含置顶笔记）
 */
export async function fetchNoteList(
  paging: NoteListPaging = { hint: '', size: 20 },
  filter: NoteListFilter = { benchType: 1 }
): Promise<{
  notes: MowenNoteItem[];
  nextHint: string;
  total: number;
}> {
  // 并行请求：workbench（普通笔记）+ tops（置顶笔记，仅首页）
  const isFirstPage = paging.hint === '';

  const [workbenchData, topData] = await Promise.all([
    webApiRequest<WorkbenchResponse>(
      '/api/note/entry/v1/note/workbench',
      { paging, filter }
    ),
    isFirstPage ? fetchTopNotes() : Promise.resolve({ noteIds: [], notesMap: {} }),
  ]);

  const workbenchNoteIds = workbenchData.noteIds || [];
  const workbenchTopNoteIds = workbenchData.topNoteIds || [];
  const workbenchNotesMap = workbenchData.notes || {};
  const topNoteIds = topData.noteIds;
  const topNotesMap = topData.notesMap;

  // 合并笔记详情 map（tops 优先）
  const mergedNotesMap: Record<string, WorkbenchNoteData> = {
    ...workbenchNotesMap,
    ...topNotesMap,
  };

  // 兼容不同 workbench 响应结构：
  // 1. 常规笔记在 noteIds
  // 2. 部分合集/置顶笔记在 topNoteIds
  // 3. 部分置顶笔记只出现在 tops 的 notes map，需要补回
  // 4. 极端情况下合集详情只出现在 workbench notes map，需要补回
  const mergedTopNoteIds = mergeUniqueNoteIds(workbenchTopNoteIds, topNoteIds);
  const referencedNoteIds = mergeUniqueNoteIds(mergedTopNoteIds, workbenchNoteIds);
  const supplementalTopNoteIds = collectSupplementalNoteIds(
    topNotesMap,
    referencedNoteIds
  );
  const supplementalCollectionNoteIds = collectSupplementalNoteIds(
    mergedNotesMap,
    mergeUniqueNoteIds(referencedNoteIds, supplementalTopNoteIds),
    canExpandCollectionNote
  );
  const allNoteIds = mergeUniqueNoteIds(
    mergedTopNoteIds,
    workbenchNoteIds,
    supplementalTopNoteIds,
    supplementalCollectionNoteIds
  );
  const topSet = new Set(mergeUniqueNoteIds(mergedTopNoteIds, supplementalTopNoteIds));

  // 转换为标准化 MowenNoteItem 数组
  const notes = allNoteIds
    .map(uuid => convertToNoteItem(uuid, mergedNotesMap[uuid], topSet.has(uuid)))
    .filter(item => item !== null) as MowenNoteItem[];

  return {
    notes,
    nextHint: workbenchData.paging?.next || '',
    total: workbenchData.paging?.total || 0,
  };
}

/**
 * 获取笔记详情（完整 HTML 正文）
 *
 * 注意：show API 返回的 content 字段可能有两种格式：
 * 1. 标准 HTML 字符串（直接可渲染）
 * 2. NoteAtom JSON 字符串（ProseMirror 编辑器数据，需转换为 HTML）
 * 该函数会自动检测格式并统一返回 HTML。
 */
export async function fetchNoteDetail(uuid: string): Promise<MowenNoteDetail> {
  const data = await webApiRequest<ShowResponse>(
    '/api/note/wxa/v1/note/show',
    { uuid, peekKey: '', accessToken: '' }
  );

  const noteBase = data.detail?.noteBase;
  if (!noteBase?.content) {
    throw new MowenWebApiError('笔记内容为空', 'EMPTY_CONTENT', 0);
  }

  const noteFile = data.detail?.noteFile;
  const noteFileTree = data.detail?.noteFileTree;
  const noteGallery = data.detail?.noteGallery;
  const resolveImageUrl = (imageUuid: string) => resolveMowenImageUrl(imageUuid, noteFile);

  // 检测内容格式并统一转换为 HTML
  // show API 返回的 content 可能是三种格式：
  // 1. HTML 字符串 — 直接使用
  // 2. NoteAtom JSON 字符串 — 解析后转换
  // 3. NoteAtom JSON 对象 — 直接转换（response.json() 可能递归反序列化）
  const rawContent = noteBase.content;
  let htmlContent: string;
  let shouldNormalizeHtml = false;
  const childNoteIds: string[] = [];

  if (typeof rawContent === 'object' && rawContent !== null) {
    // 情况 3：已经是 JS 对象（NoteAtom JSON 被 response.json() 反序列化）
    const atom = rawContent as { type?: string; content?: unknown[] };
    if (atom.type === 'doc' && Array.isArray(atom.content)) {
      collectChildNoteIdsFromAtomNode(rawContent, childNoteIds);
      htmlContent = noteAtomToHtml(
        rawContent as unknown as Parameters<typeof noteAtomToHtml>[0],
        { resolveImageUrl }
      );
      shouldNormalizeHtml = true;
    } else {
      // 不是 NoteAtom 结构的对象，序列化为字符串作为降级
      console.warn('[mowenWebApi] fetchNoteDetail: content 是未知对象格式，尝试 JSON 序列化');
      htmlContent = `<pre>${JSON.stringify(rawContent, null, 2)}</pre>`;
    }
  } else if (typeof rawContent === 'string') {
    // 情况 1 或 2：字符串
    const noteAtom = parseNoteAtomJson(rawContent);
    if (noteAtom) {
      // 情况 2：NoteAtom JSON 字符串
      collectChildNoteIdsFromAtomNode(noteAtom, childNoteIds);
      htmlContent = noteAtomToHtml(noteAtom, { resolveImageUrl });
      shouldNormalizeHtml = true;
    } else {
      // 情况 1：HTML 字符串
      extractChildNoteIdsFromHtml(rawContent, childNoteIds);
      htmlContent = rawContent;
      shouldNormalizeHtml = true;
    }
  } else {
    // 异常情况
    console.warn('[mowenWebApi] fetchNoteDetail: content 类型异常:', typeof rawContent);
    htmlContent = String(rawContent);
  }

  if (shouldNormalizeHtml) {
    // 画廊图片数据补全：note/show API 的 noteFile.images 可能只包含
    // 画廊中前几张图片的元数据，其余需要通过 gallery/infos 接口获取
    if (noteGallery?.gallerys) {
      const galleryUuids = Object.keys(noteGallery.gallerys);
      if (galleryUuids.length > 0) {
        try {
          const galleryInfos = await webApiRequest<{
            images?: Record<string, {
              fileUuid?: string;
              url?: string;
              scale?: Record<string, string | undefined>;
              uuid?: string;
            }>;
          }>('/api/note/wxa/v1/gallery/infos', {
            galleryUuids,
            noteUuid: uuid,
          });

          // 合并画廊图片元数据到 noteFile.images
          if (galleryInfos?.images && noteFile) {
            if (!noteFile.images) {
              noteFile.images = {};
            }
            for (const [imgUuid, imgData] of Object.entries(galleryInfos.images)) {
              if (!imgData) {
                continue;
              }

              const candidateKeys = new Set(
                [imgUuid, imgData.fileUuid, imgData.uuid]
                  .map((value) => value?.trim() || '')
                  .filter(Boolean)
              );

              for (const key of candidateKeys) {
                if (!noteFile.images[key]) {
                  noteFile.images[key] = imgData;
                }
              }
            }
          }
        } catch (error) {
          // 画廊数据补全失败不阻塞导出，降级为 CDN URL
          console.warn('[mowenWebApi] gallery/infos failed, fallback to CDN:', error);
        }
      }
    }

    htmlContent = normalizeMowenHtmlForExport(htmlContent, { noteFile, noteFileTree, noteGallery });
  }

  extractChildNoteIdsFromHtml(htmlContent, childNoteIds);

  // 从 show API 的 noteRef / noteEmbed 字段补充子笔记 UUID（最可靠来源）
  const noteRef = data.detail?.noteRef || [];
  const noteEmbedAll = data.detail?.noteEmbed?.ref?.all || [];
  for (const refUuid of [...noteRef, ...noteEmbedAll]) {
    appendUniqueUuid(childNoteIds, refUuid);
  }

  return {
    uuid: noteBase.uuid || uuid,
    title: noteBase.title || '无标题',
    htmlContent,
    tags: data.detail?.noteTags?.map(t => t.name || '').filter(Boolean),
    childNoteIds,
  };
}

/**
 * 批量获取合集子笔记信息
 */
export async function fetchNoteRefInfos(uuids: string[]): Promise<MowenNoteItem[]> {
  if (uuids.length === 0) return [];

  const data = await webApiRequest<RefInfosResponse>(
    '/api/note/entry/v1/note/ref/infos',
    { uuids }
  );

  const notesMap = data.notes || {};

  return uuids.map((uuid) => {
    const note = notesMap[uuid];
    return {
      uuid,
      title: note?.title || '无标题',
      digest: normalizeNoteDigest(note?.title || '', note?.digest || ''),
      createdAt: '',
      isCollection: false,
      canExpandChildren: false,
    };
  }).filter(item => item.title !== '无标题' || item.digest !== '');
}

/**
 * 检测墨问登录状态
 * 发送一个最小的 workbench 请求，如果返回 401/403 则未登录
 */
export async function checkLoginStatus(): Promise<MowenLoginStatusResult> {
  try {
    await fetchNoteList({ hint: '', size: 1 }, { benchType: 1 });
    return { status: 'logged_in' };
  } catch (error) {
    if (error instanceof MowenWebApiError && error.code === 'NOT_LOGGED_IN') {
      return { status: 'logged_out' };
    }

    console.warn('[mowenWebApi] checkLoginStatus error:', error);
    return {
      status: 'error',
      error: error instanceof Error ? error.message : '登录状态检查失败',
      errorCode: error instanceof MowenWebApiError ? error.code : 'UNKNOWN',
    };
  }
}
