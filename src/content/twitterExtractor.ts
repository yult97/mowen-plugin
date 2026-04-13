/**
 * Twitter/X 专用内容提取器
 * 
 * 只提取推文正文内容，排除所有动态元素（点赞数、时间戳、评论等），
 * 确保每次提取的字数稳定一致。
 * 支持提取 Quote Tweet（引用推文）并格式化为引用块。
 */

import { ExtractResult, ContentBlock, ImageCandidate } from '../types';
import { generateId } from '../utils/helpers';
import { findMixedLanguageSplitBoundaries } from '../utils/mixedLanguage';
import { extractImages } from './images';
import { TWITTER_SELECTORS } from '../config/site-selectors';
import { normalizeImageUrl } from './imageNormalizer';
import { detectCodeLanguage } from '../utils/shikiLanguages';

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

    const originalText = trimExtractedSegmentText(originalClone.innerText || originalClone.textContent || '');
    const textParagraphs = splitTweetTextParagraphs(originalText);
    if (textParagraphs.length > segments.length) {
        segments = textParagraphs.map((paragraphText, index) => ({
            html: escapeHtml(paragraphText),
            text: paragraphText,
            anchorTemplate: segments[index]?.anchorTemplate,
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
        const paragraphSegments = splitHtmlIntoParagraphSegments(normalizedHtml, { singleBreakAsBoundary: true });

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

function buildXArticleBilingualGroups(
    originalSegments: Array<{ html: string; text: string }>,
    translationSegments: Array<{ html: string; text: string }>
): XArticleBilingualGroup[] {
    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return [];
    }

    if (originalSegments.length !== translationSegments.length) {
        console.warn(
            `[twitterExtractor] ⚠️ X Article 双语段落数不一致，按顺序对齐: original=${originalSegments.length}, translation=${translationSegments.length}`
        );
    }

    const total = Math.max(originalSegments.length, translationSegments.length);
    const groups: XArticleBilingualGroup[] = [];

    for (let index = 0; index < total; index++) {
        const original = originalSegments[index];
        const translation = translationSegments[index];

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

function summarizeXArticleSegmentsForLog(
    segments: Array<{ text: string }>
): string {
    return segments
        .slice(0, 3)
        .map((segment, index) => {
            const snippet = segment.text
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, 36);
            return `${index + 1}:${snippet}`;
        })
        .join(' | ');
}

function shouldUseXArticleTranslationPairing(
    originalSegments: Array<{ html: string; text: string }>,
    translationSegments: Array<{ html: string; text: string }>
): boolean {
    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return false;
    }

    const originalCount = originalSegments.length;
    const translationCount = translationSegments.length;
    const maxCount = Math.max(originalCount, translationCount);
    const minCount = Math.min(originalCount, translationCount);
    const ratio = minCount / maxCount;
    const diff = maxCount - minCount;

    const originalLanguage = getDominantParagraphLanguageKind(originalSegments);
    const translationLanguage = getDominantParagraphLanguageKind(translationSegments);
    if (
        originalLanguage === 'other' ||
        translationLanguage === 'other' ||
        originalLanguage === translationLanguage
    ) {
        console.log(
            `[twitterExtractor] ⚠️ X Article 翻译对语言不可靠，跳过精确配对: original=${originalLanguage}, translation=${translationLanguage}`
        );
        console.log(
            `[twitterExtractor] ↪️ 原文示例: ${summarizeXArticleSegmentsForLog(originalSegments)}`
        );
        console.log(
            `[twitterExtractor] ↪️ 译文示例: ${summarizeXArticleSegmentsForLog(translationSegments)}`
        );
        return false;
    }

    const hasSevereCountMismatch =
        (maxCount >= 3 && minCount <= 1) ||
        ratio < 0.5 ||
        (diff >= 2 && ratio < 0.67);

    if (hasSevereCountMismatch) {
        console.log(
            `[twitterExtractor] ⚠️ X Article 翻译对段落数差异过大，回退到通用重排: original=${originalCount}, translation=${translationCount}, ratio=${ratio.toFixed(2)}`
        );
        console.log(
            `[twitterExtractor] ↪️ 原文示例: ${summarizeXArticleSegmentsForLog(originalSegments)}`
        );
        console.log(
            `[twitterExtractor] ↪️ 译文示例: ${summarizeXArticleSegmentsForLog(translationSegments)}`
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
    element: HTMLElement
): XArticleBilingualGroup[] | null {
    const originalSegments = buildOriginalParagraphSegments(element);
    const translationSegments = buildTranslationParagraphSegments(element, originalSegments);

    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return null;
    }

    if (!shouldUseXArticleTranslationPairing(originalSegments, translationSegments)) {
        return null;
    }

    const originalTextLength = originalSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    const translationTextLength = translationSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    console.log(`[twitterExtractor] 🌐 翻译对检测成功: 原文 ${originalTextLength} 字, 译文 ${translationTextLength} 字, 段落 ${originalSegments.length}/${translationSegments.length}`);

    return buildXArticleBilingualGroups(originalSegments, translationSegments);
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
    /** 引用推文拆分后的段落序列（仅 X 剪藏链路使用） */
    segments?: TweetTextSegment[];
    /** 引用推文的文本内容 */
    text: string;
    /** 引用推文的 HTML 内容 */
    html: string;
    /** 引用推文中的图片 */
    images: ImageCandidate[];
}

interface TweetTextSegment {
    html: string;
    text: string;
    textOnly?: boolean;
    role?: 'original' | 'translation' | 'spacer' | 'normal';
}

interface TranslationPairSegment {
    original: TweetTextSegment[];
    translation: TweetTextSegment[];
}

const TWEET_PARAGRAPH_SPACER_HTML = '<p data-mowen-preserve-inline-paragraph="1"><br></p>';

function createTweetParagraphSpacerSegment(): TweetTextSegment {
    return {
        html: TWEET_PARAGRAPH_SPACER_HTML,
        text: '',
        role: 'spacer',
    };
}

function renderTweetTextSegmentsToHtml(segments: TweetTextSegment[]): string {
    let html = '';
    let shouldInsertBreakBeforeNext = false;

    for (const segment of segments) {
        if (segment.role === 'spacer') {
            if (html) {
                html = html.replace(/(?:<br\s*\/?>\s*)+$/gi, '');
                html += '<br><br>';
            }
            shouldInsertBreakBeforeNext = false;
            continue;
        }

        const segmentHtml = segment.html?.trim();
        if (!segmentHtml) {
            continue;
        }

        if (shouldInsertBreakBeforeNext && html) {
            html += '<br>';
        }

        html += segmentHtml;
        shouldInsertBreakBeforeNext = true;
    }

    return html;
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
        const translationPairGroups = extractXArticleTranslationPairSegments(block.cloneNode(true) as HTMLElement);

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

    const normalizedBlocks = insertXArticleSpacing(rebalanceXArticleBilingualBlocks(quoteBlocks));
    const segments: TweetTextSegment[] = normalizedBlocks.flatMap((block) => {
        if (isXArticleSpacerBlock(block)) {
            return [createTweetParagraphSpacerSegment()];
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
        }];
    });

    return segments;
}

function appendQuoteTweetContentBlocks(
    blocks: ContentBlock[],
    contentParts: string[],
    textParts: string[],
    quoteTweet: QuoteTweet
): void {
    const segments = quoteTweet.segments || [];

    if (segments.length === 0) {
        const quoteBlock: ContentBlock = {
            id: generateId(),
            type: 'quote',
            html: `<blockquote>${quoteTweet.html}</blockquote>`,
            text: quoteTweet.text,
        };
        blocks.push(quoteBlock);
        contentParts.push(quoteBlock.html);
        textParts.push(quoteTweet.text);
        return;
    }

    const htmlParts: string[] = [];
    const textPartsInQuote: string[] = [];

    segments.forEach((segment) => {
        if (segment.role === 'spacer') {
            htmlParts.push('<p><br></p>');
            if (textPartsInQuote.length > 0 && textPartsInQuote[textPartsInQuote.length - 1] !== '') {
                textPartsInQuote.push('');
            }
            return;
        }

        const trimmedText = segment.text.trim();
        const trimmedHtml = segment.html.trim();
        if (!trimmedText || !trimmedHtml) {
            return;
        }

        htmlParts.push(`<p data-mowen-preserve-inline-paragraph="1">${trimmedHtml}</p>`);
        textPartsInQuote.push(trimmedText);
    });

    const quoteText = textPartsInQuote.join('\n');
    if (!quoteText.trim()) {
        return;
    }

    const quoteBlock: ContentBlock = {
        id: generateId(),
        type: 'quote',
        html: `<blockquote>${htmlParts.join('')}</blockquote>`,
        text: quoteText,
    };
    blocks.push(quoteBlock);
    contentParts.push(quoteBlock.html);
    textParts.push(quoteText);
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
        const original = originalSegments[index];
        const translation = translationSegments[index];

        if (!original && !translation) {
            continue;
        }

        if (original) {
            result.push({
                ...original,
                role: 'original',
            });
        }

        if (translation) {
            result.push({
                ...translation,
                role: 'translation',
            });
        }

        if (index < total - 1) {
            result.push(createTweetParagraphSpacerSegment());
        }
    }

    return result;
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

    const block = createXArticleParagraphContentBlock(
        { html: `<p data-mowen-preserve-inline-paragraph="1">${segment.html}</p>`, text: trimmedText },
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
    const block = createXArticleSpacerContentBlock(groupId);
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

function createXArticleSpacerContentBlock(groupId?: string): ContentBlock {
    return {
        id: generateId(),
        type: 'paragraph',
        html: TWEET_PARAGRAPH_SPACER_HTML,
        text: '',
        layout: {
            preserveInlineParagraphs: true,
            ...(groupId ? { groupId } : {}),
            role: 'spacer',
        },
    };
}

function isPlainXArticleParagraphBlock(block: ContentBlock): boolean {
    return (
        block.type === 'paragraph' &&
        block.layout?.preserveInlineParagraphs === true &&
        (block.layout.role === 'normal' || !block.layout.role) &&
        Boolean(block.text.trim())
    );
}

function isXArticleTextBlock(block: ContentBlock): boolean {
    return (
        block.type === 'paragraph' &&
        block.layout?.preserveInlineParagraphs === true &&
        block.layout.role !== 'spacer' &&
        Boolean(block.text.trim())
    );
}

function isXArticleSpacerBlock(block: ContentBlock): boolean {
    return (
        block.type === 'paragraph' &&
        block.layout?.preserveInlineParagraphs === true &&
        block.layout.role === 'spacer'
    );
}

function splitXArticleParagraphContentBlock(block: ContentBlock): ContentBlock[] {
    if (!isPlainXArticleParagraphBlock(block)) {
        return [block];
    }

    const container = document.createElement('div');
    container.innerHTML = block.html;

    const paragraphElement = container.firstElementChild instanceof HTMLElement &&
        container.firstElementChild.tagName === 'P'
        ? container.firstElementChild
        : null;
    const inlineHtml = (paragraphElement?.innerHTML || container.innerHTML || '').trim();
    const inlineText = trimExtractedSegmentText(block.text);

    if (!inlineHtml || !inlineText) {
        return [block];
    }

    let segments = splitHtmlIntoParagraphSegments(inlineHtml, { singleBreakAsBoundary: true });

    if (segments.length <= 1 && inlineHtml.includes('<br')) {
        const splitSegments = refineXArticleParagraphSegments(splitXArticleInlineSegments(inlineHtml));
        if (splitSegments.length > 1) {
            segments = splitSegments;
        }
    }

    if (segments.length <= 1 && inlineText.includes('\n')) {
        const lineSegments = inlineText
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => ({
                html: escapeHtml(line),
                text: line,
            }));

        if (lineSegments.length > 1) {
            segments = refineXArticleParagraphSegments(lineSegments);
        }
    }

    if (segments.length <= 1) {
        return [block];
    }

    return segments.map((segment) => createXArticleParagraphContentBlock(
        { html: `<p>${segment.html}</p>`, text: segment.text },
        { role: 'normal' }
    ));
}

function buildXArticleBilingualRun(
    primaryBlocks: ContentBlock[],
    secondaryBlocks: ContentBlock[]
): ContentBlock[] | null {
    const expandedPrimary = primaryBlocks.flatMap(splitXArticleParagraphContentBlock);
    const expandedSecondary = secondaryBlocks.flatMap(splitXArticleParagraphContentBlock);

    if (expandedPrimary.length === 0 || expandedSecondary.length === 0) {
        return null;
    }

    const primaryLanguage = getXArticleSegmentLanguageKind(expandedPrimary[0]?.text || '');
    const secondaryLanguage = getXArticleSegmentLanguageKind(expandedSecondary[0]?.text || '');
    const englishFirst = primaryLanguage === 'english' || secondaryLanguage !== 'english';
    const originalBlocks = englishFirst ? expandedPrimary : expandedSecondary;
    const translationBlocks = englishFirst ? expandedSecondary : expandedPrimary;

    if (expandedPrimary.length !== expandedSecondary.length) {
        console.log(
            `[twitterExtractor] ⚠️ X Article 连续段落数不一致，按顺序兜底配对：primary=${expandedPrimary.length}, secondary=${expandedSecondary.length}`
        );
    }

    const result: ContentBlock[] = [];
    const total = Math.max(originalBlocks.length, translationBlocks.length);

    for (let index = 0; index < total; index++) {
        const groupId = generateId();
        const original = originalBlocks[index];
        const translation = translationBlocks[index];

        if (original) {
            result.push(createXArticleParagraphContentBlock(
                { html: original.html, text: original.text },
                { groupId, role: 'original' }
            ));
        }

        if (translation) {
            result.push(createXArticleParagraphContentBlock(
                { html: translation.html, text: translation.text },
                { groupId, role: 'translation' }
            ));
        }

        if (index < total - 1) {
            result.push(createXArticleSpacerContentBlock(groupId));
        }
    }

    return result;
}

function rebalanceXArticleParagraphRun(blocks: ContentBlock[]): ContentBlock[] {
    const candidates = blocks.filter((block) => Boolean(block.text.trim()));
    if (candidates.length < 2) {
        return blocks;
    }

    const languageRuns = candidates.reduce<Array<{
        language: XArticleSegmentLanguageKind;
        blocks: ContentBlock[];
    }>>((runs, block) => {
        const language = getXArticleSegmentLanguageKind(block.text);
        const lastRun = runs[runs.length - 1];

        if (!lastRun || lastRun.language !== language) {
            runs.push({
                language,
                blocks: [block],
            });
            return runs;
        }

        lastRun.blocks.push(block);
        return runs;
    }, []);

    if (languageRuns.length < 2) {
        return blocks;
    }

    const result: ContentBlock[] = [];
    let runIndex = 0;

    while (runIndex < languageRuns.length) {
        const currentRun = languageRuns[runIndex];
        const nextRun = languageRuns[runIndex + 1];

        if (
            currentRun.language !== 'other' &&
            nextRun &&
            nextRun.language !== 'other' &&
            currentRun.language !== nextRun.language
        ) {
            const rebalanced = buildXArticleBilingualRun(currentRun.blocks, nextRun.blocks);
            if (rebalanced) {
                console.log(
                    `[twitterExtractor] 🔁 X Article 相邻双语段重排成功: ${currentRun.language}/${nextRun.language}, original=${currentRun.blocks.length}, translation=${nextRun.blocks.length}`
                );
                result.push(...rebalanced);
                runIndex += 2;
                continue;
            }
        }

        result.push(...currentRun.blocks);
        runIndex += 1;
    }

    return result;
}

function rebalanceXArticleBilingualBlocks(blocks: ContentBlock[]): ContentBlock[] {
    const result: ContentBlock[] = [];
    let currentRun: ContentBlock[] = [];

    const flushRun = () => {
        if (currentRun.length === 0) {
            return;
        }

        result.push(...rebalanceXArticleParagraphRun(currentRun));
        currentRun = [];
    };

    for (const block of blocks) {
        if (isPlainXArticleParagraphBlock(block)) {
            currentRun.push(block);
            continue;
        }

        if (isXArticleSpacerBlock(block)) {
            continue;
        }

        flushRun();
        result.push(block);
    }

    flushRun();
    return result;
}

function insertXArticleSpacing(blocks: ContentBlock[]): ContentBlock[] {
    const result: ContentBlock[] = [];

    const getNextNonSpacerBlockIndex = (startIndex: number): number => {
        for (let index = startIndex; index < blocks.length; index++) {
            if (!isXArticleSpacerBlock(blocks[index])) {
                return index;
            }
        }
        return -1;
    };

    const shouldKeepSpacerBetween = (
        previous: ContentBlock | undefined,
        next: ContentBlock | undefined
    ): boolean => {
        if (!previous || !next || !isXArticleTextBlock(previous) || !isXArticleTextBlock(next)) {
            return false;
        }

        const previousGroupId = previous.layout?.groupId;
        const nextGroupId = next.layout?.groupId;
        const isBilingualPair =
            Boolean(previousGroupId) &&
            previousGroupId === nextGroupId &&
            previous.layout?.role === 'original' &&
            next.layout?.role === 'translation';

        return !isBilingualPair;
    };

    for (let index = 0; index < blocks.length; index++) {
        const current = blocks[index];
        if (isXArticleSpacerBlock(current)) {
            const previous = result[result.length - 1];
            const nextIndex = getNextNonSpacerBlockIndex(index + 1);
            const next = nextIndex >= 0 ? blocks[nextIndex] : undefined;
            if (shouldKeepSpacerBetween(previous, next)) {
                result.push(current);
            }
            continue;
        }

        result.push(current);

        const nextIndex = getNextNonSpacerBlockIndex(index + 1);
        const next = nextIndex >= 0 ? blocks[nextIndex] : undefined;
        if (!shouldKeepSpacerBetween(current, next)) {
            continue;
        }

        const hasExplicitSpacerAhead = nextIndex > index + 1;

        if (!hasExplicitSpacerAhead) {
            result.push(createXArticleSpacerContentBlock(current.layout?.groupId));
        }
    }

    return result;
}

function debugLogXArticleBlockSequence(stage: string, blocks: ContentBlock[]): void {
    const textBlocks = blocks.filter((block) => block.type === 'paragraph');
    const preview = textBlocks
        .slice(0, 40)
        .map((block, index) => {
            const role = block.layout?.role || 'normal';
            const language = getXArticleSegmentLanguageKind(block.text);
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

    // 1. 检测是否为 X Article
    const isXArticle = detectXArticle(container);

    // 2. 提取标题
    const { title, contentStart } = extractTitleWithMeta(container, isXArticle);

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
                finalBlocks[0] = {
                    ...firstBlock,
                    text: newText,
                    html: `<p>${newText}</p>`,
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
        contentHtml: finalContentHtml,
        blocks: finalBlocks,
        images,
        wordCount,
    };
}

/**
 * 提取页面标题（带元数据）
 * 使用格式：「作者名：正文前 30 字」
 * 对于 X Article，优先使用文章标题
 * 
 * @returns { title: 最终标题, contentStart: 返回用于去重的原始文本（不截断） }
 */
function extractTitleWithMeta(container: HTMLElement, isXArticle: boolean): { title: string; contentStart?: string } {
    // 尝试从主推文提取作者名
    const authorElement = container.querySelector('[data-testid="User-Name"]') ||
        document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="User-Name"]');
    let authorName = '';
    if (authorElement) {
        // 取第一个 span 作为显示名
        const nameSpan = authorElement.querySelector('span');
        if (nameSpan) {
            authorName = nameSpan.textContent?.trim() || '';
        }
    }

    const draftBlocks = document.querySelectorAll('.public-DraftStyleDefault-block');
    let contentPreview = '';
    let rawContentStart = ''; // 新增：用于去重的原始文本
    let shouldSkipContentStartDedup = false;

    if (isXArticle) {
        console.log('[twitterExtractor] 📄 提取 X Article 标题...');

        const firstSegmentText = getFirstXArticleSegmentText();

        // 策略 1：优先使用页面标题 (document.title)
        let pageTitle = document.title;
        console.log(`[twitterExtractor] 📄 原始页面标题: "${pageTitle}"`);

        // 清理常用后缀和前缀
        pageTitle = pageTitle.replace(/\s*\/\s*(X|Twitter)$/i, ''); // " / X"
        pageTitle = pageTitle.replace(/\s+on\s+(X|Twitter)$/i, ''); // " on X"
        pageTitle = pageTitle.replace(/^\(\d+\+?\)\s*/, '');  // "(1) " 通知数
        pageTitle = pageTitle.trim();
        pageTitle = pageTitle.replace(/^[""]|[""]$/g, ''); // 移除首尾引号

        // 排除通用标题
        const genericTitles = ['X', 'Twitter', 'Home', 'Notification', 'Search', 'Profile'];
        if (pageTitle && !genericTitles.includes(pageTitle) && pageTitle.length > 2) {
            contentPreview = pageTitle;
            rawContentStart = pageTitle; // 假设页面标题就是正文第一行
            console.log(`[twitterExtractor] 📄 策略1-清洗后的页面标题: "${contentPreview}"`);
        }

        // 页面标题若是中英文直接拼接，优先使用正文首个真实段落作为标题
        if (firstSegmentText && pageTitle && pageTitle.includes(firstSegmentText) && pageTitle !== firstSegmentText) {
            contentPreview = firstSegmentText;
            rawContentStart = firstSegmentText;
            console.log(`[twitterExtractor] 📄 策略1b-使用首个正文子段替代拼接标题: "${contentPreview}"`);
        }

        // 策略 2：如果页面标题不可用，查找 H1 或 Heading
        if (!contentPreview) {
            const headingObj = container.querySelector('h1') || container.querySelector('[role="heading"]');
            if (headingObj) {
                const headingText = headingObj.textContent?.trim();
                if (headingText && headingText.length > 2 && !headingText.includes('Timeline')) {
                    contentPreview = headingText;
                    rawContentStart = headingText;
                    console.log(`[twitterExtractor] 📄 策略2-语义化标题: "${contentPreview}"`);
                }
            }
        }

        // 策略 3：如果还没找到，从正文区域提取
        if (!contentPreview && draftBlocks.length > 0) {
            for (let i = 0; i < Math.min(3, draftBlocks.length); i++) {
                const block = draftBlocks[i] as HTMLElement;
                const text = getFirstXArticleSegmentText() || block.innerText?.trim() || '';

                if (text && text.length > 2) {
                    contentPreview = text;
                    rawContentStart = text; // 这种情况下这一段必定是正文开头
                    console.log(`[twitterExtractor] 📄 策略3-首个正文块: "${contentPreview}"`);
                    break;
                }
            }
        }
    } else {
        // 普通推文：取第一行作为标题
        const mainTweetText = document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="tweetText"]');
        if (mainTweetText) {
            const titleSegments = splitTweetTextIntoSegments(mainTweetText as HTMLElement);
            const hasBilingualSegments =
                titleSegments.some((segment) => segment.role === 'original') &&
                titleSegments.some((segment) => segment.role === 'translation');

            const preferredTitleSegment = titleSegments.find((segment) =>
                segment.role === 'original' && segment.text.trim()
            ) || titleSegments.find((segment) => segment.role !== 'spacer' && segment.text.trim());

            const fullText = mainTweetText.textContent?.trim() || '';
            // 取第一行（优先结构化首个原文段，否则回退到 textContent）
            const firstLine = preferredTitleSegment
                ? getFirstNonEmptyLine(preferredTitleSegment.text)
                : fullText.split('\n')[0].trim();
            // 如果第一行太长，截取前 50 字用于显示
            contentPreview = firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine;
            // 单语推文才允许用首行做正文去重；双语首段如果继续去重，会误删首个原文段。
            rawContentStart = firstLine;
            shouldSkipContentStartDedup = hasBilingualSegments;

            if (contentPreview) {
                console.log(`[twitterExtractor] 📝 普通推文，使用第一行: "${contentPreview}" (raw length: ${rawContentStart.length}, bilingual=${hasBilingualSegments})`);
            }
        }
    }

    if (contentPreview) {
        if (isXArticle || shouldSkipContentStartDedup) {
            // X Article 的双语正文结构高度依赖首段顺序。
            // 这里如果继续把首段正文当成 contentStart 去重，会在后续提取链路里
            // 误删英文原文块，导致原文与译文错位。
            return { title: contentPreview };
        }
        return { title: contentPreview, contentStart: rawContentStart };
    } else if (authorName) {
        return { title: `${authorName} 的推文` };
    }

    // Fallback: 使用原始页面标题
    let title = document.title;
    title = title.replace(/^\(\d+\)\s*/, '');
    title = title.replace(/\s+on X:\s*/, ': ');
    title = title.replace(/\s*\/\s*X$/, '');
    title = title.replace(/^[""]|[""]$/g, '');
    return { title: title.trim() || '推文' };
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

    // 1. 泛化链接查找：查找任何看起来像内容链接的 href
    const potentialLinks = quoteContainer.querySelectorAll('a[href]');
    for (const link of potentialLinks) {
        const href = link.getAttribute('href');
        if (href && (
            href.includes('/status/') ||
            href.includes('/article/') ||
            href.includes('/events/') ||
            href.includes('/i/')
        )) {
            if (!href.includes('/photo/') && !href.includes('/video/') && !href.includes('/people/')) {
                fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
                break;
            }
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
                fullUrl = containerHref.startsWith('http') ? containerHref : `https://x.com${containerHref}`;
            } else if (!containerHref) {
                // 如果 wrapper 自身没 href，找它里面的第一个有效链接
                const innerLink = roleLink.querySelector('a[href*="/status/"], a[href*="/article/"]');
                if (innerLink) {
                    const href = innerLink.getAttribute('href');
                    if (href) fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
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
                if (val && (val.includes('/status/') || val.includes('/article/'))) {
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
        // 成功提取：保存到 DOM 属性和内存缓存
        if (!savedUrl) {
            quoteContainer.setAttribute('data-mowen-saved-url', fullUrl);
        }
        if (!cachedUrl) {
            quoteUrlCache.set(cacheKey, fullUrl);
            console.log(`[twitterExtractor] 📝 缓存 Quote URL: ${cacheKey} -> ${fullUrl}`);
        }
    }

    // 提取文本
    const textEl = quoteContainer.querySelector('[data-testid="tweetText"]');
    let text = '';
    let html = '';
    let segments: TweetTextSegment[] = [];

    const draftArticleSegments = extractQuoteDraftArticleSegments(quoteContainer);
    if (draftArticleSegments.length > 0) {
        segments = draftArticleSegments;
        text = segments.map((segment) => trimExtractedSegmentText(segment.text)).filter(Boolean).join('\n');
        html = renderTweetTextSegmentsToHtml(segments);
    }

    if (!text && textEl) {
        segments = splitTweetTextIntoSegments(textEl as HTMLElement);
        if (segments.length > 0) {
            text = segments.map((segment) => trimExtractedSegmentText(segment.text)).filter(Boolean).join('\n');
            html = renderTweetTextSegmentsToHtml(segments);
        } else {
            text = (textEl as HTMLElement).innerText || textEl.textContent || '';
            html = cleanTwitterHtml((textEl as HTMLElement).innerHTML);
        }
    }

    // 策略：通用文本提取 (如果找不到标准 tweetText)
    if (!text.trim()) {
        const clonedContainer = quoteContainer.cloneNode(true) as HTMLElement;
        const toRemove = clonedContainer.querySelectorAll(
            '[data-testid="User-Name"], time, [role="button"], svg, ' +
            '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"]' // 排除操作按钮
        );
        toRemove.forEach(el => el.remove());

        text = clonedContainer.innerText?.trim() || '';
        // 简单清理
        text = text.replace(/^文章\n?/gm, '').replace(/^Article\n?/gm, '').trim();
        html = `<p>${text.split('\n').join('</p><p>')}</p>`;
    }

    // 最终检查
    if (!text.trim()) {
        if (fullUrl) {
            text = `（引用推文内容请查看原文）`;
            html = text;
        } else {
            // 只要有图片，也算有效引用
            const hasImages = quoteContainer.querySelector('img');
            if (hasImages) {
                text = `（引用内容为图片）`;
                html = text;
            } else {
                // 没有URL，没有文字，没有图片 -> 放弃
                return null;
            }
        }
    }

    // 提取图片
    const images = extractQuoteTweetImages(quoteContainer);

    console.log(`[twitterExtractor] 🔍 Quote Tweet 提取结果: url=${fullUrl}, textLen=${text.length}, images=${images.length}`);

    return {
        url: fullUrl || '(未知链接)',
        linkLabel: getQuoteLinkLabel(fullUrl || '(未知链接)', text.trim()),
        segments,
        text: text.trim(),
        html,
        images,
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
function splitTweetTextIntoSegments(element: HTMLElement): TweetTextSegment[] {
    const translationPair = extractTranslationPairSegments(element);
    if (translationPair) {
        return buildInlineTranslationPairSegments(
            translationPair.original,
            translationPair.translation
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

function getFirstNonEmptyLine(text: string): string {
    return text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
}

function getQuoteLinkLabel(url: string, text: string): string {
    const candidate = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) =>
            line &&
            line !== url &&
            line !== '（引用推文内容请查看原文）' &&
            line !== '（引用内容为图片）'
        );

    if (!candidate) {
        return url;
    }

    return candidate.length > 80 ? `${candidate.substring(0, 80).trim()}...` : candidate;
}

function getParagraphLanguageKind(text: string): 'english' | 'chinese' | 'other' {
    const normalized = text.trim();
    if (!normalized) {
        return 'other';
    }

    const hanCount = countHanCharacters(normalized);
    const latinWordCount = countLatinWords(normalized);

    if (hanCount >= 2 && (latinWordCount === 0 || hanCount >= latinWordCount || hanCount >= 6)) {
        return 'chinese';
    }

    if (
        latinWordCount >= 2 &&
        (hanCount === 0 || (hanCount <= 2 && /^[^\u4e00-\u9fff]*[A-Za-z]/.test(normalized)))
    ) {
        return 'english';
    }

    return 'other';
}

function getDominantParagraphLanguageKind(segments: Array<{ html: string; text: string }>): 'english' | 'chinese' | 'other' {
    let englishCount = 0;
    let chineseCount = 0;

    for (const segment of segments) {
        const kind = getParagraphLanguageKind(segment.text);
        if (kind === 'english') {
            englishCount += 1;
        } else if (kind === 'chinese') {
            chineseCount += 1;
        }
    }

    if (englishCount === 0 && chineseCount === 0) {
        return 'other';
    }

    return englishCount >= chineseCount ? 'english' : 'chinese';
}

function isTranslatedTweetParagraphPair(
    firstSegments: TweetTextSegment[],
    secondSegments: TweetTextSegment[]
): boolean {
    if (firstSegments.length === 0 || secondSegments.length === 0) {
        return false;
    }

    if (firstSegments.length !== secondSegments.length || firstSegments.length < 3) {
        return false;
    }

    const firstLanguage = getDominantParagraphLanguageKind(firstSegments);
    const secondLanguage = getDominantParagraphLanguageKind(secondSegments);

    if (firstLanguage === secondLanguage || firstLanguage === 'other' || secondLanguage === 'other') {
        return false;
    }

    const headingLikeMatches = firstSegments.filter((segment, index) => {
        const other = secondSegments[index];
        if (!other) {
            return false;
        }

        const firstText = segment.text.trim();
        const secondText = other.text.trim();
        if (!firstText || !secondText) {
            return false;
        }

        return (
            startsWithExplicitBlockMarker(firstText) === startsWithExplicitBlockMarker(secondText) ||
            looksLikeStandaloneHeading(firstText, getXArticleSegmentLanguageKind(firstText)) ||
            looksLikeStandaloneHeading(secondText, getXArticleSegmentLanguageKind(secondText))
        );
    }).length;

    return headingLikeMatches >= Math.min(3, firstSegments.length);
}

function buildBilingualTweetParagraphSegments(
    originalSegments: TweetTextSegment[],
    translatedSegments: TweetTextSegment[]
): TweetTextSegment[] {
    const originalLanguage = getDominantParagraphLanguageKind(originalSegments);
    const translatedLanguage = getDominantParagraphLanguageKind(translatedSegments);
    const englishFirst = originalLanguage === 'english' || translatedLanguage !== 'english';
    const primarySegments = englishFirst ? originalSegments : translatedSegments;
    const secondarySegments = englishFirst ? translatedSegments : originalSegments;
    const total = Math.max(primarySegments.length, secondarySegments.length);

    const result: TweetTextSegment[] = [];

    for (let index = 0; index < total; index++) {
        const primary = primarySegments[index];
        const secondary = secondarySegments[index];

        if (!primary && !secondary) {
            continue;
        }

        if (primary) {
            result.push({
                ...primary,
                role: 'original',
                textOnly: primary.textOnly,
            });
        }

        if (secondary) {
            result.push({
                ...secondary,
                role: 'translation',
                textOnly: true,
            });
        }

        if (index < total - 1) {
            result.push(createTweetParagraphSpacerSegment());
        }
    }

    return result;
}

function countHanCharacters(text: string): number {
    return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

function countLatinWords(text: string): number {
    return (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length;
}

function splitMixedLanguageText(text: string): string[] {
    const normalizedText = text.trim();
    if (!normalizedText || countHanCharacters(normalizedText) === 0 || countLatinWords(normalizedText) === 0) {
        return normalizedText ? [normalizedText] : [];
    }

    const boundaries = findMixedLanguageSplitBoundaries(normalizedText);
    if (boundaries.length === 0) {
        return [normalizedText];
    }

    const parts: string[] = [];
    let start = 0;

    for (const boundary of boundaries) {
        const part = normalizedText.slice(start, boundary).trim();
        if (part) {
            parts.push(part);
        }
        start = boundary;
    }

    const trailingPart = normalizedText.slice(start).trim();
    if (trailingPart) {
        parts.push(trailingPart);
    }

    return parts.length > 0 ? parts : [normalizedText];
}

type XArticleSegmentLanguageKind = 'english' | 'chinese' | 'other';

function getXArticleSegmentLanguageKind(text: string): XArticleSegmentLanguageKind {
    const normalized = text.trim();
    if (!normalized) {
        return 'other';
    }

    const hanCount = countHanCharacters(normalized);
    const latinWordCount = countLatinWords(normalized);

    if (hanCount >= 2 && (latinWordCount === 0 || hanCount >= latinWordCount || hanCount >= 6)) {
        return 'chinese';
    }

    if (
        latinWordCount >= 2 &&
        (hanCount === 0 || (hanCount <= 2 && /^[^\u4e00-\u9fff]*[A-Za-z]/.test(normalized)))
    ) {
        return 'english';
    }

    return 'other';
}

function endsWithHardParagraphBoundary(text: string): boolean {
    return /[。！？!?；;:：]$/.test(text.trim());
}

function startsWithExplicitBlockMarker(text: string): boolean {
    return /^([→➜•\-–—*]|\d+\.)\s*/.test(text.trim());
}

function looksLikeStandaloneHeading(text: string, kind: XArticleSegmentLanguageKind): boolean {
    const normalized = text.trim();
    if (!normalized || endsWithHardParagraphBoundary(normalized)) {
        return false;
    }

    if (kind === 'english') {
        const words = countLatinWords(normalized);
        return words > 0 && words <= 8 && /^[A-Z0-9]/.test(normalized);
    }

    if (kind === 'chinese') {
        const hanCount = countHanCharacters(normalized);
        return hanCount > 0 && hanCount <= 10 && !/[，,]/.test(normalized);
    }

    return false;
}

function getSegmentJoiner(left: string, right: string, kind: XArticleSegmentLanguageKind): string {
    const leftTrimmed = left.trimEnd();
    const rightTrimmed = right.trimStart();
    if (!leftTrimmed || !rightTrimmed) {
        return '';
    }

    const leftLast = leftTrimmed[leftTrimmed.length - 1];
    const rightFirst = rightTrimmed[0];
    const leftIsLatin = /[A-Za-z0-9]/.test(leftLast);
    const rightIsLatin = /[A-Za-z0-9]/.test(rightFirst);
    const leftIsHan = /[\u4e00-\u9fff]/.test(leftLast);
    const rightIsHan = /[\u4e00-\u9fff]/.test(rightFirst);

    if (leftIsLatin && rightIsLatin) {
        return ' ';
    }

    if (kind === 'english' && !/\s$/.test(leftTrimmed) && !/^\s/.test(rightTrimmed)) {
        return ' ';
    }

    if (leftIsHan || rightIsHan) {
        return '';
    }

    return '';
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

        const previousKind = getXArticleSegmentLanguageKind(previous.text);
        const currentKind = getXArticleSegmentLanguageKind(currentText);
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

    return mergeXArticleContinuationSegments(refined);
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

    return textLines.map((line) => ({
        html: escapeHtml(line),
        text: line,
    }));
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
                segments = buildBilingualTweetParagraphSegments(segments, nextSegments);
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

        // 每个 segment 生成独立的 ContentBlock，并显式补回段落间空行。
        // X 的 tweetText 真实段落边界来自空行文本，而墨问里相邻 paragraph 默认间距较紧，
        // 因此这里插入一个空 paragraph 作为视觉分段，只作用于 Twitter/X 提取链路。
        segments.forEach((seg, segmentIndex) => {
            if (seg.role === 'spacer') {
                contentParts.push(TWEET_PARAGRAPH_SPACER_HTML);
                blocks.push({
                    id: generateId(),
                    type: 'paragraph',
                    html: TWEET_PARAGRAPH_SPACER_HTML,
                    text: '',
                });
                return;
            }

            if (!seg.text.trim()) return;
            contentParts.push(`<div class="tweet-text">${seg.html}</div>`);
            textParts.push(seg.text);
            blocks.push({
                id: generateId(),
                type: 'paragraph',
                html: seg.textOnly ? '' : `<p>${seg.html}</p>`,
                text: seg.text,
            });

            const nextSeg = segments[segmentIndex + 1];
            const shouldInsertSpacer =
                nextSeg &&
                nextSeg.role !== 'spacer' &&
                seg.role !== 'original' &&
                nextSeg.role !== 'translation';

            if (shouldInsertSpacer) {
                contentParts.push(TWEET_PARAGRAPH_SPACER_HTML);
                blocks.push({
                    id: generateId(),
                    type: 'paragraph',
                    html: TWEET_PARAGRAPH_SPACER_HTML,
                    text: '',
                });
            }
        });
    }

    console.log(`[twitterExtractor] 📝 主推文提取: ${mainTweetTextElements.length} 个文本块, ${textParts.length} 个有效段落`);

    // 4. 拼装引用推文（严格遵循 Link -> Quote -> Images 顺序）
    quoteTweets.forEach((qt, qtIndex) => {
        // (1) 引用链接行
        const linkLabel = escapeHtml(qt.linkLabel || qt.url);
        const linkBlock: ContentBlock = {
            id: generateId(),
            type: 'paragraph',
            html: `<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="${qt.url}">${linkLabel}</a></p>`,
            text: `🔗 引用文章：${qt.linkLabel || qt.url}`,
            layout: {
                preserveInlineParagraphs: true,
            },
        };
        blocks.push(linkBlock);
        contentParts.push(linkBlock.html);
        textParts.push(linkBlock.text);

        // (2) 引用内容
        // 仅在 X 剪藏链路内，把双语引用拆成多个独立 quote block + 空段，
        // 避免进入通用 NoteAtom 转换时丢失“原文→译文→空行”的顺序。
        appendQuoteTweetContentBlocks(blocks, contentParts, textParts, qt);

        // (3) 引用图片（独立节点，在 quote 之后）
        qt.images.forEach((img) => {
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
            blocks.push(imgBlock);
            contentParts.push(imgBlock.html);
        });

        console.log(`[twitterExtractor] 📝 Quote #${qtIndex + 1} 拼装: 图片=${qt.images.length}`);
    });

    return {
        contentHtml: contentParts.join(''),
        blocks,
        textContent: textParts.join('\n'),
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
 * 检测是否为 X Article（长文章）
 * X Article 使用 Draft.js 格式渲染，特征是包含 public-DraftStyleDefault-block 类的元素
 */
function detectXArticle(container: HTMLElement): boolean {
    // 检测 Draft.js 块元素（X Article 的主要特征）
    // X Article 页面使用 Draft.js 渲染，内容在 .public-DraftStyleDefault-block 类中
    const draftBlocks = Array.from(container.querySelectorAll('.public-DraftStyleDefault-block'));

    // 过滤掉可能是编辑器（如回复框）的块
    const validBlocks = draftBlocks.filter(block => {
        // 1. 忽略空内容的块（回复框默认是空的）
        if (!block.textContent?.trim()) return false;

        // 2. 忽略可编辑的块（这是输入框，不是发布的文章）
        // Draft.js 编辑器的容器通常有 contenteditable="true"
        if (block.getAttribute('contenteditable') === 'true') return false;
        if (block.closest('[contenteditable="true"]')) return false;
        return true;
    });

    if (validBlocks.length > 0) {
        console.log(`[twitterExtractor] 📄 检测到 ${validBlocks.length} 个有效的 Draft.js 块 (已过滤空块和编辑器)`);
        return true;
    }

    return false;
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

                    // (1) 引用链接行
                    const linkLabel = escapeHtml(quoteTweet.linkLabel || quoteTweet.url);
                    const linkBlock: ContentBlock = {
                        id: generateId(),
                        type: 'paragraph',
                        html: `<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="${quoteTweet.url}">${linkLabel}</a></p>`,
                        text: `🔗 引用文章：${quoteTweet.linkLabel || quoteTweet.url}`,
                        layout: {
                            preserveInlineParagraphs: true,
                        },
                    };
                    blocks.push(linkBlock);
                    contentParts.push(linkBlock.html);
                    textParts.push(linkBlock.text);

                    // (2) 引用内容
                    // 仅在 X 剪藏链路内按段落序列写入 quote block，避免双语错位。
                    appendQuoteTweetContentBlocks(blocks, contentParts, textParts, quoteTweet);

                    // (3) 引用图片
                    quoteTweet.images.forEach((img: ImageCandidate) => {
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
                        blocks.push(imgBlock);
                        contentParts.push(imgBlock.html);
                        images.push(img); // X Article 模式下图片统一收集
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

                        translationPairGroups.forEach((group, groupIndex) => {
                            if (group.original) {
                                appendXArticleParagraphBlock(blocks, contentParts, group.original, {
                                    groupId: group.id,
                                    role: 'original',
                                });
                            }
                            if (group.translation) {
                                appendXArticleParagraphBlock(blocks, contentParts, group.translation, {
                                    groupId: group.id,
                                    role: 'translation',
                                });
                            }
                            if (groupIndex < translationPairGroups.length - 1) {
                                appendXArticleSpacerBlock(blocks, contentParts, group.id);
                            }
                        });
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

                    paragraphSegments.forEach((segment, segmentIndex) => {
                        const groupId = generateId();
                        appendXArticleParagraphBlock(blocks, contentParts, segment, {
                            groupId,
                            role: 'normal',
                        });
                        if (segmentIndex < paragraphSegments.length - 1) {
                            appendXArticleSpacerBlock(blocks, contentParts, groupId);
                        }
                    });
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

    debugLogXArticleBlockSequence('重排前', blocks);
    const normalizedBlocks = insertXArticleSpacing(rebalanceXArticleBilingualBlocks(blocks));
    debugLogXArticleBlockSequence('重排后', normalizedBlocks);
    // 使用空字符串连接，避免产生额外的空行（空行会被 noteAtom 解析为空段落）
    const contentHtml = normalizedBlocks.map((block) => block.html).join('');
    const textContent = normalizedBlocks
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n');

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
