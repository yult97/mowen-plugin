const EXTENSION_PAGE_PREFIX = chrome.runtime.getURL('');
const ALLOWED_MOWEN_WEB_API_PATHS = new Set([
  '/api/note/entry/v1/note/workbench',
  '/api/note/entry/v1/note/tops',
  '/api/note/wxa/v1/note/show',
  '/api/note/wxa/v1/gallery/infos',
  '/api/note/entry/v1/note/ref/infos',
]);

export function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_PAGE_PREFIX);
}

export function isAllowedMowenWebApiPath(path: string): boolean {
  return ALLOWED_MOWEN_WEB_API_PATHS.has(path);
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;

  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;

  const private172 = normalized.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

export function isAllowedImageProxyUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    return !isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function shouldIncludeImageProxyCredentials(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return /(^|\.)mowen\.cn$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}
