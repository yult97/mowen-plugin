import DOMPurify from 'dompurify';

import type { ExtractResult, ImageCandidate } from '../types';
import { generateId, stripHtml } from './helpers';
import { htmlToNoteAtom, noteAtomToHtml } from './noteAtom';

const EDITABLE_PREVIEW_TAGS = [
  'a', 'blockquote', 'br', 'code', 'div', 'em', 'figcaption', 'figure',
  'img', 'li', 'mark', 'ol', 'p', 'pre', 'span', 'strong', 'ul',
] as const;

const EDITABLE_PREVIEW_ATTRS = [
  'alt', 'class', 'data-mowen-caption', 'data-mowen-id', 'href', 'rel', 'src', 'target', 'title',
] as const;

const BLOCK_TAGS = new Set(['DIV', 'P']);
const PREVIEW_INVISIBLE_TEXT_PATTERN = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/g;
const ORDERED_LIST_PATTERN = /^\d+(?:[.)]|、)\s+/;
const BULLET_LIST_PATTERN = /^[•·▪◦●○]\s+/;

export function sanitizeEditablePreviewHtml(html: string): string {
  if (!html.trim()) {
    return '';
  }

  let sanitized = html;

  try {
    const purified = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...EDITABLE_PREVIEW_TAGS],
      ALLOWED_ATTR: [...EDITABLE_PREVIEW_ATTRS],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      KEEP_CONTENT: true,
    });

    if (typeof purified === 'string') {
      sanitized = purified;
    }
  } catch {
    sanitized = html;
  }

  return normalizeEditablePreviewHtml(sanitized);
}

export function hasEditablePreviewContent(html: string): boolean {
  const sanitized = sanitizeEditablePreviewHtml(html);
  return stripPreviewFormatting(stripHtml(sanitized)).length > 0 || /<img\b/i.test(sanitized);
}

export function buildMowenPreviewBodyHtml(html: string): string {
  const sanitized = sanitizeEditablePreviewHtml(html);
  if (!sanitized) {
    return '';
  }

  const previewImages = new Map<string, { src: string; imageId: string; caption: string }>();
  const decoratedHtml = sanitized.replace(/<img\b([^>]*)>/gi, (fullMatch, rawAttributes: string) => {
    const src = extractAttribute(rawAttributes || '', 'src');
    if (!src || (!isRemoteImageUrl(src) && !isImageDataUrl(src))) {
      return fullMatch;
    }

    const previewUuid = `preview-${generateId()}`;
    previewImages.set(previewUuid, {
      src,
      imageId: extractAttribute(rawAttributes || '', 'data-mowen-id'),
      caption: extractAttribute(rawAttributes || '', 'data-mowen-caption') || extractAttribute(rawAttributes || '', 'alt'),
    });

    if (/data-mowen-uid\s*=/.test(rawAttributes)) {
      return fullMatch;
    }

    return fullMatch.replace(/<img\b/i, `<img data-mowen-uid="${previewUuid}"`);
  });

  const atom = htmlToNoteAtom(decoratedHtml, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  });
  const finalHtml = noteAtomToHtml(atom, {
    resolveImageUrl: (uuid) => previewImages.get(uuid)?.src || uuid,
  });
  return stripPreviewInvisibleTextFromHtml(
    finalizeMowenPreviewHtml(reattachPreviewImageMetadata(finalHtml, Array.from(previewImages.values())))
  );
}

export function buildEditedPreviewExtractResult(params: {
  extractResult: ExtractResult;
  title: string;
  html: string;
  baselineHtml?: string;
}): ExtractResult {
  const sanitizedHtml = sanitizeEditablePreviewHtml(params.html);
  const normalizedComparisonHtml = stripPreviewInvisibleTextFromHtml(sanitizedHtml);
  const baselineHtml = params.baselineHtml
    ? stripPreviewInvisibleTextFromHtml(sanitizeEditablePreviewHtml(params.baselineHtml))
    : '';

  if (baselineHtml && normalizedComparisonHtml === baselineHtml) {
    return {
      ...params.extractResult,
      title: params.title,
    };
  }

  const images = collectPreviewImageCandidates(sanitizedHtml, params.extractResult.images);

  return {
    ...params.extractResult,
    title: params.title,
    contentHtml: buildMowenPreviewBodyHtml(sanitizedHtml),
    blocks: [],
    images,
    wordCount: stripPreviewFormatting(stripHtml(sanitizedHtml)).length,
  };
}

function normalizeEditablePreviewHtml(html: string): string {
  if (!html.trim() || typeof DOMParser === 'undefined') {
    return html.trim();
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div data-md-import-preview-root="1">${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLDivElement | null;
  if (!root) {
    return html.trim();
  }

  collapseBlankBlockRuns(root, doc);
  return root.innerHTML.trim();
}

function finalizeMowenPreviewHtml(html: string): string {
  if (!html.trim()) {
    return '';
  }

  if (typeof DOMParser === 'undefined') {
    return stripMarkdownDividerBlocksFromHtml(html.trim());
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div data-md-import-preview-root="1">${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLDivElement | null;
  if (!root) {
    return html.trim();
  }

  removeMarkdownDividerBlocks(root);
  decorateCodeBlocks(root);
  decorateListParagraphs(root);
  collapseBlankBlockRuns(root, doc);
  return root.innerHTML.trim();
}

function collapseBlankBlockRuns(root: HTMLElement, doc: Document): void {
  const children = Array.from(root.children);
  let previousWasBlank = false;

  for (const child of children) {
    if (!(child instanceof HTMLElement) || !BLOCK_TAGS.has(child.tagName)) {
      previousWasBlank = false;
      continue;
    }

    if (!isBlankBlock(child)) {
      previousWasBlank = false;
      continue;
    }

    if (previousWasBlank) {
      child.remove();
      continue;
    }

    const spacer = doc.createElement('p');
    spacer.appendChild(doc.createElement('br'));
    child.replaceWith(spacer);
    previousWasBlank = true;
  }

  while (root.firstElementChild && isBlankBlock(root.firstElementChild as HTMLElement)) {
    root.firstElementChild.remove();
  }

  while (root.lastElementChild && isBlankBlock(root.lastElementChild as HTMLElement)) {
    root.lastElementChild.remove();
  }
}

function removeMarkdownDividerBlocks(root: HTMLElement): void {
  const blockCandidates = root.querySelectorAll('p,div');
  blockCandidates.forEach((node) => {
    if (!(node instanceof HTMLElement) || !isMarkdownDividerBlock(node)) {
      return;
    }

    node.remove();
  });
}

function decorateCodeBlocks(root: HTMLElement): void {
  const codeBlocks = root.querySelectorAll('pre');
  codeBlocks.forEach((node) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    node.classList.add('md-import-codeblock');

    const code = node.querySelector('code');
    if (!(code instanceof HTMLElement)) {
      return;
    }

    const language = extractCodeLanguage(code.className);
    if (!language) {
      return;
    }

    node.dataset.language = language;
  });
}

function decorateListParagraphs(root: HTMLElement): void {
  Array.from(root.querySelectorAll('p')).forEach((node) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    node.classList.remove('md-import-list-paragraph', 'md-import-list-paragraph-bullet', 'md-import-list-paragraph-ordered');

    if (node.closest('blockquote, pre, figure')) {
      return;
    }

    const text = normalizeListParagraphText(node.textContent || '');
    if (!text) {
      return;
    }

    if (ORDERED_LIST_PATTERN.test(text)) {
      node.classList.add('md-import-list-paragraph', 'md-import-list-paragraph-ordered');
      return;
    }

    if (BULLET_LIST_PATTERN.test(text)) {
      node.classList.add('md-import-list-paragraph', 'md-import-list-paragraph-bullet');
    }
  });
}

function reattachPreviewImageMetadata(
  html: string,
  images: Array<{ src: string; imageId: string; caption: string }>
): string {
  if (!html.trim() || images.length === 0 || typeof DOMParser === 'undefined') {
    return html;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div data-md-import-preview-root="1">${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLDivElement | null;
  if (!root) {
    return html;
  }

  Array.from(root.querySelectorAll('img')).forEach((node) => {
    if (!(node instanceof HTMLImageElement)) {
      return;
    }

    const matched = images.find((image) => image.src === node.getAttribute('src'));
    if (!matched) {
      return;
    }

    if (matched.imageId) {
      node.setAttribute('data-mowen-id', matched.imageId);
    }
    if (matched.caption) {
      node.setAttribute('data-mowen-caption', matched.caption);
    }
  });

  return root.innerHTML.trim();
}

function isBlankBlock(element: HTMLElement): boolean {
  const text = (element.textContent || '').replace(/\u00a0/g, ' ').trim();
  if (text.length > 0) {
    return false;
  }

  const meaningfulMedia = element.querySelector('img,figure,blockquote,pre,ul,ol');
  return !meaningfulMedia;
}

function isMarkdownDividerBlock(element: HTMLElement): boolean {
  if (element.querySelector('img,figure,blockquote,pre,ul,ol')) {
    return false;
  }

  const text = (element.textContent || '').replace(/\u00a0/g, ' ').trim();
  return /^(?:-{3,}|_{3,}|\*{3,}|[─—]{3,})$/.test(text);
}

function stripMarkdownDividerBlocksFromHtml(html: string): string {
  return html.replace(
    /<(p|div)\b[^>]*>\s*(?:-{3,}|_{3,}|\*{3,}|[─—]{3,})\s*<\/\1>\s*/gi,
    ''
  ).trim();
}

function collectPreviewImageCandidates(
  html: string,
  baseImages: ImageCandidate[]
): ImageCandidate[] {
  const matches = Array.from(html.matchAll(/<img\b([^>]*)>/gi));
  if (matches.length === 0) {
    return [];
  }

  const deduped = new Map<string, ImageCandidate>();
  matches.forEach((match, index) => {
    const attrs = match[1] || '';
    const src = extractAttribute(attrs, 'src');
    if (!src || (!isRemoteImageUrl(src) && !isImageDataUrl(src))) {
      return;
    }

    const alt = extractAttribute(attrs, 'alt') || undefined;
    const imageId = extractAttribute(attrs, 'data-mowen-id');
    const found = imageId
      ? baseImages.find((image) => image.id === imageId)
      : baseImages.find((image) => image.normalizedUrl === src || image.url === src);
    const key = `${src}`;
    if (deduped.has(key)) {
      return;
    }

    deduped.set(key, found ? {
      ...found,
      order: index,
      alt: alt || found.alt,
    } : {
      id: imageId || `mdimg-${generateId()}`,
      url: src,
      normalizedUrl: src,
      kind: isImageDataUrl(src) ? 'data' : 'img',
      order: index,
      inMainContent: true,
      alt,
    });
  });

  return Array.from(deduped.values());
}

function stripPreviewFormatting(text: string): string {
  return text.replace(PREVIEW_INVISIBLE_TEXT_PATTERN, '');
}

function stripPreviewInvisibleTextFromHtml(html: string): string {
  return html.replace(PREVIEW_INVISIBLE_TEXT_PATTERN, '');
}

function normalizeListParagraphText(text: string): string {
  return stripPreviewFormatting(text)
    .replace(/\u00A0/g, ' ')
    .trimStart();
}

function extractAttribute(rawAttributes: string, name: string): string {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = rawAttributes.match(pattern);
  return (match?.[2] || match?.[3] || match?.[4] || '').trim();
}

function extractCodeLanguage(className: string): string {
  const match = className.match(/\blanguage-([a-z0-9#+-]+)\b/i);
  return match?.[1]?.toLowerCase() || '';
}

function isRemoteImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value);
}
