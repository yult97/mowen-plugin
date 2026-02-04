export function debugLog(...args: unknown[]): void {
  // Check debug mode from storage
  chrome.storage.sync.get('mowen_settings', (result) => {
    if (result.mowen_settings?.debugMode) {
      console.log('[墨问笔记助手]', ...args);
    }
  });
}

export function formatDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function getDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function getTextLength(html: string): number {
  // Pure string-based HTML text extraction (Service Worker compatible)
  return stripHtmlTags(html).length;
}

export function stripHtml(html: string): string {
  // Pure string-based HTML tag removal (Service Worker compatible)
  return stripHtmlTags(html);
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

export function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isWeixinArticle(url: string): boolean {
  return url.includes('mp.weixin.qq.com');
}

export function parseErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid key')) {
      return 'UNAUTHORIZED';
    }
    if (msg.includes('429') || msg.includes('rate') || msg.includes('limit')) {
      return 'RATE_LIMIT';
    }
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) {
      return 'NETWORK';
    }
    if (msg.includes('too long') || msg.includes('字数') || msg.includes('超')) {
      return 'CONTENT_TOO_LONG';
    }
  }
  return 'UNKNOWN';
}

/**
 * 检查页面标题是否有效（非空、非通用、长度适中）
 * 用于判断是否需要从正文中提取标题
 */
export function isValidPageTitle(title: string): boolean {
  if (!title || title.trim().length <= 2) {
    return false;
  }

  const trimmed = title.trim();

  // 标题过长（超过 50 字）视为无效，可能是把正文当标题了
  if (trimmed.length > 50) {
    return false;
  }

  const lowerTrimmed = trimmed.toLowerCase();

  // 通用/无效标题列表
  const invalidTitles = [
    'untitled',
    '无标题',
    '新建标签页',
    'new tab',
    'loading',
    '加载中',
    'undefined',
    'null',
  ];

  return !invalidTitles.includes(lowerTrimmed);
}

/**
 * 从文本中提取标题（第一句话，不超过指定长度）
 * 用于划线笔记在页面标题不可用时的降级处理
 * 
 * @param text 原始文本
 * @param maxLength 标题最大长度，默认 30
 * @returns { title: 提取的标题, remainingText: 剩余文本 }
 */
export function extractTitleFromText(text: string, maxLength: number = 30): {
  title: string;
  remainingText: string;
} {
  if (!text || text.trim().length === 0) {
    return { title: '', remainingText: '' };
  }

  const trimmedText = text.trim();

  // 句子结束符（中英文句号、问号、感叹号、换行符）
  const sentenceEndPattern = /[。.!！?？\n]/;
  const match = trimmedText.match(sentenceEndPattern);

  let firstSentence: string;
  let remaining: string;

  if (match && match.index !== undefined && match.index < maxLength) {
    // 找到句子结束符，且在 maxLength 范围内
    firstSentence = trimmedText.substring(0, match.index + 1).trim();
    remaining = trimmedText.substring(match.index + 1).trim();
  } else {
    // 没找到句子结束符或超出范围，直接截取 maxLength 字符
    if (trimmedText.length <= maxLength) {
      firstSentence = trimmedText;
      remaining = '';
    } else {
      firstSentence = trimmedText.substring(0, maxLength).trim() + '...';
      remaining = trimmedText.substring(maxLength).trim();
    }
  }

  return {
    title: firstSentence,
    remainingText: remaining,
  };
}
