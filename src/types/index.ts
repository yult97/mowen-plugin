// Settings types
export interface Settings {
  apiKey: string;
  defaultPublic: boolean;
  defaultIncludeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  debugMode: boolean;
  enableAutoTag: boolean;  // 是否自动添加「墨问剪藏」标签
  lastTestStatus?: 'success' | 'failed' | null;
  lastTestAt?: string | null;
  lastTestNoteUrl?: string | null;
  lastTestError?: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  defaultPublic: false,
  defaultIncludeImages: true,
  maxImages: 50,
  createIndexNote: true,
  debugMode: false,
  enableAutoTag: false,   // 默认关闭自动添加标签
  lastTestStatus: null,
  lastTestAt: null,
  lastTestNoteUrl: null,
  lastTestError: null,
};

// Content extraction types
export interface ExtractResult {
  title: string;
  sourceUrl: string;
  domain: string;
  author?: string;
  publishTime?: string;
  clipKind?: ClipKind;
  contentHtml: string;
  blocks: ContentBlock[];
  images: ImageCandidate[];
  wordCount: number;
}

export interface ContentBlockLayout {
  preserveInlineParagraphs?: boolean;
  groupId?: string;
  role?: 'original' | 'translation' | 'spacer' | 'normal';
}

export interface ContentBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'image' | 'other';
  html: string;
  text: string;
  level?: number; // for headings
  layout?: ContentBlockLayout;
}

export interface ImageCandidate {
  id: string;
  url: string;              // Original URL from DOM (used for HTML matching)
  normalizedUrl: string;    // Normalized URL (used for upload, highest quality)
  kind: 'img' | 'srcset' | 'lazy' | 'background' | 'data' | 'blob' | 'og' | 'preload';
  order: number;
  inMainContent: boolean;
  width?: number;
  height?: number;
  alt?: string;
}

// Image processing types
export type ImageFailureReason =
  | 'AUTH_OR_HOTLINK'
  | 'NOT_FOUND'
  | 'TIMEOUT_OR_NET'
  | 'CORS_OR_BLOCKED'
  | 'INVALID_URL'
  | 'UNKNOWN';

export interface ImageProcessResult {
  id: string;
  originalUrl: string;
  success: boolean;
  assetUrl?: string;
  fileId?: string;
  uid?: string;
  failureReason?: ImageFailureReason;
}

// Note creation types
export interface NotePart {
  index: number;
  total: number;
  title: string;
  content: string;
  isIndex?: boolean;
}

export type ClipKind =
  | 'default'
  | 'twitter-post'
  | 'x-longform';

interface CreateNoteRequestBase {
  index: number;
  total: number;
  title: string;
  isIndex?: boolean;
}

export interface HtmlCreateNoteRequest extends CreateNoteRequestBase {
  createMode: 'html';
  content: string;
  sourceUrl?: string;
}

export interface BodyCreateNoteRequest extends CreateNoteRequestBase {
  createMode: 'body';
  body: {
    type: string;
    content?: unknown[];
  };
}

export type CreateNoteRequest =
  | HtmlCreateNoteRequest
  | BodyCreateNoteRequest;

export interface NoteCreateResult {
  success: boolean;
  noteId?: string;
  noteUrl?: string;      // URL for jumping (based on public/private setting)
  shareUrl?: string;     // URL for sharing/collection (always /detail/)
  notes?: Array<{
    partIndex: number;
    noteUrl: string;
    isIndex?: boolean;
  }>;
  error?: string;
  errorCode?: string;
}

// Save progress types
export type SaveStatus =
  | 'idle'
  | 'extracting'
  | 'uploading'
  | 'uploading_images'
  | 'creating'
  | 'creating_note'
  | 'paused'
  | 'cancelling'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface SaveProgress {
  status: SaveStatus;
  currentPart?: number;
  totalParts?: number;
  uploadedImages?: number;
  totalImages?: number;
  failedImages?: number;
  notes?: Array<{
    partIndex: number;
    noteUrl: string;
    isIndex?: boolean;
  }>;
  error?: string;
  errorCode?: string;
}

// Message types for communication between popup/content/background
export type MessageType =
  | 'EXTRACT_CONTENT'
  | 'EXTRACT_RESULT'
  | 'SAVE_NOTE'
  | 'SAVE_PROGRESS'
  | 'SAVE_COMPLETE'
  | 'GET_SETTINGS'
  | 'SETTINGS_RESULT'
  | 'SAVE_SETTINGS'
  | 'FETCH_IMAGE'
  | 'FETCH_IMAGE_RESULT'
  | 'FETCH_IMAGE_AS_DATA_URL'
  // 划线功能消息类型
  | 'SAVE_HIGHLIGHT'
  | 'HIGHLIGHT_RESULT'
  | 'GET_HIGHLIGHT_NOTE_ID'
  | 'CLEAR_HIGHLIGHT_NOTE_ID';

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}

// API types
export interface ApiError {
  code: string;
  message: string;
}

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NETWORK: 'NETWORK',
  AMBIGUOUS_CREATE: 'AMBIGUOUS_CREATE',
  RATE_LIMIT: 'RATE_LIMIT',
  CONTENT_TOO_LONG: 'CONTENT_TOO_LONG',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  UNKNOWN: 'UNKNOWN',
} as const;

export const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'API Key 无效或已过期，请重新生成。',
  NETWORK: '网络异常，请稍后再试。',
  AMBIGUOUS_CREATE: '创建请求超时或连接中断，服务端可能已成功创建笔记，请先到墨问检查后再重试。',
  RATE_LIMIT: '请求过于频繁，请稍后再试。',
  CONTENT_TOO_LONG: '内容超过长度限制。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后再试。',
  PERMISSION_DENIED: '该功能仅限 Pro 会员使用，请升级后再试。',
  UNKNOWN: '操作失败，请重试。',
};

// NoteAtom structure for API
export interface NoteAtom {
  type: 'text' | 'image' | 'heading' | 'list' | 'quote' | 'code' | 'divider';
  content?: string;
  level?: number;
  url?: string;
  alt?: string;
  items?: string[];
  ordered?: boolean;
  language?: string;
}

// ============================================
// 划线功能类型定义
// ============================================

/**
 * 单条划线数据
 */
export interface Highlight {
  id: string;                    // 唯一标识（UUID）
  text: string;                  // 划线文本内容
  html?: string;                 // 保留原始 HTML 格式
  sourceUrl: string;             // 来源页面 URL
  pageTitle: string;             // 页面标题
  createdAt: string;             // 创建时间 ISO 8601
  noteId?: string;               // 关联的墨问笔记 ID
  noteUrl?: string;              // 笔记 URL
}

/**
 * 保存划线请求载荷
 */
export interface SaveHighlightPayload {
  highlight: Highlight;
  isPublic: boolean;
  enableAutoTag?: boolean;
  existingNoteId?: string;       // 如果存在，则追加到该笔记
  existingBody?: Record<string, unknown>;  // 本地缓存的笔记 body，避免调用 getNote API
}

/**
 * 划线保存结果
 */
export interface HighlightSaveResult {
  success: boolean;
  noteId?: string;
  noteUrl?: string;
  isAppend: boolean;             // 是否为追加模式
  error?: string;
  errorCode?: string;
  updatedBody?: Record<string, unknown>;  // 追加成功后返回更新的 body，供前端缓存
}

/**
 * 页面划线缓存数据（存储在 chrome.storage.local）
 */
export interface HighlightNoteCache {
  noteId: string;
  noteUrl: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: string;
  lastUpdatedAt: string;
  highlightCount: number;
  body?: Record<string, unknown>;  // 本地缓存的笔记 body（NoteAtom 格式）
  expiresAt?: string;  // 缓存过期时间 ISO 8601（24 小时后）
}

// ============================================
// 划线功能禁用状态类型定义
// ============================================

/**
 * 划线功能禁用状态
 */
export interface HighlightDisableState {
  globalDisabled: boolean;           // 全局禁用
  disabledDomains: string[];         // 被禁用的域名列表
  excludedUrls: string[];            // 排除的 URL 前缀列表
}

/**
 * 划线禁用存储 Key
 */
export const HIGHLIGHT_STORAGE_KEYS = {
  /** 全局禁用开关 */
  GLOBAL_DISABLED: 'highlight_disabled',
  /** 被禁用的域名列表 */
  DISABLED_DOMAINS: 'highlight_disabled_domains',
  /** 排除的 URL 前缀列表 */
  EXCLUDED_URLS: 'highlight_excluded_urls',
} as const;

/**
 * 预设排除网址（墨问编辑器）
 */
export const DEFAULT_EXCLUDED_URLS: string[] = [
  'https://note.mowen.cn/editor',
  'https://dev-note.mowen.cn/editor',
];

// ============================================
// PDF 导出 & 笔记列表管理类型定义
// ============================================

/**
 * 笔记列表项（来自 workbench API）
 */
export interface MowenNoteItem {
  uuid: string;
  title: string;
  digest: string;
  createdAt: string | number;
  tags?: string[];
  coverImage?: string;
  isCollection?: boolean;   // 是否为合集笔记
  canExpandChildren?: boolean; // 是否可展开子笔记
  isTop?: boolean;           // 是否为置顶笔记
  childNoteIds?: string[];  // 合集子笔记 UUID 列表（展开后填充）
}

/**
 * 笔记详情（来自 show API）
 */
export interface MowenNoteDetail {
  uuid: string;
  title: string;
  htmlContent: string;  // 完整 HTML 正文
  tags?: string[];
  childNoteIds?: string[];
}

/**
 * PDF 导出进度状态
 */
export type PdfExportStatus = 'idle' | 'fetching' | 'converting' | 'downloading' | 'success' | 'failed';

/**
 * PDF 导出进度信息
 */
export interface PdfExportProgress {
  status: PdfExportStatus;
  current?: number;      // 当前处理的序号
  total?: number;        // 总数
  currentTitle?: string; // 当前处理的笔记标题
  error?: string;
}

/**
 * 批量导出上限
 */
export const PDF_EXPORT_MAX_COUNT = 10;

/**
 * PDF 导出设置
 */
export interface PdfExportSettings {
  /** 导出方式：合并为单个 PDF / 分别导出多个 PDF */
  exportMode: 'merged' | 'separate';
  /** 是否保留图片（关闭后仅导出文本与基础元信息） */
  includeImages: boolean;
}

/**
 * 笔记列表分页参数
 */
export interface NoteListPaging {
  hint: string;  // 游标，首页为空字符串
  size: number;  // 每页数量
}

/**
 * 笔记列表过滤参数
 */
export interface NoteListFilter {
  benchType: number;  // 1=我的笔记
}

/**
 * 墨问网页登录态检查结果
 */
export type MowenLoginStatus = 'logged_in' | 'logged_out' | 'error';

export interface MowenLoginStatusResult {
  status: MowenLoginStatus;
  error?: string;
  errorCode?: string;
}
