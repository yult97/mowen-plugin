/**
 * Twitter/X 专用内容提取器
 * 
 * 只提取推文正文内容，排除所有动态元素（点赞数、时间戳、评论等），
 * 确保每次提取的字数稳定一致。
 * 支持提取 Quote Tweet（引用推文）并格式化为引用块。
 */

import { ClipKind, ExtractResult, ContentBlock, ImageCandidate } from '../types';
import { generateId } from '../utils/helpers';
import { extractImages } from './images';
import { TWITTER_SELECTORS } from '../config/site-selectors';
import { normalizeImageUrl } from './imageNormalizer';
import { detectCodeLanguage } from '../utils/shikiLanguages';
import {
    alignBilingualSegmentRuns,
    buildBilingualTweetParagraphSegments,
    createTweetParagraphSpacerSegment,
    isTranslatedTweetParagraphPair,
    normalizeStructuredSequence,
} from './twitter/bilingual';
import type { BilingualAlignmentOptions } from './twitter/bilingual';
import {
    createStructuredTwitterSpacerBlock,
    isStructuredTwitterSpacerBlock,
    normalizeStructuredTwitterBlocks,
} from './twitter/blockLayout';
import {
    buildTwitterCardSegments,
    isTwitterCardMetadataText,
} from './twitter/card';
import { classifyTwitterContent } from './twitter/classify';
import {
    detectTwitterSegmentLanguage,
    getDominantTwitterLanguage,
    getSegmentJoiner,
    looksLikeStandaloneHeading,
    splitMixedLanguageText,
    startsWithExplicitBlockMarker,
    endsWithHardParagraphBoundary,
} from './twitter/language';
import {
    deriveTwitterTitle,
    getFirstNonEmptyLine,
} from './twitter/title';
import { TranslationPairSegment, TwitterClipKind, TwitterTextSegment } from './twitter/types';

function toExtractClipKind(kind: TwitterClipKind): Exclude<ClipKind, 'default'> {
    return kind === 'tweet' ? 'twitter-post' : 'x-longform';
}

/**
 * 翻译插件 DOM 选择器常量
 * 覆盖沉浸式翻译所有主题变体及其他常见翻译插件
 */
const TRANSLATION_PLUGIN_SELECTORS = [
    // 沉浸式翻译 - 外层包装
    'font.immersive-translate-target-wrapper',
    '[data-immersive-translate-translation-element-mark="1"]',
    // 沉浸式翻译 - 内层包装（各主题变体）
    'font.immersive-translate-target-inner',
    '.immersive-translate-target-translation-theme-none',
    // 宽泛兜底：覆盖所有沉浸式翻译主题（dashed, dotted, mask, highlight 等）
    '[class*="immersive-translate-target"]',
    // 其他翻译插件
    '.translated-text',
    '[data-transno-translation]',
];

/**
 * 沉浸式翻译外层包装器选择器（用于在翻译前插入 <br> 分隔）
 */
const TRANSLATION_OUTER_WRAPPER_SELECTORS = [
    'font.immersive-translate-target-wrapper',
    '[data-immersive-translate-translation-element-mark="1"]',
];

/**
 * 沉浸式翻译内层包装器选择器（用于 unwrap）
 */
const TRANSLATION_INNER_WRAPPER_SELECTORS = [
    'font.immersive-translate-target-inner',
    '.immersive-translate-target-translation-theme-none',
    '[class*="immersive-translate-target"]',
    '.translated-text',
    '[data-transno-translation]',
];

const TRANSLATION_PLUGIN_SELECTOR = TRANSLATION_PLUGIN_SELECTORS.join(', ');
const TRANSLATION_OUTER_WRAPPER_SELECTOR = TRANSLATION_OUTER_WRAPPER_SELECTORS.join(', ');
const TRANSLATION_INNER_WRAPPER_SELECTOR = TRANSLATION_INNER_WRAPPER_SELECTORS.join(', ');
const TWITTER_CARD_DETAIL_SELECTOR = '[data-testid^="card.layout"][data-testid$=".detail"], [data-testid*="card.layout"][data-testid$=".detail"]';

/**
 * 辅助函数：修剪提取到的文本段
 * 去除首尾空白，合并连续空行为单个换行
 */
function trimExtractedSegmentText(text: string): string {
    return text
        .replace(/^\s+|\s+$/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 辅助函数：归一化文本
 * 去除标点、空格、特殊符号，仅保留文字和数字，用于模糊匹配去重
 */
function normalizeText(text: string): string {
    return text.replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase();
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function serializeElementAttributes(element: Element | null): string {
    if (!element) {
        return '';
    }

    return Array.from(element.attributes)
        .map((attribute) => `${attribute.name}="${attribute.value}"`)
        .join(' ');
}

function normalizeCodeText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/^\n+|\n+$/g, '');
}

function extractNormalizedCodeBlock(pre: HTMLElement): { html: string; text: string } | null {
    const code = pre.querySelector('code');
    const rawText = code?.textContent || pre.textContent || '';
    const codeText = normalizeCodeText(rawText);

    if (!codeText.trim()) {
        return null;
    }

    const language = detectCodeLanguage(
        serializeElementAttributes(pre),
        serializeElementAttributes(code)
    ) || 'text';
    const escapedCode = escapeHtml(codeText);

    return {
        html: `<pre data-language="${language}"><code class="language-${language}">${escapedCode}</code></pre>`,
        text: codeText,
    };
}

function preserveTextNodeLineBreaks(root: HTMLElement): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    let currentNode = walker.nextNode();
    while (currentNode) {
        if (currentNode instanceof Text) {
            textNodes.push(currentNode);
        }
        currentNode = walker.nextNode();
    }

    textNodes.forEach((textNode) => {
        const value = textNode.nodeValue || '';
        if (!value.includes('\n') || !value.trim()) {
            return;
        }

        const parent = textNode.parentNode;
        if (!parent) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const parts = value.split(/\n+/);

        parts.forEach((part, index) => {
            if (part) {
                fragment.appendChild(document.createTextNode(part));
            }
            if (index < parts.length - 1) {
                fragment.appendChild(document.createElement('br'));
            }
        });

        parent.replaceChild(fragment, textNode);
    });
}

/**
 * 归一化沉浸式翻译等浏览器翻译插件在 DOM 中注入的翻译元素。
 *
 * 不删除翻译内容，而是：
 * 1. 在需要时于翻译包装器前面确保有 <br> 分隔（避免原文和翻译文粘连）
 * 2. 将翻译包装器的 <font> 等标签 unwrap（保留文本内容）
 *
 * 这样翻译内容会被保留在 innerText 和 innerHTML 中，
 * 且与原文之间有明确的换行分隔，后续拆分逻辑能正确处理。
 */
function normalizeTranslationPluginElements(
    root: HTMLElement,
    options: { insertBreakBeforeOuter?: boolean } = {}
): void {
    const { insertBreakBeforeOuter = true } = options;

    // 外层包装器：在翻译容器前插入 <br> 分隔，然后 unwrap
    const outerWrappers = root.querySelectorAll(TRANSLATION_OUTER_WRAPPER_SELECTOR);
    outerWrappers.forEach((wrapper) => {
        const parent = wrapper.parentNode;
        if (!parent) return;

        // 在翻译包装器前面确保有 <br> 分隔
        const prevSibling = wrapper.previousSibling;
        const hasBrBefore = prevSibling && prevSibling.nodeName === 'BR';
        if (insertBreakBeforeOuter && !hasBrBefore) {
            parent.insertBefore(document.createElement('br'), wrapper);
        }

        // unwrap：保留内部内容，移除外层 font 标签
        const fragment = document.createDocumentFragment();
        while (wrapper.firstChild) {
            fragment.appendChild(wrapper.firstChild);
        }
        parent.replaceChild(fragment, wrapper);
    });

    // 内层包装器也 unwrap（如 font.immersive-translate-target-inner）
    const innerWrappers = root.querySelectorAll(TRANSLATION_INNER_WRAPPER_SELECTOR);
    innerWrappers.forEach((inner) => {
        const parent = inner.parentNode;
        if (!parent) return;
        const fragment = document.createDocumentFragment();
        while (inner.firstChild) {
            fragment.appendChild(inner.firstChild);
        }
        parent.replaceChild(fragment, inner);
    });
}

function copyAnchorAttributes(source: HTMLAnchorElement, target: HTMLAnchorElement): void {
    Array.from(source.attributes).forEach((attribute) => {
        target.setAttribute(attribute.name, attribute.value);
    });
}

function findAssociatedTranslationAnchor(node: HTMLElement): HTMLAnchorElement | null {
    const closestAnchor = node.closest('a');
    if (closestAnchor instanceof HTMLAnchorElement) {
        return closestAnchor;
    }

    const findAnchorInDirection = (start: Element | null, direction: 'previous' | 'next'): HTMLAnchorElement | null => {
        let current: Element | null = start;
        while (current) {
            if (current instanceof HTMLElement && current.matches(TRANSLATION_PLUGIN_SELECTOR)) {
                current = direction === 'previous' ? current.previousElementSibling : current.nextElementSibling;
                continue;
            }

            if (current instanceof HTMLAnchorElement) {
                return current;
            }

            const nestedAnchor = current.querySelector('a');
            if (nestedAnchor instanceof HTMLAnchorElement) {
                return nestedAnchor;
            }

            break;
        }

        return null;
    };

    return findAnchorInDirection(node.previousElementSibling, 'previous')
        || findAnchorInDirection(node.nextElementSibling, 'next');
}

function wrapContainerChildrenWithAnchor(container: HTMLElement, anchorTemplate: HTMLAnchorElement): void {
    if (!container.firstChild) {
        return;
    }

    const anchor = document.createElement('a');
    copyAnchorAttributes(anchorTemplate, anchor);

    while (container.firstChild) {
        anchor.appendChild(container.firstChild);
    }

    container.appendChild(anchor);
}

function getTopLevelTranslationNodes(element: HTMLElement): HTMLElement[] {
    const translationNodes = Array.from(element.querySelectorAll(TRANSLATION_PLUGIN_SELECTOR))
        .filter((node): node is HTMLElement => node instanceof HTMLElement);

    return translationNodes.filter((node) => {
        return !translationNodes.some((other) => other !== node && other.contains(node));
    });
}

function trimBoundaryBreakNodes(container: HTMLElement): void {
    const isIgnorableBoundaryNode = (node: ChildNode | null): boolean => {
        if (!node) {
            return false;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            return !node.nodeValue?.trim();
        }

        return node instanceof HTMLElement && node.tagName === 'BR';
    };

    while (isIgnorableBoundaryNode(container.firstChild)) {
        container.removeChild(container.firstChild!);
    }

    while (isIgnorableBoundaryNode(container.lastChild)) {
        container.removeChild(container.lastChild!);
    }
}

function splitHtmlIntoParagraphSegments(
    html: string,
    options: { singleBreakAsBoundary?: boolean } = {}
): Array<{ html: string; text: string }> {
    const { singleBreakAsBoundary = false } = options;
    const container = document.createElement('div');
    container.innerHTML = html;

    const segments: Array<{ html: string; text: string }> = [];
    let currentNodes: Node[] = [];
    let pendingBreakCount = 0;

    const flushSegment = () => {
        if (currentNodes.length === 0) {
            return;
        }

        const segmentContainer = document.createElement('div');
        currentNodes.forEach((node) => segmentContainer.appendChild(node));
        trimBoundaryBreakNodes(segmentContainer);

        const segmentHtml = segmentContainer.innerHTML.trim();
        const segmentText = trimExtractedSegmentText(segmentContainer.innerText || segmentContainer.textContent || '');

        if (segmentHtml && segmentText) {
            segments.push({
                html: segmentHtml,
                text: segmentText,
            });
        }

        currentNodes = [];
    };

    Array.from(container.childNodes).forEach((node) => {
        if (node.nodeName === 'BR') {
            pendingBreakCount += 1;
            return;
        }

        if (pendingBreakCount >= 2 || (singleBreakAsBoundary && pendingBreakCount >= 1)) {
            flushSegment();
        } else if (pendingBreakCount === 1 && currentNodes.length > 0) {
            currentNodes.push(document.createElement('br'));
        }

        pendingBreakCount = 0;
        currentNodes.push(node.cloneNode(true));
    });

    flushSegment();
    return segments;
}

function getFirstAnchorTemplateFromHtml(html: string): HTMLAnchorElement | null {
    const container = document.createElement('div');
    container.innerHTML = html;
    const anchor = container.querySelector('a');
    return anchor instanceof HTMLAnchorElement ? (anchor.cloneNode(false) as HTMLAnchorElement) : null;
}

function buildOriginalParagraphSegments(element: HTMLElement): Array<{ html: string; text: string; anchorTemplate?: HTMLAnchorElement }> {
    const originalClone = element.cloneNode(true) as HTMLElement;
    originalClone.querySelectorAll(TRANSLATION_PLUGIN_SELECTOR).forEach((node) => node.remove());
    normalizeTranslationPluginElements(originalClone, { insertBreakBeforeOuter: false });

    const normalizedHtml = normalizeXArticleInlineHtml(originalClone, { insertBreakBeforeTranslation: false });
    let segments = splitHtmlIntoParagraphSegments(normalizedHtml, { singleBreakAsBoundary: true })
        .map((segment) => ({
            ...segment,
            anchorTemplate: getFirstAnchorTemplateFromHtml(segment.html) || undefined,
        }));
    segments = refineXArticleParagraphSegments(segments).map((segment) => ({
        ...segment,
        anchorTemplate: getFirstAnchorTemplateFromHtml(segment.html) || undefined,
    }));

    const originalText = trimExtractedSegmentText(originalClone.innerText || originalClone.textContent || '');
    const textParagraphs = splitTweetTextParagraphs(originalText);
    if (textParagraphs.length > segments.length) {
        segments = refineXArticleParagraphSegments(textParagraphs.map((paragraphText) => ({
            html: escapeHtml(paragraphText),
            text: paragraphText,
        }))).map((segment) => ({
            ...segment,
            anchorTemplate: getFirstAnchorTemplateFromHtml(segment.html) || undefined,
        }));
    }

    if (segments.length === 0 && normalizedHtml.trim() && originalText) {
        segments = [{
            html: normalizedHtml.trim(),
            text: originalText,
            anchorTemplate: getFirstAnchorTemplateFromHtml(normalizedHtml) || undefined,
        }];
    }

    return segments;
}

function buildTranslationParagraphSegments(
    element: HTMLElement,
    originalSegments: Array<{ html: string; text: string; anchorTemplate?: HTMLAnchorElement }>
): Array<{ html: string; text: string }> {
    const translationNodes = getTopLevelTranslationNodes(element);
    if (translationNodes.length === 0) {
        return [];
    }

    const segments: Array<{ html: string; text: string }> = [];

    translationNodes.forEach((node, index) => {
        const fragmentContainer = document.createElement('div');
        fragmentContainer.appendChild(node.cloneNode(true));
        normalizeTranslationPluginElements(fragmentContainer, { insertBreakBeforeOuter: false });
        trimBoundaryBreakNodes(fragmentContainer);

        const fragmentText = trimExtractedSegmentText(fragmentContainer.innerText || fragmentContainer.textContent || '');
        if (!fragmentText) {
            return;
        }

        if (!fragmentContainer.querySelector('a')) {
            const associatedAnchor = originalSegments[index]?.anchorTemplate || findAssociatedTranslationAnchor(node);
            if (associatedAnchor) {
                wrapContainerChildrenWithAnchor(fragmentContainer, associatedAnchor);
            }
        }

        const normalizedHtml = normalizeXArticleInlineHtml(fragmentContainer, { insertBreakBeforeTranslation: false });
        let paragraphSegments = refineXArticleParagraphSegments(
            splitHtmlIntoParagraphSegments(normalizedHtml, { singleBreakAsBoundary: true })
        );
        const textParagraphs = splitTweetTextParagraphs(fragmentText);
        if (textParagraphs.length > paragraphSegments.length) {
            paragraphSegments = refineXArticleParagraphSegments(textParagraphs.map((paragraphText) => ({
                html: escapeHtml(paragraphText),
                text: paragraphText,
            })));
        }

        if (paragraphSegments.length > 0) {
            segments.push(...paragraphSegments);
            return;
        }

        const html = normalizedHtml.trim();
        if (html) {
            segments.push({
                html,
                text: fragmentText,
            });
        }
    });

    return segments;
}

interface XArticleBilingualGroup {
    id: string;
    original?: { html: string; text: string };
    translation?: { html: string; text: string };
}

interface XArticleOrderedSegment {
    kind: 'original' | 'translation';
    segments: Array<{ html: string; text: string; anchorTemplate?: HTMLAnchorElement }>;
}

interface XArticleRangeBoundary {
    container: Node;
    offset: number;
}

function atomizeSegmentsForBilingualAlignment(
    segments: Array<{ html: string; text: string }>
): Array<{ html: string; text: string }> {
    return segments.flatMap((segment) => {
        const trimmedText = segment.text.trim();
        const trimmedHtml = segment.html.trim();
        if (!trimmedText || !trimmedHtml) {
            return [];
        }

        const textLines = trimmedText
            .split(/\n+/)
            .flatMap((line) => splitXArticleAtomicTextUnits(line))
            .map((line) => line.trim())
            .filter(Boolean);
        if (textLines.length <= 1) {
            return [{ html: trimmedHtml, text: trimmedText }];
        }

        const atomicSegments = mergeXArticleContinuationSegments(
            textLines.map((line) => ({
                html: escapeHtml(line),
                text: line,
            }))
        );

        return atomicSegments.length > 0 ? atomicSegments : [{ html: trimmedHtml, text: trimmedText }];
    });
}

function canSplitBeforeInlineBlockMarker(text: string, markerIndex: number): boolean {
    let cursor = markerIndex - 1;

    while (cursor >= 0 && /\s/.test(text[cursor])) {
        cursor -= 1;
    }

    if (cursor < 0) {
        return true;
    }

    return /[\n。！？!?；;:：]/.test(text[cursor]);
}

function splitXArticleAtomicTextUnits(text: string): string[] {
    const normalized = text.trim();
    if (!normalized) {
        return [];
    }

    const markerRegex = /([→➜•\-–—*]|\d+\s*[-.:：)]|[A-Za-z]\)|[A-Za-z]\.)\s+/g;
    const splitIndexes: number[] = [0];
    let match: RegExpExecArray | null;

    while ((match = markerRegex.exec(normalized)) !== null) {
        const markerIndex = match.index;
        if (markerIndex <= 0) {
            continue;
        }

        const hasInlineListContext =
            startsWithExplicitBlockMarker(normalized) ||
            splitIndexes.length > 1;
        const hasWhitespaceBeforeMarker = /\s/.test(normalized[markerIndex - 1] || '');
        const shouldSplit =
            canSplitBeforeInlineBlockMarker(normalized, markerIndex) ||
            (hasInlineListContext && hasWhitespaceBeforeMarker);

        if (!shouldSplit) {
            continue;
        }

        splitIndexes.push(markerIndex);
    }

    if (splitIndexes.length === 1) {
        return [normalized];
    }

    splitIndexes.push(normalized.length);

    const segments: string[] = [];
    for (let index = 0; index < splitIndexes.length - 1; index++) {
        const segmentText = normalized
            .slice(splitIndexes[index], splitIndexes[index + 1])
            .trim();

        if (segmentText) {
            segments.push(segmentText);
        }
    }

    return segments.length > 0 ? segments : [normalized];
}

function buildXArticleBilingualGroups(
    originalSegments: Array<{ html: string; text: string }>,
    translationSegments: Array<{ html: string; text: string }>,
    options: BilingualAlignmentOptions = {}
): XArticleBilingualGroup[] {
    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return [];
    }

    const balancedSegments = alignBilingualSegmentRuns(
        atomizeSegmentsForBilingualAlignment(originalSegments),
        atomizeSegmentsForBilingualAlignment(translationSegments),
        options
    );
    const alignedOriginalSegments = balancedSegments.originalSegments;
    const alignedTranslationSegments = balancedSegments.translationSegments;

    if (alignedOriginalSegments.length !== alignedTranslationSegments.length) {
        console.warn(
            `[twitterExtractor] ⚠️ X Article 双语段落数不一致，按顺序对齐: original=${alignedOriginalSegments.length}, translation=${alignedTranslationSegments.length}`
        );
    }

    const total = Math.max(alignedOriginalSegments.length, alignedTranslationSegments.length);
    const groups: XArticleBilingualGroup[] = [];

    for (let index = 0; index < total; index++) {
        const original = alignedOriginalSegments[index];
        const translation = alignedTranslationSegments[index];

        if (!original && !translation) {
            continue;
        }

        groups.push({
            id: generateId(),
            ...(original ? { original } : {}),
            ...(translation ? { translation } : {}),
        });
    }

    return groups;
}

function getNodeChildIndex(node: Node): number {
    if (!node.parentNode) {
        return -1;
    }

    return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

function cloneXArticleRangeContainer(
    start: XArticleRangeBoundary,
    end: XArticleRangeBoundary
): HTMLElement {
    const range = document.createRange();
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);

    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    return container;
}

function buildXArticleOrderedSegments(element: HTMLElement): XArticleOrderedSegment[] {
    const root = element.cloneNode(true) as HTMLElement;
    const translationNodes = getTopLevelTranslationNodes(root);

    if (translationNodes.length === 0) {
        return [];
    }

    const orderedSegments: XArticleOrderedSegment[] = [];
    let start: XArticleRangeBoundary = {
        container: root,
        offset: 0,
    };

    translationNodes.forEach((translationNode) => {
        const parent = translationNode.parentNode;
        const offset = getNodeChildIndex(translationNode);
        if (!parent || offset < 0) {
            return;
        }

        const originalContainer = cloneXArticleRangeContainer(start, {
            container: parent,
            offset,
        });
        const originalSegments = buildOriginalParagraphSegments(originalContainer);
        if (originalSegments.length > 0) {
            orderedSegments.push({
                kind: 'original',
                segments: originalSegments,
            });
        }

        const translationContainer = document.createElement('div');
        translationContainer.appendChild(translationNode.cloneNode(true));
        const translationSegments = buildTranslationParagraphSegments(translationContainer, originalSegments);
        if (translationSegments.length > 0) {
            orderedSegments.push({
                kind: 'translation',
                segments: translationSegments,
            });
        }

        start = {
            container: parent,
            offset: offset + 1,
        };
    });

    const trailingContainer = cloneXArticleRangeContainer(start, {
        container: root,
        offset: root.childNodes.length,
    });
    const trailingOriginalSegments = buildOriginalParagraphSegments(trailingContainer);
    if (trailingOriginalSegments.length > 0) {
        orderedSegments.push({
            kind: 'original',
            segments: trailingOriginalSegments,
        });
    }

    return orderedSegments.filter((segment) => segment.segments.length > 0);
}

function buildXArticleBilingualGroupsFromOrderedSegments(
    orderedSegments: XArticleOrderedSegment[],
    options: BilingualAlignmentOptions = {}
): XArticleBilingualGroup[] {
    const groups: XArticleBilingualGroup[] = [];
    let index = 0;

    while (index < orderedSegments.length) {
        const current = orderedSegments[index];
        const next = orderedSegments[index + 1];

        if (current.kind === 'original' && next?.kind === 'translation') {
            groups.push(...buildXArticleBilingualGroups(current.segments, next.segments, options));
            index += 2;
            continue;
        }

        current.segments.forEach((segment) => {
            groups.push({
                id: generateId(),
                ...(current.kind === 'original'
                    ? { original: { html: segment.html, text: segment.text } }
                    : { translation: { html: segment.html, text: segment.text } }),
            });
        });
        index += 1;
    }

    return groups;
}

function buildStructuredTweetSegmentsFromBilingualGroups(
    groups: XArticleBilingualGroup[]
): TweetTextSegment[] | null {
    const result: TweetTextSegment[] = [];
    let bilingualPairCount = 0;

    groups.forEach((group, index) => {
        const currentSegments: TweetTextSegment[] = [];
        const originalLanguage = group.original ? detectTwitterSegmentLanguage(group.original.text) : 'other';
        const translationLanguage = group.translation ? detectTwitterSegmentLanguage(group.translation.text) : 'other';
        const isReliableBilingualPair = Boolean(
            group.original &&
            group.translation &&
            originalLanguage !== 'other' &&
            translationLanguage !== 'other' &&
            originalLanguage !== translationLanguage
        );

        if (group.original) {
            currentSegments.push({
                html: group.original.html,
                text: group.original.text,
                role: isReliableBilingualPair ? 'original' : 'normal',
                groupId: group.id,
            });
        }

        if (group.translation) {
            currentSegments.push({
                html: group.translation.html,
                text: group.translation.text,
                role: isReliableBilingualPair ? 'translation' : 'normal',
                groupId: group.id,
            });
        }

        if (currentSegments.length === 0) {
            return;
        }

        if (isReliableBilingualPair) {
            bilingualPairCount += 1;
        }

        result.push(...currentSegments);

        if (index < groups.length - 1) {
            result.push(createTweetParagraphSpacerSegment(group.id));
        }
    });

    return bilingualPairCount > 0 ? result : null;
}

function extractStructuredInlineTranslationSegments(
    element: HTMLElement,
    options: BilingualAlignmentOptions = {}
): TweetTextSegment[] | null {
    const orderedSegments = buildXArticleOrderedSegments(element);
    if (orderedSegments.length === 0) {
        return null;
    }

    const hasOriginal = orderedSegments.some((segment) => segment.kind === 'original');
    const hasTranslation = orderedSegments.some((segment) => segment.kind === 'translation');
    if (!hasOriginal || !hasTranslation) {
        return null;
    }

    const groups = buildXArticleBilingualGroupsFromOrderedSegments(orderedSegments, options);
    const structuredSegments = buildStructuredTweetSegmentsFromBilingualGroups(groups);
    if (!structuredSegments || structuredSegments.length === 0) {
        return null;
    }

    console.log(
        `[twitterExtractor] 🌐 普通推文结构化双语提取成功: groups=${groups.length}, segments=${structuredSegments.length}`
    );

    return structuredSegments;
}

function getCombinedSegmentTextLength(
    segments: Array<{ text: string }>
): number {
    return segments.reduce((sum, segment) => {
        const normalized = trimExtractedSegmentText(segment.text).replace(/\s+/g, '');
        return sum + normalized.length;
    }, 0);
}

function shouldUseInlineTranslationPairing(
    originalSegments: Array<{ html: string; text: string }>,
    translationSegments: Array<{ html: string; text: string }>
): boolean {
    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return false;
    }

    const originalCount = originalSegments.length;
    const translationCount = translationSegments.length;
    if (originalCount !== translationCount) {
        console.log(
            `[twitterExtractor] ⚠️ 普通推文翻译段落数不一致，跳过逐段配对: original=${originalCount}, translation=${translationCount}`
        );
        return false;
    }

    const originalLanguage = getDominantTwitterLanguage(originalSegments);
    const translationLanguage = getDominantTwitterLanguage(translationSegments);
    if (
        originalLanguage === 'other' ||
        translationLanguage === 'other' ||
        originalLanguage === translationLanguage
    ) {
        console.log(
            `[twitterExtractor] ⚠️ 普通推文翻译语言判定不可靠，跳过逐段配对: original=${originalLanguage}, translation=${translationLanguage}`
        );
        return false;
    }

    const originalLength = getCombinedSegmentTextLength(originalSegments);
    const translationLength = getCombinedSegmentTextLength(translationSegments);
    if (originalLength === 0 || translationLength === 0) {
        return false;
    }

    const lengthRatio = Math.min(originalLength, translationLength) / Math.max(originalLength, translationLength);
    if (lengthRatio < 0.18) {
        console.log(
            `[twitterExtractor] ⚠️ 普通推文翻译覆盖率过低，跳过逐段配对: originalLen=${originalLength}, translationLen=${translationLength}, ratio=${lengthRatio.toFixed(2)}`
        );
        return false;
    }

    return true;
}

function extractTranslationPairSegments(element: HTMLElement): TranslationPairSegment | null {
    const originalSegments = buildOriginalParagraphSegments(element);
    const translationSegments = buildTranslationParagraphSegments(element, originalSegments);

    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return null;
    }

    if (!shouldUseInlineTranslationPairing(originalSegments, translationSegments)) {
        return null;
    }

    return {
        original: originalSegments.map((segment) => ({
            html: segment.html,
            text: segment.text,
            role: 'original',
        })),
        translation: translationSegments.map((segment) => ({
            html: segment.html,
            text: segment.text,
            role: 'translation',
        })),
    };
}

/**
 * X Article 专用翻译对提取函数
 *
 * 在原始 DOM（翻译元素未被 unwrap）上操作，精确分离原文和译文。
 * 原文保留 <a> 链接等 inline markup；译文输出为纯文本。
 * 返回按顺序对齐后的双语段组，由保存链路按“正文 -> 译文 -> 空行”落盘。
 *
 * 如果元素中不存在翻译插件注入的 DOM 节点，返回 null（走现有路径）。
 */
function extractXArticleTranslationPairSegments(
    element: HTMLElement,
    options: BilingualAlignmentOptions = {}
): XArticleBilingualGroup[] | null {
    const orderedSegments = buildXArticleOrderedSegments(element);
    if (orderedSegments.length === 0) {
        return null;
    }

    const hasOriginal = orderedSegments.some((segment) => segment.kind === 'original');
    const hasTranslation = orderedSegments.some((segment) => segment.kind === 'translation');
    if (!hasOriginal || !hasTranslation) {
        return null;
    }

    const originalTextLength = orderedSegments
        .filter((segment) => segment.kind === 'original')
        .flatMap((segment) => segment.segments)
        .reduce((sum, segment) => sum + segment.text.length, 0);
    const translationTextLength = orderedSegments
        .filter((segment) => segment.kind === 'translation')
        .flatMap((segment) => segment.segments)
        .reduce((sum, segment) => sum + segment.text.length, 0);
    console.log(
        `[twitterExtractor] 🌐 X Article 结构锚点配对成功: 原文 ${originalTextLength} 字, 译文 ${translationTextLength} 字, 单元 ${orderedSegments.length}`
    );

    return buildXArticleBilingualGroupsFromOrderedSegments(orderedSegments, options);
}


function getVisibleElementChildren(element: HTMLElement): HTMLElement[] {
    return Array.from(element.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .filter((child) => !!child.innerText?.trim());
}

function hasOnlyStructuralDivChildren(element: HTMLElement): boolean {
    const visibleChildren = getVisibleElementChildren(element);
    return visibleChildren.length > 1 && visibleChildren.every((child) => child.tagName === 'DIV');
}

function normalizeXArticleInlineHtml(
    element: HTMLElement,
    options: { insertBreakBeforeTranslation?: boolean } = {}
): string {
    const { insertBreakBeforeTranslation = true } = options;
    const clone = element.cloneNode(true) as HTMLElement;

    // 归一化翻译插件注入的 DOM 元素（确保翻译与原文之间有 <br> 分隔）
    normalizeTranslationPluginElements(clone, { insertBreakBeforeOuter: insertBreakBeforeTranslation });

    Array.from(clone.querySelectorAll('div')).reverse().forEach((div) => {
        const parent = div.parentNode;
        if (!parent) {
            return;
        }

        const fragment = document.createDocumentFragment();
        while (div.firstChild) {
            fragment.appendChild(div.firstChild);
        }

        const parentElement = parent instanceof HTMLElement ? parent : null;
        const shouldInsertLineBreak = parentElement ? hasOnlyStructuralDivChildren(parentElement) : false;
        if (shouldInsertLineBreak && div.nextElementSibling) {
            fragment.appendChild(document.createElement('br'));
        }

        parent.replaceChild(fragment, div);
    });

    preserveTextNodeLineBreaks(clone);

    clone.querySelectorAll('*').forEach((node) => {
        if (!(node instanceof HTMLElement)) {
            return;
        }

        Array.from(node.attributes).forEach((attribute) => {
            const keepStyle = attribute.name === 'style';
            const keepHref = node.tagName === 'A' && attribute.name === 'href';
            if (!keepStyle && !keepHref) {
                node.removeAttribute(attribute.name);
            }
        });
    });

    return clone.innerHTML;
}

/**
 * Quote Tweet（引用推文）数据结构
 */
interface QuoteTweet {
    /** 原推文链接 */
    url: string;
    /** 引用链接展示文案（优先使用标题） */
    linkLabel?: string;
    /** 引用内容的有序块（正文/图片按最终保存顺序） */
    blocks: ContentBlock[];
    /** 引用推文中的图片 */
    images: ImageCandidate[];
}

type TweetTextSegment = TwitterTextSegment;

function normalizeStructuredTweetSegments(segments: TwitterTextSegment[]): TwitterTextSegment[] {
    return normalizeStructuredSequence(segments, {
        clone: (segment, groupId) => ({ ...segment, ...(groupId ? { groupId } : {}) }),
        createSpacer: createTweetParagraphSpacerSegment,
        getGroupId: (segment) => segment.groupId,
        getRole: (segment) => segment.role,
        hasText: (segment) => Boolean(segment.text.trim()),
        isSpacer: (segment) => segment.role === 'spacer',
    });
}

function extractQuoteDraftArticleSegments(quoteContainer: HTMLElement): TweetTextSegment[] {
    const draftBlocks = Array.from(quoteContainer.querySelectorAll('.public-DraftStyleDefault-block'))
        .filter((block): block is HTMLElement => block instanceof HTMLElement)
        .filter((block) => !!block.innerText?.trim());

    if (draftBlocks.length === 0) {
        return [];
    }

    const quoteBlocks: ContentBlock[] = [];
    const quoteContentParts: string[] = [];

    draftBlocks.forEach((block, blockIndex) => {
        const translationPairGroups = extractXArticleTranslationPairSegments(block.cloneNode(true) as HTMLElement, {
            allowReferenceDrivenSplit: false,
        });

        if (translationPairGroups && translationPairGroups.length > 0) {
            translationPairGroups.forEach((group, groupIndex) => {
                if (group.original?.text) {
                    appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, group.original, {
                        groupId: group.id,
                        role: 'original',
                    });
                }

                if (group.translation?.text) {
                    appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, group.translation, {
                        groupId: group.id,
                        role: 'translation',
                    });
                }

                if (groupIndex < translationPairGroups.length - 1) {
                    appendXArticleSpacerBlock(quoteBlocks, quoteContentParts, group.id);
                }
            });
        } else {
            const paragraphSegments = extractXArticleParagraphSegments(block);
            paragraphSegments.forEach((segment, segmentIndex) => {
                const trimmedText = segment.text.trim();
                if (!trimmedText) {
                    return;
                }

                const groupId = generateId();
                appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, {
                    html: segment.html,
                    text: trimmedText,
                }, {
                    groupId,
                    role: 'normal',
                });

                if (segmentIndex < paragraphSegments.length - 1) {
                    appendXArticleSpacerBlock(quoteBlocks, quoteContentParts, groupId);
                }
            });
        }

        if (blockIndex < draftBlocks.length - 1) {
            appendXArticleSpacerBlock(quoteBlocks, quoteContentParts, generateId());
        }
    });

    const normalizedBlocks = normalizeStructuredTwitterBlocks(quoteBlocks);
    const segments: TweetTextSegment[] = normalizedBlocks.flatMap((block) => {
        if (isStructuredTwitterSpacerBlock(block)) {
            return [createTweetParagraphSpacerSegment(block.layout?.groupId)];
        }

        const trimmedText = block.text.trim();
        if (block.type !== 'paragraph' || !trimmedText) {
            return [];
        }

        const match = block.html.trim().match(/^<p\b[^>]*>([\s\S]*)<\/p>$/i);
        const inlineHtml = (match ? match[1] : block.html).trim();
        if (!inlineHtml) {
            return [];
        }

        return [{
            html: inlineHtml,
            text: trimmedText,
            role: block.layout?.role || 'normal',
            groupId: block.layout?.groupId,
        }];
    });

    return segments;
}

function extractQuoteDraftBlockSegments(block: HTMLElement): TweetTextSegment[] {
    const quoteBlocks: ContentBlock[] = [];
    const quoteContentParts: string[] = [];

    const translationPairGroups = extractXArticleTranslationPairSegments(block.cloneNode(true) as HTMLElement, {
        allowReferenceDrivenSplit: false,
    });

    if (translationPairGroups && translationPairGroups.length > 0) {
        translationPairGroups.forEach((group, groupIndex) => {
            if (group.original?.text) {
                appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, group.original, {
                    groupId: group.id,
                    role: 'original',
                });
            }

            if (group.translation?.text) {
                appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, group.translation, {
                    groupId: group.id,
                    role: 'translation',
                });
            }

            if (groupIndex < translationPairGroups.length - 1) {
                appendXArticleSpacerBlock(quoteBlocks, quoteContentParts, group.id);
            }
        });
    } else {
        const paragraphSegments = extractXArticleParagraphSegments(block);
        paragraphSegments.forEach((segment, segmentIndex) => {
            const trimmedText = segment.text.trim();
            if (!trimmedText) {
                return;
            }

            const groupId = generateId();
            appendXArticleParagraphBlock(quoteBlocks, quoteContentParts, {
                html: segment.html,
                text: trimmedText,
            }, {
                groupId,
                role: 'normal',
            });

            if (segmentIndex < paragraphSegments.length - 1) {
                appendXArticleSpacerBlock(quoteBlocks, quoteContentParts, groupId);
            }
        });
    }

    const normalizedBlocks = normalizeStructuredTwitterBlocks(quoteBlocks);
    return normalizedBlocks.flatMap((contentBlock) => {
        if (isStructuredTwitterSpacerBlock(contentBlock)) {
            return [createTweetParagraphSpacerSegment(contentBlock.layout?.groupId)];
        }

        const trimmedText = contentBlock.text.trim();
        if (contentBlock.type !== 'paragraph' || !trimmedText) {
            return [];
        }

        const match = contentBlock.html.trim().match(/^<p\b[^>]*>([\s\S]*)<\/p>$/i);
        const inlineHtml = (match ? match[1] : contentBlock.html).trim();
        if (!inlineHtml) {
            return [];
        }

        return [{
            html: inlineHtml,
            text: trimmedText,
            role: contentBlock.layout?.role || 'normal',
            groupId: contentBlock.layout?.groupId,
        }];
    });
}

function cloneContentBlock(block: ContentBlock): ContentBlock {
    return {
        ...block,
        id: generateId(),
        layout: block.layout ? { ...block.layout } : block.layout,
    };
}

function appendContentBlocks(
    blocks: ContentBlock[],
    contentParts: string[],
    textParts: string[],
    sourceBlocks: ContentBlock[]
): void {
    sourceBlocks.forEach((block) => {
        const clonedBlock = cloneContentBlock(block);
        blocks.push(clonedBlock);
        contentParts.push(clonedBlock.html);
        if (clonedBlock.text.trim()) {
            textParts.push(clonedBlock.text);
        }
    });
}

function hasTextualContentBlocks(blocks: ContentBlock[]): boolean {
    return blocks.some((block) =>
        block.type !== 'image' &&
        block.text.trim().length > 0
    );
}

function hasImageContentBlocks(blocks: ContentBlock[]): boolean {
    return blocks.some((block) => block.type === 'image');
}

function createImageContentBlock(image: ImageCandidate): ContentBlock {
    const rawAlt = (image.alt || '').trim();
    const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
        rawAlt === 'null' || rawAlt === 'undefined';
    const altText = (rawAlt && !isGeneric) ? rawAlt : '';

    return {
        id: generateId(),
        type: 'image',
        html: `<img src="${image.url}" alt="${altText}" data-mowen-id="${image.id}" />`,
        text: altText,
    };
}

function createQuoteContentBlock(text: string, html: string): ContentBlock | null {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return null;
    }

    const trimmedHtml = html.trim();
    return {
        id: generateId(),
        type: 'quote',
        html: `<blockquote>${trimmedHtml || `<p>${escapeHtml(trimmedText)}</p>`}</blockquote>`,
        text: trimmedText,
    };
}

function buildQuoteContentBlocksFromSegments(segments: TweetTextSegment[]): ContentBlock[] {
    if (segments.length === 0) {
        return [];
    }

    return buildQuoteBlocksFromSegments(segments.map((segment) => (
        segment.role ? segment : { ...segment, role: 'normal' }
    )));
}

function getContentBlocksText(blocks: ContentBlock[]): string {
    return blocks
        .filter((block) => block.type !== 'image')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n');
}

export function appendQuoteTweetContentBlocks(
    blocks: ContentBlock[],
    contentParts: string[],
    textParts: string[],
    quoteTweet: Pick<QuoteTweet, 'blocks'>
): void {
    if (quoteTweet.blocks.length === 0) {
        return;
    }

    appendContentBlocks(blocks, contentParts, textParts, quoteTweet.blocks);
}

function createQuoteReferenceLinkBlock(
    quoteTweet: Pick<QuoteTweet, 'url' | 'linkLabel'>
): ContentBlock {
    const linkLabel = escapeHtml(quoteTweet.linkLabel || quoteTweet.url);

    return {
        id: generateId(),
        type: 'paragraph',
        html: `<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="${quoteTweet.url}">${linkLabel}</a></p>`,
        text: `🔗 引用文章：${quoteTweet.linkLabel || quoteTweet.url}`,
        layout: {
            preserveInlineParagraphs: true,
        },
    };
}

function appendQuoteTweetBlocks(
    blocks: ContentBlock[],
    contentParts: string[],
    textParts: string[],
    quoteTweet: Pick<QuoteTweet, 'url' | 'linkLabel' | 'blocks' | 'images'>,
    options: {
        onImage?: (image: ImageCandidate) => void;
    } = {}
): void {
    const { onImage } = options;
    const linkBlock = createQuoteReferenceLinkBlock(quoteTweet);
    blocks.push(linkBlock);
    contentParts.push(linkBlock.html);
    textParts.push(linkBlock.text);

    appendQuoteTweetContentBlocks(blocks, contentParts, textParts, quoteTweet);

    const quoteBlocksIncludeImages = Boolean(quoteTweet.blocks?.some((block) => block.type === 'image'));
    if (!quoteBlocksIncludeImages) {
        quoteTweet.images.forEach((image) => {
            const imageBlock = createImageContentBlock(image);
            blocks.push(imageBlock);
            contentParts.push(imageBlock.html);
            onImage?.(image);
        });
        return;
    }

    quoteTweet.images.forEach((image) => {
        onImage?.(image);
    });
}

/**
 * 对已经明确分离出的“原文 / 译文”段落做逐段交替输出。
 *
 * 这里用于单个 tweet/quote 文本块内部的精确翻译对场景，必须保证：
 * - 原文段落紧跟对应译文
 * - 保留原始 HTML（链接、强调等）
 * - 仅在 pair 与 pair 之间插入空段，避免退化成“原文全集在上、译文全集在下”
 */
function buildInlineTranslationPairSegments(
    originalSegments: TweetTextSegment[],
    translationSegments: TweetTextSegment[]
): TweetTextSegment[] {
    const total = Math.max(originalSegments.length, translationSegments.length);
    const result: TweetTextSegment[] = [];

    for (let index = 0; index < total; index++) {
        const groupId = generateId();
        const original = originalSegments[index];
        const translation = translationSegments[index];

        if (!original && !translation) {
            continue;
        }

        if (original) {
            result.push({
                ...original,
                role: 'original',
                groupId,
            });
        }

        if (translation) {
            result.push({
                ...translation,
                role: 'translation',
                groupId,
            });
        }

        if (index < total - 1) {
            result.push(createTweetParagraphSpacerSegment(groupId));
        }
    }

    return result;
}

function appendTwitterParagraphSegments(
    blocks: ContentBlock[],
    contentParts: string[],
    segments: TweetTextSegment[],
    options: {
        insertSpacerBetweenParagraphs?: boolean;
    } = {}
): void {
    const { insertSpacerBetweenParagraphs = true } = options;

    segments.forEach((segment, segmentIndex) => {
        if (segment.role === 'spacer') {
            appendXArticleSpacerBlock(blocks, contentParts, segment.groupId);
            return;
        }

        const trimmedText = segment.text.trim();
        if (!trimmedText) {
            return;
        }

        const effectiveGroupId = segment.groupId || (
            !segment.role || segment.role === 'normal'
                ? generateId()
                : undefined
        );

        appendXArticleParagraphBlock(blocks, contentParts, {
            html: segment.html,
            text: trimmedText,
        }, {
            groupId: effectiveGroupId,
            role: segment.role === 'original' || segment.role === 'translation' ? segment.role : 'normal',
        });

        const nextSegment = segments[segmentIndex + 1];
        const shouldInsertSpacer =
            insertSpacerBetweenParagraphs &&
            nextSegment &&
            nextSegment.role !== 'spacer' &&
            segment.role !== 'original' &&
            nextSegment.role !== 'translation';

        if (shouldInsertSpacer) {
            appendXArticleSpacerBlock(blocks, contentParts, effectiveGroupId);
        }
    });
}

function buildTwitterSegmentsFromXArticleTranslationGroups(
    groups: XArticleBilingualGroup[]
): TweetTextSegment[] {
    const segments: TweetTextSegment[] = [];

    groups.forEach((group, groupIndex) => {
        if (group.original) {
            segments.push({
                html: group.original.html,
                text: group.original.text,
                role: 'original',
                groupId: group.id,
            });
        }

        if (group.translation) {
            segments.push({
                html: group.translation.html,
                text: group.translation.text,
                role: 'translation',
                groupId: group.id,
            });
        }

        if (groupIndex < groups.length - 1) {
            segments.push(createTweetParagraphSpacerSegment(group.id));
        }
    });

    return segments;
}

/**
 * X Article 文字段落需要在 block-based 保存链路中保留原始段落结构，
 * 因此显式记录布局信息，避免后续被 mixed-language 与分片逻辑二次改写。
 */
function appendXArticleParagraphBlock(
    blocks: ContentBlock[],
    contentParts: string[],
    segment: { html: string; text: string },
    options: {
        groupId?: string;
        role?: 'original' | 'translation' | 'normal';
    } = {}
): void {
    const trimmedText = segment.text.trim();
    if (!trimmedText) {
        return;
    }

    const normalizedHtml = normalizePreservedInlineSegmentHtml(segment.html);
    if (!normalizedHtml) {
        return;
    }

    const block = createXArticleParagraphContentBlock(
        { html: `<p data-mowen-preserve-inline-paragraph="1">${normalizedHtml}</p>`, text: trimmedText },
        options
    );
    contentParts.push(block.html);
    blocks.push(block);
}

function appendXArticleSpacerBlock(
    blocks: ContentBlock[],
    contentParts: string[],
    groupId?: string
): void {
    const block = createStructuredTwitterSpacerBlock(groupId);
    contentParts.push(block.html);
    blocks.push(block);
}

function createXArticleParagraphContentBlock(
    segment: { html: string; text: string },
    options: {
        groupId?: string;
        role?: 'original' | 'translation' | 'normal';
    } = {}
): ContentBlock {
    return {
        id: generateId(),
        type: 'paragraph',
        html: segment.html,
        text: segment.text,
        layout: {
            preserveInlineParagraphs: true,
            ...(options.groupId ? { groupId: options.groupId } : {}),
            role: options.role || 'normal',
        },
    };
}

function normalizePreservedInlineSegmentHtml(html: string): string {
    const container = document.createElement('div');
    container.innerHTML = html;
    trimBoundaryBreakNodes(container);
    return container.innerHTML.trim();
}

function isBlankTwitterParagraphBlock(block: ContentBlock): boolean {
    return block.type === 'paragraph' && !block.text.trim();
}

function compactTwitterParagraphSpacing(blocks: ContentBlock[]): ContentBlock[] {
    const normalized: ContentBlock[] = [];
    let pendingSpacer: ContentBlock | null = null;

    for (const block of blocks) {
        if (isBlankTwitterParagraphBlock(block)) {
            if (normalized.length === 0) {
                continue;
            }

            pendingSpacer = pendingSpacer || block;
            continue;
        }

        if (pendingSpacer) {
            normalized.push(pendingSpacer);
            pendingSpacer = null;
        }

        normalized.push(block);
    }

    return normalized;
}

function finalizeTwitterContentBlocks(blocks: ContentBlock[]): {
    blocks: ContentBlock[];
    contentHtml: string;
    textContent: string;
} {
    const normalizedBlocks = compactTwitterParagraphSpacing(normalizeStructuredTwitterBlocks(blocks));

    return {
        blocks: normalizedBlocks,
        contentHtml: normalizedBlocks.map((block) => block.html).join(''),
        textContent: normalizedBlocks
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join('\n'),
    };
}

function debugLogXArticleBlockSequence(stage: string, blocks: ContentBlock[]): void {
    const textBlocks = blocks.filter((block) => block.type === 'paragraph');
    const preview = textBlocks
        .slice(0, 40)
        .map((block, index) => {
            const role = block.layout?.role || 'normal';
            const language = detectTwitterSegmentLanguage(block.text);
            const groupId = block.layout?.groupId ? block.layout.groupId.slice(0, 8) : '-';
            const snippet = block.text.trim().replace(/\s+/g, ' ').slice(0, 48);
            return `${index + 1}. ${role}/${language}/g=${groupId} ${snippet || '[empty]'}`;
        })
        .join('\n');

    console.log(
        `[twitterExtractor] 🧭 X Article ${stage} 文本块序列: total=${textBlocks.length}\n${preview}`
    );
}

/**
 * 检测是否为 Twitter/X 页面
 */
export function isTwitterPage(url: string): boolean {
    return url.includes('twitter.com') || url.includes('x.com');
}

// 标记脚本是否已注入
let pageContextHelperInjected = false;

// Quote URL 缓存：避免在多次稳定性检测提取中重复调用 pageContextHelper
// Key: 容器元素的某个稳定标识（如 innerText hash 或 DOM 路径）
// Value: 提取到的 URL
const quoteUrlCache = new Map<string, string>();

/**
 * 生成容器的缓存 key（基于内容 hash）
 */
function getContainerCacheKey(container: HTMLElement): string {
    // 使用容器的文本内容前 100 字符作为 key
    const textContent = (container.innerText || '').trim().substring(0, 100);
    // 简单 hash
    let hash = 0;
    for (let i = 0; i < textContent.length; i++) {
        hash = ((hash << 5) - hash) + textContent.charCodeAt(i);
        hash = hash & hash;
    }
    return `quote_${hash}`;
}

/**
 * 清理 Quote URL 缓存
 * 应在 SPA 路由变化（URL 变化）时调用
 */
export function clearQuoteUrlCache(): void {
    if (quoteUrlCache.size > 0) {
        console.log(`[twitterExtractor] 🗑️ 清理 Quote URL 缓存 (${quoteUrlCache.size} 条)`);
        quoteUrlCache.clear();
    }
}

/**
 * 注入 pageContextHelper.js 到页面主世界
 * 这个脚本可以访问 React Fiber，并通过 CustomEvent 与 Content Script 通信
 */
function injectPageContextHelper(): void {
    if (pageContextHelperInjected) return;
    if (typeof chrome === 'undefined' || !chrome.runtime) return;

    try {
        const scriptUrl = chrome.runtime.getURL('public/pageContextHelper.js');
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.onload = () => {
            console.log('[twitterExtractor] ✅ pageContextHelper.js 注入成功');
            script.remove();
        };
        script.onerror = (e) => {
            console.log('[twitterExtractor] ⚠️ pageContextHelper.js 注入失败:', e);
        };
        (document.head || document.documentElement).appendChild(script);
        pageContextHelperInjected = true;
    } catch (e) {
        console.log('[twitterExtractor] ⚠️ 注入脚本出错:', e);
    }
}

/**
 * 通过页面上下文提取 React Fiber 中的 URL
 * 使用 CustomEvent 与 pageContextHelper.js 通信
 * 
 * 注意：此函数是异步的，因为需要等待 pageContextHelper.js 返回结果
 */
async function extractUrlViaPageContext(element: HTMLElement): Promise<string | null> {
    const tempId = `mowen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    element.setAttribute('data-mowen-temp-id', tempId);

    return new Promise((resolve) => {
        let resolved = false;

        // 设置结果监听器
        const resultHandler = (event: CustomEvent) => {
            const detail = event.detail || {};
            if (detail.tempId === tempId && !resolved) {
                resolved = true;
                const result = detail.result;
                // 清理
                document.removeEventListener('mowen-extract-url-result', resultHandler as EventListener);
                element.removeAttribute('data-mowen-temp-id');

                if (result && result.startsWith('http')) {
                    resolve(result);
                } else {
                    resolve(null);
                }
            }
        };

        document.addEventListener('mowen-extract-url-result', resultHandler as EventListener);

        // 触发提取事件
        document.dispatchEvent(new CustomEvent('mowen-extract-url', {
            detail: { tempId }
        }));

        // 设置超时（500ms 以确保即使在多次快速提取时也有足够时间）
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                document.removeEventListener('mowen-extract-url-result', resultHandler as EventListener);
                element.removeAttribute('data-mowen-temp-id');
                console.log('[twitterExtractor] ⚠️ extractUrlViaPageContext 超时');
                resolve(null);
            }
        }, 500);
    });
}

/**
 * 提取 Twitter/X 页面内容
 * 
 * 专注于提取推文正文，排除动态元素
 */
export async function extractTwitterContent(url: string, domain: string): Promise<ExtractResult> {
    console.log('[twitterExtractor] 🐦 开始提取 X/Twitter 内容');

    // 注入页面上下文辅助脚本（用于访问 React Fiber）
    injectPageContextHelper();

    // 尝试多个备选选择器获取主推文容器
    const containerSelectors = [
        TWITTER_SELECTORS.primaryColumn,           // [data-testid="primaryColumn"]
        '[data-testid="tweet"]',                   // 直接找推文
        'main[role="main"]',                       // 主内容区
        '[role="main"]',                           // 备选主内容区
        'article',                                 // 通用文章容器
    ];

    let container: HTMLElement | null = null;
    for (const selector of containerSelectors) {
        container = document.querySelector(selector) as HTMLElement;
        if (container && container.innerText.length > 50) {
            console.log(`[twitterExtractor] ✅ 找到容器: ${selector}`);
            break;
        }
    }

    if (!container) {
        console.log('[twitterExtractor] ⚠️ 未找到任何容器，返回空结果以触发回退');
        return createEmptyResult(url, domain);
    }

    const primaryTweetText = (container.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="tweetText"]')) as HTMLElement | null;
    const primaryTweetSegments = primaryTweetText ? splitTweetTextIntoSegments(primaryTweetText) : [];
    const classification = classifyTwitterContent({
        container,
        primaryTweetText,
        primarySegments: primaryTweetSegments,
    });
    const { isXArticle, kind: clipKind } = classification;

    // 2. 提取标题
    const { title, contentStart } = extractTitleWithMeta({
        container,
        clipKind,
        primaryTweetText,
        primaryTweetSegments,
    });

    let baseContentHtml: string;
    let baseBlocks: ContentBlock[];
    let textContent: string;
    let quoteTweets: QuoteTweet[];
    let quoteTweetContainers: Element[];
    let mainImages: ImageCandidate[];

    if (isXArticle) {
        console.log('[twitterExtractor] 📄 检测到 X Article（长文章），使用专用提取器');
        // 传入 contentStart 用于去重
        const articleResult = await extractXArticleContent(container, contentStart);
        baseContentHtml = articleResult.contentHtml;
        baseBlocks = articleResult.blocks;
        textContent = articleResult.textContent;
        mainImages = articleResult.images;
        quoteTweets = articleResult.quoteTweets;
        quoteTweetContainers = articleResult.quoteTweetContainers;
        // X Article 已按 DOM 顺序提取所有内容（文字、图片、Quote Tweet）
        // 无需额外的图片过滤和 Quote 拼装
    } else {
        // 普通推文提取
        // 传入 contentStart 用于去重
        const tweetResult = await extractTweetContent(container, contentStart);
        baseContentHtml = tweetResult.contentHtml;
        baseBlocks = tweetResult.blocks;
        textContent = tweetResult.textContent;
        quoteTweets = tweetResult.quoteTweets;
        quoteTweetContainers = tweetResult.quoteTweetContainers;
        mainImages = extractTweetImages(container, quoteTweetContainers as HTMLElement[]);
    }

    // 构建最终 images 数组
    let images: ImageCandidate[];
    if (isXArticle) {
        images = mainImages; // X Article 已包含所有图片
        console.log(`[twitterExtractor] 📷 X Article 图片总数: ${images.length} 张 (已含引用图片)`);
    } else {
        const quoteImages = quoteTweets.flatMap((qt) => qt.images);
        images = [...mainImages, ...quoteImages];
        console.log(`[twitterExtractor] 📷 普通推文图片: 主帖 ${mainImages.length} 张 + 引用 ${quoteImages.length} 张 = ${images.length} 张`);
    }

    // 对于 X Article，图片已在 extractXArticleContent 中按 DOM 顺序添加到 baseBlocks
    // 无需再生成和插入 mainImageBlocks，直接使用 baseBlocks
    let finalContentHtml = baseContentHtml;
    let finalBlocks = [...baseBlocks];

    // 只有普通推文需要额外处理主图片的插入
    if (!isXArticle && mainImages.length > 0) {
        // 将主推文图片添加到 contentHtml 和 blocks 中（在文本内容之后、引用帖内容之前）
        const mainImageHtmlParts: string[] = [];
        const mainImageBlocks: ContentBlock[] = [];

        mainImages.forEach((img) => {
            // Use real alt text if available and meaningful, otherwise empty string
            const rawAlt = (img.alt || '').trim();
            // Filter out generic placeholders
            const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                rawAlt === 'null' || rawAlt === 'undefined';
            const altText = (rawAlt && !isGeneric) ? rawAlt : '';

            const imgBlock: ContentBlock = {
                id: generateId(),
                type: 'image',
                html: `<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`,
                text: altText,
            };
            mainImageBlocks.push(imgBlock);
            mainImageHtmlParts.push(`<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`);
        });

        // 查找引用帖分隔符的位置（引用文章链接）
        const quoteStartIndex = baseContentHtml.indexOf('<p>🔗 引用文章：');

        if (quoteStartIndex > 0) {
            // 在引用帖之前插入主推文图片
            finalContentHtml = baseContentHtml.substring(0, quoteStartIndex) +
                mainImageHtmlParts.join('') +
                baseContentHtml.substring(quoteStartIndex);
        } else {
            // 没有引用帖，直接追加到末尾
            finalContentHtml = baseContentHtml + mainImageHtmlParts.join('');
        }

        // 在 blocks 中也需要类似的插入逻辑
        const quoteBlockIndex = baseBlocks.findIndex((b) =>
            b.type === 'paragraph' &&
            b.text?.includes('🔗 引用文章：')
        );

        if (quoteBlockIndex > 0) {
            // 在引用帖之前插入主推文图片
            finalBlocks = [
                ...baseBlocks.slice(0, quoteBlockIndex),
                ...mainImageBlocks,
                ...baseBlocks.slice(quoteBlockIndex)
            ];
        } else {
            // 没有引用帖，直接追加到末尾
            finalBlocks = [...baseBlocks, ...mainImageBlocks];
        }
    }

    const wordCount = textContent.length;

    // 如果标题使用了正文前30字，从正文中去除这部分避免重复
    if (!isXArticle && contentStart && finalBlocks.length > 0) {
        const firstBlock = finalBlocks[0];
        const firstLine = getFirstNonEmptyLine(firstBlock.text);

        if (firstLine.startsWith(contentStart) && firstBlock.text.includes('\n')) {
            finalBlocks.shift();
            if (finalBlocks[0]?.text === '') {
                finalBlocks.shift();
            }
            console.log(`[twitterExtractor] ✂️ 从正文中移除与标题重复的首个双语段: "${contentStart}"`);
        } else if (firstBlock.text.startsWith(contentStart)) {
            // 从第一个块中移除标题文本
            const newText = firstBlock.text.substring(contentStart.length).trim();
            if (newText) {
                const preservedInlineHtml = firstBlock.layout?.preserveInlineParagraphs === true
                    ? `<p data-mowen-preserve-inline-paragraph="1">${escapeHtml(newText)}</p>`
                    : `<p>${escapeHtml(newText)}</p>`;
                finalBlocks[0] = {
                    ...firstBlock,
                    text: newText,
                    html: preservedInlineHtml,
                };
            } else {
                // 如果移除后为空，删除这个块
                finalBlocks.shift();
            }
            console.log(`[twitterExtractor] ✂️ 从正文中去除标题文本: "${contentStart}"`);
        }
    }

    console.log(`[twitterExtractor] ✅ 提取完成: ${wordCount} 字, ${images.length} 张图片`);

    return {
        title: title,
        sourceUrl: url,
        domain,
        author: extractAuthor(),
        publishTime: extractPublishTime(),
        clipKind: toExtractClipKind(clipKind),
        contentHtml: finalContentHtml,
        blocks: finalBlocks,
        images,
        wordCount,
    };
}

function extractTitleWithMeta(options: {
    container: HTMLElement;
    clipKind: TwitterClipKind;
    primaryTweetText: HTMLElement | null;
    primaryTweetSegments: TwitterTextSegment[];
}): { title: string; contentStart?: string } {
    const { container, clipKind, primaryTweetText, primaryTweetSegments } = options;
    const authorElement = container.querySelector('[data-testid="User-Name"]') ||
        document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="User-Name"]');
    const authorName = authorElement?.querySelector('span')?.textContent?.trim() || '';
    const headingText = container.querySelector('h1, [role="heading"]')?.textContent || '';
    const draftBlockTexts = Array.from(document.querySelectorAll('.public-DraftStyleDefault-block'))
        .filter((block): block is HTMLElement => block instanceof HTMLElement)
        .slice(0, 3)
        .map((block) => block.innerText || block.textContent || '');
    const orderedOriginalText = primaryTweetText
        ? buildXArticleOrderedSegments(primaryTweetText)
            .filter((segment) => segment.kind === 'original')
            .flatMap((segment) => segment.segments)
            .find((segment) => segment.text.trim())
            ?.text
        : '';
    const result = deriveTwitterTitle({
        authorName,
        clipKind,
        documentTitle: document.title,
        draftBlockTexts,
        firstXArticleSegmentText: clipKind === 'x-article' ? getFirstXArticleSegmentText() : '',
        headingText,
        orderedOriginalText,
        primarySegments: primaryTweetSegments,
        primaryTweetText: primaryTweetText?.textContent?.trim() || '',
    });

    console.log(`[twitterExtractor] 📄 标题解析: kind=${clipKind}, title="${result.title}"${result.contentStart ? ', with contentStart' : ''}`);
    return result;
}

/**
 * 查找容器内所有 Quote Tweet 容器
 * 
 * 支持多种形式：
 * 1. [data-testid="quoteTweet"] - 标准 Quote Tweet
 * 2. 嵌套的 article[data-testid="tweet"] - 长文章中的嵌入推文
 * 3. div[role="link"] 且内部包含 tweetText - 某些标准推文页面的引用
 * 4. 通过边框样式识别的引用容器
 */
function findQuoteTweetContainers(container: HTMLElement): HTMLElement[] {
    const containers: HTMLElement[] = [];
    console.log(`[twitterExtractor] 🔍 开始查找 Quote Tweet 容器...`);

    const mainTweet = container.querySelector('[data-testid="tweet"]');
    if (!mainTweet) {
        console.log(`[twitterExtractor] ⚠️ 未找到 mainTweet，无法进行基于主推文的排除`);
    }

    // 辅助：主推文的文本节点，用于防误判
    const mainTweetFirstText = mainTweet ? mainTweet.querySelector('[data-testid="tweetText"]') : null;

    // --- 方式 1：标准 Quote Tweet ---
    const quoteTweets = container.querySelectorAll('[data-testid="quoteTweet"]');
    console.log(`[twitterExtractor] 方式1 [data-testid="quoteTweet"]: 找到 ${quoteTweets.length} 个`);
    quoteTweets.forEach((el) => containers.push(el as HTMLElement));

    if (mainTweet) {
        // --- 方式 2：嵌套的 article ---
        const nestedTweets = mainTweet.querySelectorAll('article[data-testid="tweet"]');
        console.log(`[twitterExtractor] 方式2 嵌套 article: 找到 ${nestedTweets.length} 个`);
        nestedTweets.forEach((el) => {
            if (!containers.includes(el as HTMLElement)) containers.push(el as HTMLElement);
        });

        // --- 方式 3 & 4：div[role="link"] & Card Wrapper ---
        const candidates = Array.from(mainTweet.querySelectorAll('div[role="link"], [data-testid="card.wrapper"]'));
        console.log(`[twitterExtractor] 方式3/4/5 候选容器: ${candidates.length} 个`);

        let matchCount = 0;
        candidates.forEach((el, idx) => {
            if (containers.includes(el as HTMLElement)) return;

            // 排除包含主推文文本的容器
            if (mainTweetFirstText && el.contains(mainTweetFirstText)) {
                // console.log(`[twitterExtractor] 候选 #${idx} 跳过: 包含主推文文本`);
                return;
            }

            // 排除过于简单的按钮链接
            if (el.tagName === 'DIV' && el.getAttribute('role') === 'link' && el.innerHTML.length < 50) {
                // console.log(`[twitterExtractor] 候选 #${idx} 跳过: 内容过短`);
                return;
            }

            const hasQuoteText = el.querySelector('[data-testid="tweetText"]');
            const hasTime = el.querySelector('time');
            const hasUserName = el.querySelector('[data-testid="User-Name"]');
            const hasImage = el.querySelector('img');
            const hasCardWrapper = el.getAttribute('data-testid') === 'card.wrapper' || el.querySelector('[data-testid="card.wrapper"]');

            // 链接检查：支持 status, article, events 等
            const hasLink = el.querySelector('a[href*="/status/"]') ||
                el.querySelector('a[href*="/article/"]') ||
                el.querySelector('a[href*="/events/"]') ||
                el.querySelector('a[href*="/i/"]'); // 很多内部链接是 /i/ 开头

            // 综合判断逻辑
            let isMatch = false;
            let matchType = '';

            if (hasQuoteText && (hasTime || hasUserName)) {
                isMatch = true;
                matchType = '标准引用';
            } else if (hasCardWrapper) {
                isMatch = true;
                matchType = '卡片Wrapper';
            } else if (hasImage && hasLink) {
                isMatch = true;
                matchType = '图片+链接卡片';
            } else if (hasImage && (el as HTMLElement).innerText.length > 5 && (el.getAttribute('role') === 'link' || el.closest('[data-testid="card.wrapper"]'))) {
                // 只有图片和文字，且本身是链接
                isMatch = true;
                matchType = '图片+文字链接';
            } else if (el.getAttribute('role') === 'link' && hasImage && (el as HTMLElement).innerText.length > 20) {
                // 方式6：文章封面卡片 - role="link" 但无 data-testid，有图片和较长文本
                // 特征：包含 article-cover-image 或带有摘要文字的卡片
                const hasArticleCover = el.querySelector('[data-testid*="cover"], [class*="cover"], img[alt*="Cover"]') ||
                    (el.querySelector('img') && (el as HTMLElement).innerText.includes('文章'));
                if (hasArticleCover || (el as HTMLElement).innerText.length > 50) {
                    isMatch = true;
                    matchType = '文章封面卡片';
                }
            }

            if (isMatch) {
                containers.push(el as HTMLElement);
                matchCount++;
                console.log(`[twitterExtractor] ✅ 候选 #${idx} 匹配成功 (${matchType}): ${el.tagName}.${el.className.substring(0, 20)}...`);
            } else {
                console.log(`[twitterExtractor] ❌ 候选 #${idx} 不匹配: hasQuoteText=${!!hasQuoteText}, hasCard=${!!hasCardWrapper}, hasImg=${!!hasImage}, hasLink=${!!hasLink}`);
            }
        });
        console.log(`[twitterExtractor] 方式3/4/5 最终匹配: ${matchCount} 个`);
    }

    console.log(`[twitterExtractor] 🔍 总共找到 ${containers.length} 个 Quote Tweet 容器`);
    return containers;
}

interface QuoteContentCandidate {
    source: 'ordered' | 'draft' | 'tweetText' | 'generic' | 'placeholder';
    blocks: ContentBlock[];
    text: string;
    priority: number;
}

function createQuoteContentCandidate(
    source: QuoteContentCandidate['source'],
    priority: number,
    blocks: ContentBlock[]
): QuoteContentCandidate | null {
    if (blocks.length === 0) {
        return null;
    }

    return {
        source,
        blocks,
        text: getContentBlocksText(blocks),
        priority,
    };
}

function getQuoteContentCandidateScore(candidate: QuoteContentCandidate): number {
    const textLength = candidate.text.replace(/\s+/g, '').length;
    const textBonus = hasTextualContentBlocks(candidate.blocks) ? 10_000 : 0;
    const textualBlockCount = candidate.blocks.filter((block) =>
        block.type !== 'image' && block.text.trim().length > 0
    ).length;
    const structureBonus = textualBlockCount > 1 ? 5_000 : 0;
    const bilingualBonus = candidate.blocks.some((block) =>
        block.layout?.role === 'original' || block.layout?.role === 'translation'
    ) ? 2_000 : 0;
    const spacerBonus = candidate.blocks.some((block) => block.layout?.role === 'spacer') ? 1_000 : 0;
    return textBonus + structureBonus + bilingualBonus + spacerBonus + textualBlockCount * 50 + textLength * 10 + candidate.priority;
}

function selectBestQuoteContentCandidate(candidates: QuoteContentCandidate[]): QuoteContentCandidate | null {
    if (candidates.length === 0) {
        return null;
    }

    return [...candidates]
        .sort((left, right) => getQuoteContentCandidateScore(right) - getQuoteContentCandidateScore(left))[0] || null;
}

export function shouldAppendGenericQuoteFallback(
    candidates: Array<Pick<QuoteContentCandidate, 'source' | 'blocks'>>
): boolean {
    return !candidates.some((candidate) =>
        candidate.source !== 'generic' &&
        candidate.source !== 'placeholder' &&
        hasTextualContentBlocks(candidate.blocks)
    );
}

/**
 * 提取单个 Quote Tweet 的内容
 * (重命名为 extractQuotedTweet 以符合新规范)
 */
async function extractQuotedTweet(quoteContainer: HTMLElement): Promise<QuoteTweet | null> {
    // 0. 优先检查 DOM 属性缓存（最稳定，不受 innerText 变化影响）
    const savedUrl = quoteContainer.getAttribute('data-mowen-saved-url');

    // 检查缓存：避免在多次稳定性检测提取中重复调用 pageContextHelper
    const cacheKey = getContainerCacheKey(quoteContainer);
    const cachedUrl = quoteUrlCache.get(cacheKey);

    // 提取原推文链接 (优先级: DOM属性 > 内存缓存 > 重新提取)
    let fullUrl = savedUrl || cachedUrl || '';

    if (!fullUrl) {
        fullUrl = extractExternalQuoteCardHref(quoteContainer);
    }

    // 1. 泛化链接查找：查找任何看起来像内容链接的 href
    const potentialLinks = quoteContainer.querySelectorAll('a[href]');
    for (const link of potentialLinks) {
        const href = link.getAttribute('href');
        if (href && isPrimaryQuoteContentHref(href)) {
            fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
            break;
        }
    }

    // 2. 尝试 container 自身的链接 (div[role="link"])
    if (!fullUrl) {
        const roleLink = quoteContainer.closest('div[role="link"]') ||
            quoteContainer.closest('a') ||
            quoteContainer.closest('[data-testid="card.wrapper"]');

        if (roleLink) {
            const containerHref = roleLink.getAttribute('href');
            if (containerHref && containerHref.length > 5) {
                const normalizedHref = normalizeQuoteTweetUrl(
                    containerHref.startsWith('http') ? containerHref : `https://x.com${containerHref}`
                );
                fullUrl = normalizedHref;
            } else if (!containerHref) {
                // 如果 wrapper 自身没 href，找它里面的第一个有效链接
                const innerLink = roleLink.querySelector('a[href*="/status/"], a[href*="/article/"]');
                if (innerLink) {
                    const href = innerLink.getAttribute('href');
                    if (href && isPrimaryQuoteContentHref(href)) {
                        fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
                    }
                }
            }
        }
    }

    // 3. 扫描容器内所有元素的属性
    if (!fullUrl) {
        const allElements = quoteContainer.querySelectorAll('*');
        for (const el of Array.from(allElements)) {
            const attrs = ['data-url', 'data-permalink-path', 'href'];
            for (const attr of attrs) {
                const val = el.getAttribute(attr);
                if (val && isPrimaryQuoteContentHref(val)) {
                    fullUrl = val.startsWith('http') ? val : `https://x.com${val}`;
                    break;
                }
            }
            if (fullUrl) break;
        }
    }

    // 4. 尝试从 React Fiber/Props 提取（注意：Content Script 可能无法访问）
    if (!fullUrl) {
        try {
            let targetEl: Element | null = quoteContainer;
            let depth = 0;
            while (targetEl && depth < 5) {
                const props = getReactProps(targetEl);
                if (props) {
                    const reactData = findTweetDataInProps(props);
                    if (reactData) {
                        if (reactData.canonical_url) {
                            fullUrl = reactData.canonical_url;
                        } else if (reactData.id) {
                            const isArticle = reactData.__typename === 'Article' ||
                                (quoteContainer.innerText || '').includes('Article');
                            fullUrl = isArticle
                                ? `https://x.com/i/article/${reactData.id}`
                                : `https://x.com/i/status/${reactData.id}`;
                        }
                        if (fullUrl) break;
                    }
                }
                targetEl = targetEl.parentElement;
                depth++;
            }
        } catch (e) {
            // React 提取失败，继续
            void e;
        }
    }

    // 5. 终极方案：通过注入的 pageContextHelper.js 在页面主世界提取
    if (!fullUrl) {
        try {
            const urlFromPageContext = await extractUrlViaPageContext(quoteContainer);
            if (urlFromPageContext) {
                fullUrl = urlFromPageContext;
                console.log('[twitterExtractor] 🎯 通过 pageContextHelper 成功提取 URL:', fullUrl);
            }
        } catch (e) {
            // pageContextHelper 提取失败，继续
            void e;
        }
    }

    // 如果以上方法都失败，标记为未知链接
    if (!fullUrl) {
        console.log('[twitterExtractor] ⚠️ 未找到引用推文原始链接');
        fullUrl = '(未知链接)';
    } else {
        fullUrl = normalizeQuoteTweetUrl(fullUrl);
        // 成功提取：保存到 DOM 属性和内存缓存
        if (!savedUrl) {
            quoteContainer.setAttribute('data-mowen-saved-url', fullUrl);
        }
        if (!cachedUrl) {
            quoteUrlCache.set(cacheKey, fullUrl);
            console.log(`[twitterExtractor] 📝 缓存 Quote URL: ${cacheKey} -> ${fullUrl}`);
        }
    }

    const textEl = quoteContainer.querySelector('[data-testid="tweetText"]');
    const orderedQuoteContent = extractQuoteOrderedBlocks(quoteContainer);
    const referenceImages = orderedQuoteContent?.images || extractQuoteTweetImages(quoteContainer);
    const candidates: QuoteContentCandidate[] = [];

    const orderedCandidate = orderedQuoteContent
        ? createQuoteContentCandidate('ordered', 4, orderedQuoteContent.blocks)
        : null;
    if (orderedCandidate) {
        candidates.push(orderedCandidate);
    }

    const draftArticleSegments = extractQuoteDraftArticleSegments(quoteContainer);
    if (draftArticleSegments.length > 0) {
        const draftCandidate = createQuoteContentCandidate(
            'draft',
            3,
            buildQuoteContentBlocksFromSegments(draftArticleSegments)
        );
        if (draftCandidate) {
            candidates.push(draftCandidate);
        }
    }

    if (textEl) {
        const tweetTextSegments = splitTweetTextIntoSegments(textEl as HTMLElement, {
            allowReferenceDrivenSplit: false,
        });
        const tweetTextBlocks = tweetTextSegments.length > 0
            ? buildQuoteContentBlocksFromSegments(tweetTextSegments)
            : (() => {
                const fallbackText = (textEl as HTMLElement).innerText || textEl.textContent || '';
                const fallbackHtml = cleanTwitterHtml((textEl as HTMLElement).innerHTML);
                const fallbackBlock = createQuoteContentBlock(fallbackText, fallbackHtml);
                return fallbackBlock ? [fallbackBlock] : [];
            })();
        const tweetTextCandidate = createQuoteContentCandidate('tweetText', 2, tweetTextBlocks);
        if (tweetTextCandidate) {
            candidates.push(tweetTextCandidate);
        }
    }

    if (shouldAppendGenericQuoteFallback(candidates)) {
        const clonedContainer = quoteContainer.cloneNode(true) as HTMLElement;
        const toRemove = clonedContainer.querySelectorAll(
            '[data-testid="User-Name"], time, [role="button"], svg, ' +
            '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"]' // 排除操作按钮
        );
        toRemove.forEach(el => el.remove());

        const genericText = (clonedContainer.innerText?.trim() || '')
            .replace(/^文章\n?/gm, '')
            .replace(/^Article\n?/gm, '')
            .trim();
        const genericBlock = createQuoteContentBlock(
            genericText,
            genericText ? `<p>${genericText.split('\n').join('</p><p>')}</p>` : ''
        );
        const genericCandidate = genericBlock
            ? createQuoteContentCandidate('generic', 1, [genericBlock])
            : null;
        if (genericCandidate) {
            candidates.push(genericCandidate);
        }
    }

    if (candidates.length === 0) {
        let placeholderText = '';
        if (fullUrl) {
            placeholderText = '（引用推文内容请查看原文）';
        } else if (referenceImages.length > 0 || quoteContainer.querySelector('img')) {
            placeholderText = '（引用内容为图片）';
        } else {
            return null;
        }

        const placeholderBlock = createQuoteContentBlock(placeholderText, escapeHtml(placeholderText));
        const placeholderCandidate = placeholderBlock
            ? createQuoteContentCandidate('placeholder', 0, [placeholderBlock])
            : null;
        if (placeholderCandidate) {
            candidates.push(placeholderCandidate);
        }
    }

    const selectedCandidate = selectBestQuoteContentCandidate(candidates);
    if (!selectedCandidate) {
        return null;
    }

    const blocks = selectedCandidate.blocks.map((block) => cloneContentBlock(block));
    if (referenceImages.length > 0 && !hasImageContentBlocks(blocks)) {
        blocks.push(...referenceImages.map((image) => createImageContentBlock(image)));
    }

    const quoteText = selectedCandidate.text.trim();

    console.log(
        `[twitterExtractor] 🔍 Quote Tweet 提取结果: url=${fullUrl}, source=${selectedCandidate.source}, textLen=${quoteText.length}, images=${referenceImages.length}`
    );

    return {
        url: fullUrl || '(未知链接)',
        linkLabel: getQuoteLinkLabelFromBlocks(fullUrl || '(未知链接)', blocks),
        blocks,
        images: referenceImages,
    };
}

/**
 * 清理 Twitter HTML，移除复杂样式只保留纯文本结构
 */
function cleanTwitterHtml(html: string): string {
    // 移除所有 class 属性（Twitter 的样式类非常复杂）
    let cleaned = html.replace(/\s*class="[^"]*"/gi, '');

    // 移除所有 style 属性
    cleaned = cleaned.replace(/\s*style="[^"]*"/gi, '');

    // 移除 data-* 属性
    cleaned = cleaned.replace(/\s*data-[a-z-]+="[^"]*"/gi, '');

    // 移除 dir 属性
    cleaned = cleaned.replace(/\s*dir="[^"]*"/gi, '');

    // 移除 lang 属性
    cleaned = cleaned.replace(/\s*lang="[^"]*"/gi, '');

    // 将多余的 span 标签简化（保留文本内容）
    // <span>text</span> -> text（如果 span 没有其他作用）
    cleaned = cleaned.replace(/<span>([^<]*)<\/span>/gi, '$1');

    // 去掉 HTML 源码中的无意义换行（真正的换行已通过 <br> DOM 元素表示）
    cleaned = cleaned.replace(/\n+/g, '');

    return cleaned.trim();
}

/**
 * 将普通推文 tweetText 元素按换行拆分为多个独立段落
 *
 * Twitter 的 tweetText 中，作者的换行通过 DOM 中的 <br> 元素表示。
 * 此函数将内容按 <br> 拆分为独立行，并对纯文本段落做中英文混合二次拆分。
 */
function splitTweetTextIntoSegments(
    element: HTMLElement,
    options: BilingualAlignmentOptions = {}
): TweetTextSegment[] {
    const structuredTranslationSegments = extractStructuredInlineTranslationSegments(element, options);
    if (structuredTranslationSegments) {
        return normalizeStructuredTweetSegments(structuredTranslationSegments);
    }

    const translationPair = extractTranslationPairSegments(element);
    if (translationPair) {
        return normalizeStructuredTweetSegments(
            buildInlineTranslationPairSegments(
                translationPair.original,
                translationPair.translation
            )
        );
    }

    // 克隆后归一化翻译插件注入的元素（保留翻译内容，确保与原文正确分行）
    const cleanedElement = element.cloneNode(true) as HTMLElement;
    normalizeTranslationPluginElements(cleanedElement);
    const fullText = (cleanedElement.innerText || cleanedElement.textContent || '').trim();

    if (!fullText) return [];

    const rawHtml = cleanedElement.innerHTML;
    // 清理 HTML（保留链接等语义标签和 <br>，移除样式类）
    const cleanedHtml = cleanTwitterHtml(rawHtml);

    // 复用已有的按 <br> 拆分逻辑
    const htmlSegments = splitXArticleInlineSegments(cleanedHtml);

    if (htmlSegments.length <= 1) {
        // 单段：检查是否包含中英文混合需要拆分
        const hasInlineMarkup = /<(a|strong|em|code)\b/i.test(cleanedHtml);
        if (!hasInlineMarkup) {
            const mixedParts = splitMixedLanguageText(fullText);
            if (mixedParts.length > 1) {
                return mixedParts.map(part => ({
                    html: escapeHtml(part),
                    text: part,
                    role: 'normal',
                }));
            }
        }
        return [{ html: cleanedHtml, text: fullText, role: 'normal' }];
    }

    const paragraphTexts = splitTweetTextParagraphs(fullText);
    if (paragraphTexts.length > 1) {
        return paragraphTexts.map((paragraphText) => ({
            html: escapeHtml(paragraphText),
            text: paragraphText,
            role: 'normal',
        }));
    }

    // 多段：对每段检查中英文混合（仅纯文本段落）
    const result: Array<{ html: string; text: string; role?: 'normal' }> = [];
    for (const seg of htmlSegments) {
        const segText = seg.text.trim();
        if (!segText) continue;

        // 含内联标签的段落不做中英文拆分（避免破坏链接结构）
        const hasInlineMarkup = /<(a|strong|em|code)\b/i.test(seg.html);
        if (!hasInlineMarkup) {
            const mixedParts = splitMixedLanguageText(segText);
            if (mixedParts.length > 1) {
                mixedParts.forEach(part => {
                    result.push({ html: escapeHtml(part), text: part, role: 'normal' });
                });
                continue;
            }
        }
        result.push({ ...seg, role: 'normal' });
    }

    return result;
}

function splitTweetTextParagraphs(text: string): string[] {
    return text
        .split(/\n\s*\n+/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
}

export function normalizeQuoteTweetUrl(url: string): string {
    return url
        .replace(/\/(?:photo|video)\/\d+(?:\?.*)?$/i, '')
        .replace(/[?#]$/, '');
}

function isPrimaryQuoteContentHref(href: string): boolean {
    return Boolean(
        href &&
        (href.includes('/status/') || href.includes('/article/') || href.includes('/events/') || href.includes('/i/')) &&
        !href.includes('/photo/') &&
        !href.includes('/video/') &&
        !href.includes('/people/')
    );
}

export function buildQuoteBlocksFromSegments(segments: TweetTextSegment[]): ContentBlock[] {
    if (segments.length === 0) {
        return [];
    }

    const blocks: ContentBlock[] = [];

    segments.forEach((segment) => {
        if (segment.role === 'spacer') {
            blocks.push(createStructuredTwitterSpacerBlock(segment.groupId));
            return;
        }

        const trimmedText = segment.text.trim();
        const trimmedHtml = segment.html.trim();
        if (!trimmedText || !trimmedHtml) {
            return;
        }

        blocks.push({
            id: generateId(),
            type: 'quote',
            html: `<blockquote><p data-mowen-preserve-inline-paragraph="1">${trimmedHtml}</p></blockquote>`,
            text: trimmedText,
            layout: {
                preserveInlineParagraphs: true,
                ...(segment.groupId ? { groupId: segment.groupId } : {}),
                role: segment.role === 'original' || segment.role === 'translation'
                    ? segment.role
                    : 'normal',
            },
        });
    });

    return normalizeStructuredTwitterBlocks(blocks);
}

function extractQuoteImageCandidate(
    node: Element,
    seenUrls: Set<string>
): { image: ImageCandidate; block: ContentBlock } | null {
    const img = (node instanceof HTMLImageElement
        ? node
        : node.querySelector('img')) as HTMLImageElement | null;

    if (!img) {
        return null;
    }

    const src = img.src || img.getAttribute('data-src') || '';
    if (!src || src.startsWith('data:')) {
        return null;
    }

    if (
        src.includes('profile_images') ||
        src.includes('emoji') ||
        src.includes('twemoji') ||
        src.includes('hashflags') ||
        src.includes('abs.twimg.com')
    ) {
        return null;
    }

    const imgWidth = img.naturalWidth || img.width || 0;
    const imgHeight = img.naturalHeight || img.height || 0;
    const isTwimgMedia = src.includes('pbs.twimg.com/media/');
    const hasValidSize = imgWidth > 100 && imgHeight > 100;
    if (!hasValidSize && !isTwimgMedia) {
        return null;
    }

    const normalizedUrl = normalizeImageUrl(src);
    if (seenUrls.has(normalizedUrl)) {
        return null;
    }
    seenUrls.add(normalizedUrl);

    const image: ImageCandidate = {
        id: generateId(),
        url: src,
        normalizedUrl,
        kind: 'img',
        order: 0,
        inMainContent: true,
        width: imgWidth,
        height: imgHeight,
        alt: img.alt || '',
    };

    const rawAlt = (img.alt || '').trim();
    const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
        rawAlt === 'null' || rawAlt === 'undefined';
    const altText = (rawAlt && !isGeneric) ? rawAlt : '';

    return {
        image,
        block: {
            id: generateId(),
            type: 'image',
            html: `<img src="${src}" alt="${altText}" data-mowen-id="${image.id}" />`,
            text: altText,
        },
    };
}

function isExternalQuoteCardContainer(container: HTMLElement): boolean {
    return Boolean(container.querySelector(TWITTER_CARD_DETAIL_SELECTOR)) &&
        !container.querySelector('[data-testid="tweetText"], .public-DraftStyleDefault-block, article[data-testid="tweet"], [data-testid="quoteTweet"]');
}

function extractExternalQuoteCardHref(container: HTMLElement): string {
    if (!isExternalQuoteCardContainer(container)) {
        return '';
    }

    const anchors = Array.from(container.querySelectorAll('a[href]'))
        .filter((anchor): anchor is HTMLAnchorElement => anchor instanceof HTMLAnchorElement);
    const preferredAnchor = anchors.find((anchor) => {
        const href = anchor.href || anchor.getAttribute('href') || '';
        return /^https?:\/\//i.test(href) && !isPrimaryQuoteContentHref(href);
    });

    return preferredAnchor?.href || '';
}

function extractQuoteCardDetailSegments(detailNode: HTMLElement): TweetTextSegment[] {
    const detailRows = getVisibleElementChildren(detailNode);
    const rowElements = detailRows.length > 0 ? detailRows : [detailNode];
    const rowGroups: TweetTextSegment[][] = [];

    rowElements.forEach((rowElement) => {
        const rowText = trimExtractedSegmentText(rowElement.innerText || rowElement.textContent || '');
        if (!rowText || isTwitterCardMetadataText(rowText)) {
            return;
        }

        const rowSegments = splitTweetTextIntoSegments(rowElement, {
            allowReferenceDrivenSplit: false,
        }).filter((segment) => {
            if (segment.role === 'spacer') {
                return false;
            }

            return !isTwitterCardMetadataText(segment.text);
        });

        if (rowSegments.length > 0) {
            rowGroups.push(rowSegments);
            return;
        }

        rowGroups.push([{
            html: escapeHtml(rowText),
            text: rowText,
            role: 'normal',
        }]);
    });

    return buildTwitterCardSegments(rowGroups, generateId);
}

function extractQuoteArticleCoverSegments(quoteContainer: HTMLElement): TweetTextSegment[] {
    if (
        quoteContainer.querySelector('.public-DraftStyleDefault-block, [data-testid="tweetText"], [data-testid="quoteTweet"], article[data-testid="tweet"], ' + TWITTER_CARD_DETAIL_SELECTOR)
    ) {
        return [];
    }

    const articleCover = quoteContainer.querySelector('[data-testid="article-cover-image"]');
    if (!(articleCover instanceof HTMLElement)) {
        return [];
    }

    const cardRoot = articleCover.parentElement;
    if (!(cardRoot instanceof HTMLElement)) {
        return [];
    }

    const textSection = Array.from(cardRoot.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== articleCover)
        .find((child) => !!trimExtractedSegmentText(child.innerText || child.textContent || ''));
    if (!textSection) {
        return [];
    }

    const autoRows = Array.from(textSection.querySelectorAll('[dir="auto"]'))
        .filter((row): row is HTMLElement => row instanceof HTMLElement)
        .filter((row) => {
            const rowText = trimExtractedSegmentText(row.innerText || row.textContent || '');
            if (!rowText || isTwitterCardMetadataText(rowText)) {
                return false;
            }

            return !Array.from(textSection.querySelectorAll('[dir="auto"]'))
                .some((other) => other !== row && other.contains(row));
        });
    const rowElements = autoRows.length > 0
        ? autoRows
        : getVisibleElementChildren(textSection).filter((row) => {
            const rowText = trimExtractedSegmentText(row.innerText || row.textContent || '');
            return !!rowText && !isTwitterCardMetadataText(rowText);
        });

    const rowGroups: TweetTextSegment[][] = [];
    rowElements.forEach((rowElement) => {
        const rowText = trimExtractedSegmentText(rowElement.innerText || rowElement.textContent || '');
        if (!rowText) {
            return;
        }

        const rowSegments = splitTweetTextIntoSegments(rowElement, {
            allowReferenceDrivenSplit: false,
        }).filter((segment) => {
            if (segment.role === 'spacer') {
                return false;
            }

            return !isTwitterCardMetadataText(segment.text);
        });

        if (rowSegments.length > 0) {
            rowGroups.push(rowSegments);
            return;
        }

        rowGroups.push([{
            html: escapeHtml(rowText),
            text: rowText,
            role: 'normal',
        }]);
    });

    return buildTwitterCardSegments(rowGroups, generateId);
}

function hasQuoteHandledAncestor(node: Element, container: HTMLElement): boolean {
    let current = node.parentElement;

    while (current && current !== container) {
        if (
            current.classList.contains('public-DraftStyleDefault-block') ||
            current.getAttribute('data-testid') === 'tweetText' ||
            current.getAttribute('data-testid') === 'tweetPhoto'
        ) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
}

function extractQuoteOrderedBlocks(quoteContainer: HTMLElement): {
    blocks: ContentBlock[];
    images: ImageCandidate[];
    text: string;
    html: string;
    segments: TweetTextSegment[];
} | null {
    const blocks: ContentBlock[] = [];
    const images: ImageCandidate[] = [];
    const textParts: string[] = [];
    const htmlParts: string[] = [];
    const segments: TweetTextSegment[] = [];
    const seenImageUrls = new Set<string>();
    const processedTextNodes = new Set<HTMLElement>();

    const articleCoverSegments = extractQuoteArticleCoverSegments(quoteContainer);
    if (articleCoverSegments.length > 0) {
        segments.push(...articleCoverSegments);
        const quoteBlocks = buildQuoteBlocksFromSegments(articleCoverSegments);
        quoteBlocks.forEach((block) => {
            blocks.push(block);
            htmlParts.push(block.html);
            if (block.text.trim()) {
                textParts.push(block.text);
            }
        });
    }

    const contentNodes = Array.from(quoteContainer.querySelectorAll(
        `.public-DraftStyleDefault-block, [data-testid="tweetText"], ${TWITTER_CARD_DETAIL_SELECTOR}, [data-testid="tweetPhoto"], img`
    )).filter((node): node is HTMLElement => node instanceof HTMLElement);

    for (const node of contentNodes) {
        if (hasQuoteHandledAncestor(node, quoteContainer)) {
            continue;
        }

        if (node.classList.contains('public-DraftStyleDefault-block')) {
            const blockSegments = extractQuoteDraftBlockSegments(node);
            if (blockSegments.length === 0) {
                continue;
            }

            processedTextNodes.add(node);
            segments.push(...blockSegments);
            const quoteBlocks = buildQuoteBlocksFromSegments(blockSegments);
            quoteBlocks.forEach((block) => {
                blocks.push(block);
                htmlParts.push(block.html);
                if (block.text.trim()) {
                    textParts.push(block.text);
                }
            });
            continue;
        }

        if (node.getAttribute('data-testid') === 'tweetText') {
            if (processedTextNodes.has(node)) {
                continue;
            }

            const blockSegments = splitTweetTextIntoSegments(node, {
                allowReferenceDrivenSplit: false,
            });
            if (blockSegments.length === 0) {
                continue;
            }

            processedTextNodes.add(node);
            segments.push(...blockSegments);
            const quoteBlocks = buildQuoteBlocksFromSegments(blockSegments);
            quoteBlocks.forEach((block) => {
                blocks.push(block);
                htmlParts.push(block.html);
                if (block.text.trim()) {
                    textParts.push(block.text);
                }
            });
            continue;
        }

        if (node.matches(TWITTER_CARD_DETAIL_SELECTOR)) {
            if (processedTextNodes.has(node)) {
                continue;
            }

            const blockSegments = extractQuoteCardDetailSegments(node);
            if (blockSegments.length === 0) {
                continue;
            }

            processedTextNodes.add(node);
            segments.push(...blockSegments);
            const quoteBlocks = buildQuoteBlocksFromSegments(blockSegments);
            quoteBlocks.forEach((block) => {
                blocks.push(block);
                htmlParts.push(block.html);
                if (block.text.trim()) {
                    textParts.push(block.text);
                }
            });
            continue;
        }

        const imageResult = extractQuoteImageCandidate(node, seenImageUrls);
        if (imageResult) {
            imageResult.image.order = images.length;
            images.push(imageResult.image);
            blocks.push(imageResult.block);
            htmlParts.push(imageResult.block.html);
        }
    }

    if (blocks.length === 0) {
        return null;
    }

    return {
        blocks,
        images,
        text: textParts.join('\n'),
        html: htmlParts.join(''),
        segments,
    };
}

function getQuoteLinkLabel(url: string, text: string): string {
    const candidate = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) =>
            line &&
            line !== url &&
            !isTwitterCardMetadataText(line) &&
            line !== '（引用推文内容请查看原文）' &&
            line !== '（引用内容为图片）'
        );

    if (!candidate) {
        return url;
    }

    return candidate.length > 80 ? `${candidate.substring(0, 80).trim()}...` : candidate;
}

export function getQuoteLinkLabelFromBlocks(url: string, blocks: ContentBlock[]): string {
    const candidateLines = blocks
        .filter((block) => block.type !== 'image')
        .flatMap((block) => block.text.split('\n'))
        .map((line) => line.trim())
        .filter(Boolean);

    const firstMeaningfulLine = candidateLines.find((line) =>
        line !== url &&
        !isTwitterCardMetadataText(line) &&
        line !== '（引用推文内容请查看原文）' &&
        line !== '（引用内容为图片）'
    );

    if (firstMeaningfulLine) {
        return firstMeaningfulLine.length > 80
            ? `${firstMeaningfulLine.substring(0, 80).trim()}...`
            : firstMeaningfulLine;
    }

    return getQuoteLinkLabel(url, getContentBlocksText(blocks));
}

function mergeXArticleContinuationSegments(segments: Array<{ html: string; text: string }>): Array<{ html: string; text: string }> {
    const merged: Array<{ html: string; text: string }> = [];

    for (const segment of segments) {
        const currentText = segment.text.trim();
        const currentHtml = segment.html.trim();

        if (!currentText || !currentHtml) {
            continue;
        }

        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push({ html: currentHtml, text: currentText });
            continue;
        }

        const previousKind = detectTwitterSegmentLanguage(previous.text);
        const currentKind = detectTwitterSegmentLanguage(currentText);
        const sameLanguage = previousKind !== 'other' && previousKind === currentKind;

        if (
            sameLanguage &&
            !endsWithHardParagraphBoundary(previous.text) &&
            !startsWithExplicitBlockMarker(currentText) &&
            !looksLikeStandaloneHeading(previous.text, previousKind)
        ) {
            const joiner = getSegmentJoiner(previous.text, currentText, previousKind);
            previous.text = `${previous.text.trimEnd()}${joiner}${currentText.trimStart()}`;
            previous.html = `${previous.html}${joiner ? escapeHtml(joiner) : ''}${currentHtml}`;
            continue;
        }

        merged.push({ html: currentHtml, text: currentText });
    }

    return merged;
}

function refineXArticleParagraphSegments(segments: Array<{ html: string; text: string }>): Array<{ html: string; text: string }> {
    const refined = segments.flatMap((segment) => {
        const text = segment.text.trim();
        const html = segment.html.trim();

        if (!text || !html) {
            return [];
        }

        if (html.includes('<br') && !/<(a|strong|em|code)\b/i.test(html)) {
            return splitNestedBrTextSegments(html);
        }

        if (html.includes('<br') || /<(a|strong|em|code)\b/i.test(html)) {
            return [{ html, text }];
        }

        return [{ html, text }];
    });

    return refined;
}

/**
 * Draft.js 有时会把同一段里的文本包成多层容器，flatten 后会留下嵌套 <br>。
 * 这里先按文本行拆开，再交给 continuation merge 重新合并，避免把视觉换行误存成真实段落。
 */
function splitNestedBrTextSegments(html: string): Array<{ html: string; text: string }> {
    const container = document.createElement('div');
    container.innerHTML = html;

    const textLines = (container.innerText || container.textContent || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (textLines.length === 0) {
        return [];
    }

    return mergeXArticleContinuationSegments(textLines.map((line) => ({
        html: escapeHtml(line),
        text: line,
    })));
}

function extractXArticleParagraphSegments(element: HTMLElement): Array<{ html: string; text: string }> {
    // 克隆后归一化翻译插件元素（保留翻译内容，确保正确分行）
    const cleanedElement = element.cloneNode(true) as HTMLElement;
    normalizeTranslationPluginElements(cleanedElement);

    const directVisibleChildren = getVisibleElementChildren(cleanedElement);

    if (hasOnlyStructuralDivChildren(cleanedElement)) {
        const structuralSegments = refineXArticleParagraphSegments(directVisibleChildren
            .map((child) => {
                const html = normalizeXArticleInlineHtml(child);
                const text = trimExtractedSegmentText(child.innerText || child.textContent || '');
                return { html, text };
            })
            .filter((segment) => !!segment.html && !!segment.text));

        return structuralSegments;
    }

    const html = normalizeXArticleInlineHtml(cleanedElement);
    const text = trimExtractedSegmentText(cleanedElement.innerText || cleanedElement.textContent || '');
    return html && text ? refineXArticleParagraphSegments([{ html, text }]) : [];
}

function splitXArticleInlineSegments(html: string): Array<{ html: string; text: string }> {
    const container = document.createElement('div');
    container.innerHTML = html;

    const segments: Array<{ html: string; text: string }> = [];
    let currentNodes: Node[] = [];

    const flushSegment = () => {
        if (currentNodes.length === 0) {
            return;
        }

        const segmentContainer = document.createElement('div');
        currentNodes.forEach((node) => segmentContainer.appendChild(node));

        const segmentHtml = segmentContainer.innerHTML.trim();
        const segmentText = trimExtractedSegmentText(segmentContainer.textContent || segmentContainer.innerText || '');

        if (segmentHtml && segmentText) {
            segments.push({
                html: segmentHtml,
                text: segmentText,
            });
        }

        currentNodes = [];
    };

    Array.from(container.childNodes).forEach((node) => {
        if (node.nodeName === 'BR') {
            flushSegment();
            return;
        }

        currentNodes.push(node.cloneNode(true));
    });

    flushSegment();

    return segments;
}

function getFirstXArticleSegmentText(): string {
    const draftBlocks = Array.from(document.querySelectorAll('.public-DraftStyleDefault-block'))
        .filter((block): block is HTMLElement => block instanceof HTMLElement);

    for (const block of draftBlocks) {
        const translationPairGroups = extractXArticleTranslationPairSegments(block.cloneNode(true) as HTMLElement);
        const preferredOriginal = translationPairGroups
            ?.find((group) => group.original?.text?.trim())
            ?.original?.text;
        if (preferredOriginal) {
            return preferredOriginal;
        }

        const fallbackTranslation = translationPairGroups
            ?.find((group) => group.translation?.text?.trim())
            ?.translation?.text;
        if (fallbackTranslation) {
            return fallbackTranslation;
        }

        const segments = extractXArticleParagraphSegments(block);
        const firstText = segments.find((segment) => !!segment.text)?.text;
        if (firstText) {
            return firstText;
        }
    }

    return '';
}

/**
 * 提取 Quote Tweet 中的图片
 */
function extractQuoteTweetImages(quoteContainer: HTMLElement): ImageCandidate[] {
    const images: ImageCandidate[] = [];
    let order = 0;
    const seenUrls = new Set<string>();

    // 查找媒体图片（标准推文图片）
    const photoElements = quoteContainer.querySelectorAll('[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img');

    photoElements.forEach((img) => {
        const imgEl = img as HTMLImageElement;
        const src = imgEl.src || imgEl.getAttribute('src') || '';

        if (src && !src.includes('profile_images') && !src.includes('emoji') && !seenUrls.has(src)) {
            seenUrls.add(src);
            const normalizedUrl = normalizeImageUrl(src);
            images.push({
                id: generateId(),
                url: src,
                normalizedUrl,
                kind: 'img',
                order: order++,
                inMainContent: true,
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
                alt: imgEl.alt || '',
            });
        }
    });

    // 备选：提取所有图片（用于 X Article 封面等没有标准 data-testid 的情况）
    if (images.length === 0) {
        const allImages = quoteContainer.querySelectorAll('img');
        allImages.forEach((img) => {
            const imgEl = img as HTMLImageElement;
            const src = imgEl.src || imgEl.getAttribute('src') || '';

            if (!src || seenUrls.has(src)) return;

            // 排除已知的非内容图片
            if (src.includes('profile_images') ||
                src.includes('emoji') ||
                src.includes('twemoji') ||
                src.includes('hashflags') ||
                src.includes('abs.twimg.com') ||  // 广告相关
                src.startsWith('data:')) {
                return;
            }

            // 获取图片尺寸（优先使用 naturalWidth/Height）
            const imgWidth = imgEl.naturalWidth || imgEl.width || 0;
            const imgHeight = imgEl.naturalHeight || imgEl.height || 0;

            // 条件：
            // 1. 尺寸已知且足够大（>100）
            // 2. 或者是 pbs.twimg.com 的媒体图片（即使尺寸未加载完成）
            const isTwimgMedia = src.includes('pbs.twimg.com/media/');
            const hasValidSize = imgWidth > 100 && imgHeight > 100;

            if (hasValidSize || isTwimgMedia) {
                seenUrls.add(src);
                const normalizedUrl = normalizeImageUrl(src);
                images.push({
                    id: generateId(),
                    url: src,
                    normalizedUrl,
                    kind: 'img',
                    order: order++,
                    inMainContent: true,
                    width: imgWidth,
                    height: imgHeight,
                    alt: imgEl.alt || '',
                });
                console.log(`[twitterExtractor] 📷 Quote 图片: ${imgWidth}x${imgHeight}, isTwimg=${isTwimgMedia}, src=${src.substring(0, 60)}`);
            }
        });
    }

    return images;
}

/**
 * 提取推文正文内容
 * 
 * 支持识别和提取 Quote Tweet，将其格式化为引用块
 */
async function extractTweetContent(container: HTMLElement, contentStart?: string): Promise<{
    contentHtml: string;
    blocks: ContentBlock[];
    textContent: string;
    quoteTweets: QuoteTweet[];
    quoteTweetContainers: HTMLElement[];
}> {
    // 1. 识别并提取所有 Quote Tweet
    const quoteTweetContainers = findQuoteTweetContainers(container);
    const quoteTweets: QuoteTweet[] = [];

    for (const quoteContainer of quoteTweetContainers) {
        const quoteTweet = await extractQuotedTweet(quoteContainer);
        if (quoteTweet) quoteTweets.push(quoteTweet);
    }

    // 2. 提取主推文文本
    const tweetArticles = container.querySelectorAll('[data-testid="tweet"]');
    if (tweetArticles.length === 0) {
        return { contentHtml: '', blocks: [], textContent: '', quoteTweets, quoteTweetContainers };
    }

    const mainTweetArticle = tweetArticles[0] as HTMLElement;
    const allTweetTextElements = mainTweetArticle.querySelectorAll(TWITTER_SELECTORS.tweetText);
    const mainTweetTextElements = Array.from(allTweetTextElements).filter((el) => {
        const isInsideQuote = quoteTweetContainers.some(c => c.contains(el));
        return !isInsideQuote;
    });

    // 3. 拼装主推文
    const contentParts: string[] = [];
    const blocks: ContentBlock[] = [];
    const textParts: string[] = [];
    const seenTexts = new Set<string>(); // 用于去重

    let isFirstBlock = true;
    const normalizationStart = contentStart ? normalizeText(contentStart) : '';

    for (let elementIndex = 0; elementIndex < mainTweetTextElements.length; elementIndex++) {
        const element = mainTweetTextElements[elementIndex] as HTMLElement;
        // 按换行拆分为独立段落（修复换行丢失和中英文混合问题）
        let segments = splitTweetTextIntoSegments(element);
        if (segments.length === 0) continue;

        const canonicalText = segments
            .map((segment) => trimExtractedSegmentText(segment.text))
            .filter(Boolean)
            .join('\n');
        if (!canonicalText) continue;

        const nextElement = mainTweetTextElements[elementIndex + 1] as HTMLElement | undefined;
        const nextFullText = nextElement ? trimExtractedSegmentText(nextElement.innerText || nextElement.textContent || '') : '';
        if (nextElement && nextFullText) {
            const nextSegments = splitTweetTextIntoSegments(nextElement);
            if (isTranslatedTweetParagraphPair(segments, nextSegments)) {
                segments = buildBilingualTweetParagraphSegments(segments, nextSegments, generateId);
                elementIndex += 1;
            }
        }

        const normalizedCanonicalText = segments
            .map((segment) => trimExtractedSegmentText(segment.text))
            .filter(Boolean)
            .join('\n');
        if (!normalizedCanonicalText) {
            continue;
        }

        // --- 标题/正文去重 (归一化版本) ---
        if (isFirstBlock && normalizationStart) {
            const normalizedText = normalizeText(normalizedCanonicalText);

            // 情况 1: 完全匹配 -> 保留
            if (normalizedText === normalizationStart) {
                console.log(`[twitterExtractor] ℹ️ 标题与正文首段完全一致，保留正文 (防止内容丢失): "${normalizedCanonicalText.substring(0, 20)}..."`);
            }
            // 情况 2: 正文是标题的超集 -> 移除对应的首个 segment
            else if (normalizedText.startsWith(normalizationStart) && contentStart) {
                console.log(`[twitterExtractor] ✂️ 移除段落开头的标题前缀 (Normalized): "${contentStart.substring(0, 20)}..."`);
                const firstSeg = segments[0];
                const firstLine = getFirstNonEmptyLine(firstSeg.text);
                if (firstSeg.textOnly && firstLine.startsWith(contentStart)) {
                    console.log('[twitterExtractor] ✂️ 首段双语内容与标题重复，整段从正文中移除');
                    segments = segments.slice(1);
                } else if (firstSeg.text.startsWith(contentStart)) {
                    const newText = firstSeg.text.substring(contentStart.length).trim();
                    if (newText) {
                        segments[0] = {
                            ...firstSeg,
                            html: escapeHtml(newText),
                            text: newText,
                        };
                    } else {
                        segments = segments.slice(1);
                    }
                }
                if (segments.length === 0) {
                    isFirstBlock = false;
                    continue;
                }
            }
        }
        isFirstBlock = false;

        // 去重：用整体文本去重
        if (seenTexts.has(normalizedCanonicalText)) continue;
        seenTexts.add(normalizedCanonicalText);

        segments.forEach((segment) => {
            if (segment.role !== 'spacer' && segment.text.trim()) {
                textParts.push(segment.text);
            }
        });
        appendTwitterParagraphSegments(blocks, contentParts, segments);
    }

    console.log(`[twitterExtractor] 📝 主推文提取: ${mainTweetTextElements.length} 个文本块, ${textParts.length} 个有效段落`);

    // 4. 拼装引用推文（严格遵循 Link -> Quote -> Images 顺序）
    quoteTweets.forEach((qt, qtIndex) => {
        appendQuoteTweetBlocks(blocks, contentParts, textParts, qt);

        console.log(`[twitterExtractor] 📝 Quote #${qtIndex + 1} 拼装: 图片=${qt.images.length}`);
    });

    const {
        blocks: normalizedBlocks,
        contentHtml,
        textContent,
    } = finalizeTwitterContentBlocks(blocks);

    return {
        contentHtml,
        blocks: normalizedBlocks,
        textContent,
        quoteTweets,
        quoteTweetContainers,
    };
}

/**
 * 提取推文中的图片
 * @param container 推文容器
 * @param excludeContainers 需要排除的容器（如引用帖容器），这些容器内的图片不会被提取
 */
function extractTweetImages(container: HTMLElement, excludeContainers: HTMLElement[] = []): ImageCandidate[] {
    // 只从主要推文区域提取图片，排除头像等
    const tweetArticles = container.querySelectorAll('[data-testid="tweet"]');

    if (tweetArticles.length === 0) {
        // 备选：直接从容器提取
        return extractImages(container);
    }

    // 只取第一条推文（主推文）的图片
    const mainTweet = tweetArticles[0] as HTMLElement;

    // 辅助函数：检查图片是否在排除容器内
    const isInExcludedContainer = (imgEl: HTMLElement): boolean => {
        for (const excludeContainer of excludeContainers) {
            if (excludeContainer.contains(imgEl)) {
                return true;
            }
        }
        return false;
    };

    // 查找推文中的图片（排除头像）
    const images: ImageCandidate[] = [];
    let order = 0;

    // 媒体图片通常在 [data-testid="tweetPhoto"] 中
    const photoElements = mainTweet.querySelectorAll('[data-testid="tweetPhoto"] img');

    photoElements.forEach((img) => {
        const imgEl = img as HTMLImageElement;

        // 排除在引用帖容器内的图片
        if (isInExcludedContainer(imgEl)) {
            console.log('[twitterExtractor] ⏭️ 跳过引用帖内的图片');
            return;
        }

        const src = imgEl.src || imgEl.getAttribute('src') || '';

        if (src && !src.includes('profile_images') && !src.includes('emoji')) {
            const normalizedUrl = normalizeImageUrl(src);
            images.push({
                id: generateId(),
                url: src,
                normalizedUrl,
                kind: 'img',
                order: order++,
                inMainContent: true,
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
                alt: imgEl.alt || '',
            });
        }
    });

    // 备选：提取普通图片（排除头像）
    if (images.length === 0) {
        const allImages = mainTweet.querySelectorAll('img');
        allImages.forEach((img) => {
            const imgEl = img as HTMLImageElement;

            // 排除在引用帖容器内的图片
            if (isInExcludedContainer(imgEl)) {
                return;
            }

            const src = imgEl.src || imgEl.getAttribute('src') || '';

            // 排除头像和 emoji
            if (src &&
                !src.includes('profile_images') &&
                !src.includes('emoji') &&
                !src.includes('twemoji') &&
                imgEl.width > 100 && imgEl.height > 100) {
                const normalizedUrl = normalizeImageUrl(src);
                images.push({
                    id: generateId(),
                    url: src,
                    normalizedUrl,
                    kind: 'img',
                    order: order++,
                    inMainContent: true,
                    width: imgEl.naturalWidth || imgEl.width,
                    height: imgEl.naturalHeight || imgEl.height,
                    alt: imgEl.alt || '',
                });
            }
        });
    }

    console.log(`[twitterExtractor] 📷 提取到 ${images.length} 张主推文图片 (排除了 ${excludeContainers.length} 个引用帖容器)`);
    return images;
}

/**
 * 提取作者
 */
function extractAuthor(): string | undefined {
    // 从页面 title 提取作者名
    const title = document.title;
    const match = title.match(/^\(?(?:\d+\)\s*)?(.+?)\s+on X:/);
    return match ? match[1].trim() : undefined;
}

/**
 * 提取发布时间
 */
function extractPublishTime(): string | undefined {
    // 查找第一个 time 元素
    const timeEl = document.querySelector(`${TWITTER_SELECTORS.primaryColumn} time`);
    if (timeEl) {
        return timeEl.getAttribute('datetime') || timeEl.textContent?.trim();
    }
    return undefined;
}

/**
 * 创建空结果
 */
function createEmptyResult(url: string, domain: string): ExtractResult {
    return {
        title: document.title || '推文',
        sourceUrl: url,
        domain,
        contentHtml: '',
        blocks: [],
        images: [],
        wordCount: 0,
    };
}

/**
 * 提取 X Article (长文章) 内容
 *
 * contentStart 参数用于移除已经作为标题使用的正文开头
 */
async function extractXArticleContent(container: HTMLElement, contentStart?: string): Promise<{
    contentHtml: string;
    blocks: ContentBlock[];
    textContent: string;
    images: ImageCandidate[];
    quoteTweets: QuoteTweet[];
    quoteTweetContainers: HTMLElement[];
}> {
    const blocks: ContentBlock[] = [];
    const contentParts: string[] = [];
    const textParts: string[] = [];
    const images: ImageCandidate[] = [];
    const quoteTweets: QuoteTweet[] = [];
    const quoteTweetContainers: HTMLElement[] = [];
    const seenUrls = new Set<string>();
    const seenTexts = new Set<string>();

    // 找到文章内容区域
    const articleContainer = container.querySelector('[data-testid="tweet"]') || container;

    // 预先识别所有 Quote Tweet 容器
    const allQuoteContainers = findQuoteTweetContainers(container);
    const quoteContainerSet = new Set(allQuoteContainers);

    console.log(`[twitterExtractor] 📄 X Article 按顺序提取开始，找到 ${allQuoteContainers.length} 个 Quote 容器`);

    let isFirstBlock = true;

    // 使用栈迭代遍历 DOM（按 DOM 顺序处理所有节点）
    // 栈中存储 [element, childIndex]，表示当前处理的元素及其子节点索引
    const stack: Array<{ element: HTMLElement; childIndex: number }> = [];
    const processed = new Set<HTMLElement>();

    // 初始化栈
    if (articleContainer.nodeType === Node.ELEMENT_NODE) {
        stack.push({ element: articleContainer as HTMLElement, childIndex: -1 });
    }

    while (stack.length > 0) {
        const current = stack[stack.length - 1];
        const element = current.element;

        // childIndex === -1 表示首次访问此节点，需要处理自身
        if (current.childIndex === -1) {
            current.childIndex = 0;

            // 跳过已处理的节点
            if (processed.has(element)) {
                stack.pop();
                continue;
            }

            // 检查是否是 Quote Tweet 容器
            if (quoteContainerSet.has(element)) {
                processed.add(element);
                // 适配新的 extractQuotedTweet 函数（异步）
                const quoteTweet = await extractQuotedTweet(element);
                if (quoteTweet) {
                    quoteTweets.push(quoteTweet);
                    quoteTweetContainers.push(element);
                    appendQuoteTweetBlocks(blocks, contentParts, textParts, quoteTweet, {
                        onImage: (image) => {
                            images.push(image);
                        },
                    });

                    console.log(`[twitterExtractor] 📝 Quote Tweet 按顺序插入: url=${quoteTweet.url}, images=${quoteTweet.images.length}`);
                }
                stack.pop(); // 不再递归处理 Quote 容器内部
                continue;
            }

            // 检查是否在 Quote Tweet 容器内（跳过）
            let isInsideQuote = false;
            for (const qc of allQuoteContainers) {
                if (qc.contains(element) && element !== qc) {
                    isInsideQuote = true;
                    break;
                }
            }
            if (isInsideQuote) {
                stack.pop();
                continue;
            }

            // 检查是否是 Draft.js 文字块
            if (element.classList.contains('public-DraftStyleDefault-block')) {
                processed.add(element);

                // ===== 优先走翻译对路径：在原始 DOM 上精确分离原文和译文 =====
                const rawClone = element.cloneNode(true) as HTMLElement;
                const translationPairGroups = extractXArticleTranslationPairSegments(rawClone);

                if (translationPairGroups) {
                    const fullText = translationPairGroups
                        .flatMap((group) => [group.original?.text, group.translation?.text])
                        .filter((text): text is string => Boolean(text))
                        .join('\n');

                    if (fullText.trim() && !seenTexts.has(fullText)) {
                        // 去重逻辑：移除标题（与现有逻辑一致）
                        if (isFirstBlock && contentStart) {
                            const cleanContentStart = contentStart.trim();
                            if (fullText === cleanContentStart || fullText.startsWith(cleanContentStart)) {
                                console.log(`[twitterExtractor] ✂️ X Article 翻译对模式移除标题: "${fullText.substring(0, 20)}..."`);
                                isFirstBlock = false;
                                stack.pop();
                                continue;
                            }
                        }
                        isFirstBlock = false;

                        seenTexts.add(fullText);
                        textParts.push(fullText);
                        appendTwitterParagraphSegments(
                            blocks,
                            contentParts,
                            buildTwitterSegmentsFromXArticleTranslationGroups(translationPairGroups)
                        );
                    }
                    stack.pop();
                    continue;
                }
                // ===== 翻译对路径结束 =====

                // 无翻译对，走现有逻辑
                const cleanedBlock = element.cloneNode(true) as HTMLElement;
                normalizeTranslationPluginElements(cleanedBlock);
                const text = cleanedBlock.innerText?.trim() || '';
                const segments = extractXArticleParagraphSegments(cleanedBlock);

                if (text && !seenTexts.has(text)) {
                    // 去重逻辑：移除标题
                    if (isFirstBlock && contentStart) {
                        const cleanContentStart = contentStart.trim();
                        if (text === cleanContentStart || text.startsWith(cleanContentStart)) {
                            console.log(`[twitterExtractor] ✂️ X Article 移除标题段落: "${text.substring(0, 20)}..."`);
                            isFirstBlock = false;
                            stack.pop();
                            continue;
                        }
                    }
                    isFirstBlock = false;

                    seenTexts.add(text);
                    textParts.push(text);

                    const paragraphSegments = segments.length > 0
                        ? segments
                        : [];
                    appendTwitterParagraphSegments(
                        blocks,
                        contentParts,
                        paragraphSegments.map((segment) => ({
                            html: segment.html,
                            text: segment.text,
                            role: 'normal' as const,
                        }))
                    );
                }
                stack.pop(); // 不再递归处理文字块内部
                continue;
            }

            // 检查是否是代码块
            if (element.tagName === 'PRE') {
                processed.add(element);
                const normalizedCodeBlock = extractNormalizedCodeBlock(element);

                if (normalizedCodeBlock) {
                    contentParts.push(normalizedCodeBlock.html);
                    textParts.push(normalizedCodeBlock.text);
                    blocks.push({
                        id: generateId(),
                        type: 'code',
                        html: normalizedCodeBlock.html,
                        text: normalizedCodeBlock.text,
                    });
                    console.log(`[twitterExtractor] 💻 X Article 代码块: ${normalizedCodeBlock.text.substring(0, 40)}...`);
                }

                stack.pop();
                continue;
            }

            // 检查是否是图片（媒体图片）
            if (element.tagName === 'IMG') {
                processed.add(element);
                const img = element as HTMLImageElement;
                const src = img.src || img.getAttribute('data-src') || '';

                // 跳过无效 URL
                if (!src || src.startsWith('data:') || src.includes('profile_images') ||
                    src.includes('emoji') || src.includes('twemoji') || src.includes('1x1')) {
                    stack.pop();
                    continue;
                }

                // 使用 naturalWidth/naturalHeight 验证图片已加载（比 width/height 更准确）
                const imgWidth = img.naturalWidth || img.width;
                const imgHeight = img.naturalHeight || img.height;
                const isComplete = img.complete && imgWidth > 0;

                // 跳过太小的图片（可能是图标或占位符）
                if (imgWidth < 100 || imgHeight < 100) {
                    console.log(`[twitterExtractor] ⏭️ 跳过小图片: ${imgWidth}x${imgHeight}, src=${src.substring(0, 50)}`);
                    stack.pop();
                    continue;
                }

                const normalizedUrl = normalizeImageUrl(src);
                if (!seenUrls.has(normalizedUrl)) {
                    seenUrls.add(normalizedUrl);

                    const imgCandidate: ImageCandidate = {
                        id: generateId(),
                        url: src,
                        normalizedUrl: normalizedUrl,
                        kind: 'img',
                        order: images.length,
                        inMainContent: true,
                        alt: img.alt || '',
                        width: imgWidth,
                        height: imgHeight,
                    };
                    images.push(imgCandidate);

                    // Use real alt text if available and meaningful, otherwise empty string
                    const rawAlt = (img.alt || '').trim();
                    // Filter out generic placeholders
                    const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                        rawAlt === 'null' || rawAlt === 'undefined';
                    const altText = (rawAlt && !isGeneric) ? rawAlt : '';
                    blocks.push({
                        id: generateId(),
                        type: 'image',
                        html: `<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`,
                        text: altText,
                    });
                    contentParts.push(`<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`);

                    console.log(`[twitterExtractor] 📷 图片 ${images.length}: ${imgWidth}x${imgHeight}, complete=${isComplete}, src=${src.substring(0, 60)}`);
                }
                stack.pop();
                continue;
            }

            // 检查是否是图片容器 [data-testid="tweetPhoto"]
            if (element.getAttribute('data-testid') === 'tweetPhoto') {
                processed.add(element);
                const img = element.querySelector('img') as HTMLImageElement;
                if (img) {
                    const src = img.src || img.getAttribute('data-src') || '';
                    if (src && !src.includes('profile_images') && !src.includes('emoji')) {
                        const normalizedUrl = normalizeImageUrl(src);
                        if (!seenUrls.has(normalizedUrl)) {
                            seenUrls.add(normalizedUrl);

                            const imgCandidate: ImageCandidate = {
                                id: generateId(),
                                url: src,
                                normalizedUrl: normalizedUrl,
                                kind: 'img',
                                order: images.length,
                                inMainContent: true,
                                alt: img.alt || '',
                                width: img.naturalWidth || img.width,
                                height: img.naturalHeight || img.height,
                            };
                            images.push(imgCandidate);

                            // Use real alt text if available and meaningful, otherwise empty string
                            const rawAlt = (img.alt || '').trim();
                            // Filter out generic placeholders
                            const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                                rawAlt === 'null' || rawAlt === 'undefined';
                            const altText = (rawAlt && !isGeneric) ? rawAlt : '';
                            blocks.push({
                                id: generateId(),
                                type: 'image',
                                html: `<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`,
                                text: altText,
                            });
                            contentParts.push(`<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`);
                        }
                    }
                }
                stack.pop();
                continue;
            }
        }

        // 处理子节点
        const children = element.children;
        if (current.childIndex < children.length) {
            const child = children[current.childIndex] as HTMLElement;
            current.childIndex++;
            if (child.nodeType === Node.ELEMENT_NODE) {
                stack.push({ element: child, childIndex: -1 });
            }
        } else {
            // 所有子节点都处理完了，弹出当前节点
            stack.pop();
        }
    }

    debugLogXArticleBlockSequence('结构化输出前', blocks);
    const {
        blocks: normalizedBlocks,
        contentHtml,
        textContent,
    } = finalizeTwitterContentBlocks(blocks);
    debugLogXArticleBlockSequence('结构化输出后', normalizedBlocks);

    console.log(`[twitterExtractor] 📄 X Article 按顺序提取完成: ${normalizedBlocks.length} 个块, ${textContent.length} 字, ${images.length} 张图片, ${quoteTweets.length} 个引用`);

    return {
        contentHtml,
        blocks: normalizedBlocks,
        textContent,
        images,
        quoteTweets,
        quoteTweetContainers,
    };
}


/**
 * 获取 DOM 元素的 React Props
 */
function getReactProps(el: Element): any {
    if (!el) return null;
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    return propsKey ? (el as any)[propsKey] : null;
}

/**
 * 在 React Props 中深度查找 tweet 数据对象（保留旧函数兼容性）
 */
function findTweetDataInProps(props: any, depth = 0): any {
    if (!props || depth > 8) return null;

    // 1. 直接检查是否是 tweet 对象
    if (props.tweet && typeof props.tweet === 'object') {
        return props.tweet;
    }
    if (props.content && props.content.tweet) return props.content.tweet;

    if (props.id && (props.canonical_url || props.__typename === 'Tweet' || props.__typename === 'Article')) {
        return props;
    }

    const children = props.children;
    if (Array.isArray(children)) {
        for (const child of children) {
            if (child && child.props) {
                const found = findTweetDataInProps(child.props, depth + 1);
                if (found) return found;
            }
        }
    } else if (children && typeof children === 'object' && children.props) {
        const found = findTweetDataInProps(children.props, depth + 1);
        if (found) return found;
    }

    if (props.memoizedProps) {
        const found = findTweetDataInProps(props.memoizedProps, depth + 1);
        if (found) return found;
    }

    // 新增：检查 pendingProps
    if (props.pendingProps) {
        const found = findTweetDataInProps(props.pendingProps, depth + 1);
        if (found) return found;
    }

    return null;
}
