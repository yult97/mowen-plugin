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
