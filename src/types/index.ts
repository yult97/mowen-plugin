// Settings types
export interface Settings {
  apiKey: string;
  defaultPublic: boolean;
  defaultIncludeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  debugMode: boolean;
  lastTestStatus?: 'success' | 'failed' | null;
  lastTestAt?: string | null;
  lastTestNoteUrl?: string | null;
  lastTestError?: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  defaultPublic: false,
  defaultIncludeImages: true,
  maxImages: 10,
  createIndexNote: true,
  debugMode: false,
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
  contentHtml: string;
  blocks: ContentBlock[];
  images: ImageCandidate[];
  wordCount: number;
}

export interface ContentBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'image' | 'other';
  html: string;
  text: string;
  level?: number; // for headings
}

export interface ImageCandidate {
  id: string;
  url: string;
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

export interface NoteCreateResult {
  success: boolean;
  noteId?: string;
  noteUrl?: string;      // URL for jumping (based on public/private setting)
  shareUrl?: string;     // URL for sharing/collection (always /detail/)
  error?: string;
  errorCode?: string;
}

// Save progress types
export type SaveStatus = 'idle' | 'extracting' | 'uploading' | 'creating' | 'success' | 'failed' | 'cancelled';

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
  | 'TEST_CONNECTION'
  | 'TEST_RESULT'
  | 'GET_SETTINGS'
  | 'SETTINGS_RESULT'
  | 'SAVE_SETTINGS'
  | 'FETCH_IMAGE'
  | 'FETCH_IMAGE_RESULT';

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
  RATE_LIMIT: 'RATE_LIMIT',
  CONTENT_TOO_LONG: 'CONTENT_TOO_LONG',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;

export const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'API Key 无效或已过期，请重新生成。',
  NETWORK: '网络异常，请稍后再试。',
  RATE_LIMIT: '请求过于频繁，请稍后再试。',
  CONTENT_TOO_LONG: '内容超过长度限制。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后再试。',
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
