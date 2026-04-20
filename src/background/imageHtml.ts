import { ImageCandidate, ImageProcessResult } from '../types';

interface ImageReplacementAction {
  kind: 'inject_uid' | 'replace_with_link';
  imageId?: string;
  originalUrl: string;
  uid?: string;
  label?: string;
}

export function replaceImageUrls(
  content: string,
  imageResults: ImageProcessResult[],
  extraImages: ImageCandidate[]
): string {
  const actions: ImageReplacementAction[] = [
    ...imageResults
      .filter((result) => result.success && result.uid)
      .map((result) => ({
        kind: 'inject_uid' as const,
        imageId: result.id,
        originalUrl: result.originalUrl,
        uid: result.uid!,
      })),
    ...imageResults
      .filter((result) => !result.success)
      .map((result) => ({
        kind: 'replace_with_link' as const,
        imageId: result.id,
        originalUrl: result.originalUrl,
      })),
    ...extraImages.map((image) => ({
      kind: 'replace_with_link' as const,
      imageId: image.id,
      originalUrl: image.url,
      label: buildImageFallbackLabel(image.alt),
    })),
  ];

  let successCount = 0;
  let failCount = 0;

  const processed = content.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const tagUrls = extractImageUrlsFromTag(imgTag);
    const tagImageId = extractImageIdFromTag(imgTag);
    const action = tagImageId
      ? actions.find((candidate) => candidate.imageId === tagImageId)
      : actions.find((candidate) => tagUrls.some((url) => matchesImageUrl(url, candidate.originalUrl)));

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

export function removeAllImageTags(content: string): string {
  return content.replace(/<img[^>]*>/gi, '');
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

function extractImageIdFromTag(imgTag: string): string {
  const idMatch = imgTag.match(/data-mowen-id=["']([^"']+)["']/i);
  return idMatch?.[1]?.trim() || '';
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
