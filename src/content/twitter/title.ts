import { findMixedLanguageSplitBoundaries } from '../../utils/mixedLanguage.ts';
import { detectTwitterSegmentLanguage } from './language.ts';
import type { TwitterClipKind, TwitterTextSegment } from './types.ts';

export interface TwitterTitleResult {
    contentStart?: string;
    title: string;
}

function cleanTwitterPageTitle(title: string): string {
    return title
        .replace(/\s*\/\s*(X|Twitter)$/i, '')
        .replace(/\s+on\s+(X|Twitter)$/i, '')
        .replace(/^\(\d+\+?\)\s*/, '')
        .replace(/^[""]|[""]$/g, '')
        .trim();
}

export function getFirstNonEmptyLine(text: string): string {
    return text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
}

export function normalizeTwitterTitleCandidate(text: string): string {
    return text
        .replace(/^\s+|\s+$/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isHanCharacter(char: string): boolean {
    return /[\u4e00-\u9fff]/.test(char);
}

function isLatinCharacter(char: string): boolean {
    return /[A-Za-z]/.test(char);
}

function isMixedScriptTitle(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text) && /[A-Za-z]/.test(text);
}

function extractLeadingSingleScriptSegment(text: string): string {
    const normalized = normalizeTwitterTitleCandidate(text);
    if (!normalized) {
        return '';
    }

    const firstHanIndex = normalized.search(/[\u4e00-\u9fff]/);
    const firstLatinIndex = normalized.search(/[A-Za-z]/);
    const scriptIndexes = [firstHanIndex, firstLatinIndex].filter((index) => index >= 0);
    if (scriptIndexes.length === 0) {
        return normalized;
    }

    const startIndex = Math.min(...scriptIndexes);
    const targetScript: 'han' | 'latin' =
        firstHanIndex >= 0 && firstHanIndex === startIndex ? 'han' : 'latin';
    let collected = '';

    for (let index = startIndex; index < normalized.length; index++) {
        const char = normalized[index];
        const isHan = isHanCharacter(char);
        const isLatin = isLatinCharacter(char);

        if (targetScript === 'han' && isLatin) {
            break;
        }

        if (targetScript === 'latin' && isHan) {
            break;
        }

        collected += char;
    }

    const cleaned = normalizeTwitterTitleCandidate(collected);
    if (!cleaned) {
        return '';
    }

    return targetScript === 'latin'
        ? cleaned.replace(/[\s\-–—:：|/.,;!?]+$/g, '').trim() || cleaned
        : cleaned.replace(/[\s\-–—:：|/]+$/g, '').trim() || cleaned;
}

function pickSingleLanguageTitle(text: string): string {
    const normalized = normalizeTwitterTitleCandidate(text);
    if (!normalized) {
        return '';
    }

    if (!isMixedScriptTitle(normalized)) {
        return normalized;
    }

    const boundaries = findMixedLanguageSplitBoundaries(normalized);
    if (boundaries.length > 0) {
        const leadingSegment = normalized.slice(0, boundaries[0]).trim();
        if (leadingSegment && !isMixedScriptTitle(leadingSegment)) {
            return leadingSegment;
        }
    }

    return extractLeadingSingleScriptSegment(normalized) || normalized;
}

export function truncateTwitterTitle(text: string, maxLength: number = 30): string {
    const normalized = pickSingleLanguageTitle(text);
    if (!normalized || normalized.length <= maxLength) {
        return normalized;
    }

    const kind = detectTwitterSegmentLanguage(normalized);
    const ellipsis = '...';
    const hardLimit = Math.max(1, maxLength - ellipsis.length);

    if (kind === 'english') {
        const sliced = normalized.slice(0, hardLimit);
        const wordBoundary = sliced.lastIndexOf(' ');
        const base = wordBoundary >= Math.floor(hardLimit * 0.6)
            ? sliced.slice(0, wordBoundary)
            : sliced;

        return `${base.trim()}${ellipsis}`;
    }

    return `${normalized.slice(0, hardLimit).trim()}${ellipsis}`;
}

export function getPreferredTwitterTitleText(options: {
    orderedOriginalText?: string;
    segments?: TwitterTextSegment[];
    fullText?: string;
}): string {
    const { orderedOriginalText, segments = [], fullText = '' } = options;

    if (orderedOriginalText) {
        return normalizeTwitterTitleCandidate(getFirstNonEmptyLine(orderedOriginalText));
    }

    const englishOriginal = segments.find((segment) =>
        segment.role !== 'spacer' &&
        detectTwitterSegmentLanguage(segment.text) === 'english' &&
        segment.text.trim()
    );
    if (englishOriginal?.text) {
        return normalizeTwitterTitleCandidate(getFirstNonEmptyLine(englishOriginal.text));
    }

    const firstSegment = segments.find((segment) => segment.role !== 'spacer' && segment.text.trim());
    if (firstSegment?.text) {
        return normalizeTwitterTitleCandidate(getFirstNonEmptyLine(firstSegment.text));
    }

    return normalizeTwitterTitleCandidate(fullText.split('\n')[0] || '');
}

export function deriveTwitterTitle(options: {
    authorName?: string;
    clipKind: TwitterClipKind;
    documentTitle: string;
    draftBlockTexts?: string[];
    firstXArticleSegmentText?: string;
    headingText?: string;
    orderedOriginalText?: string;
    primarySegments?: TwitterTextSegment[];
    primaryTweetText?: string;
}): TwitterTitleResult {
    const {
        authorName,
        clipKind,
        documentTitle,
        draftBlockTexts = [],
        firstXArticleSegmentText,
        headingText,
        orderedOriginalText,
        primarySegments = [],
        primaryTweetText = '',
    } = options;

    if (clipKind === 'x-article') {
        const cleanedPageTitle = cleanTwitterPageTitle(documentTitle);
        const genericTitles = ['X', 'Twitter', 'Home', 'Notification', 'Search', 'Profile'];

        const articleCandidates = [
            firstXArticleSegmentText,
            cleanedPageTitle && !genericTitles.includes(cleanedPageTitle) && cleanedPageTitle.length > 2
                ? cleanedPageTitle
                : '',
            headingText && !headingText.includes('Timeline') ? headingText : '',
            ...draftBlockTexts,
        ]
            .map((candidate) => normalizeTwitterTitleCandidate(candidate || ''))
            .filter(Boolean);

        if (articleCandidates.length > 0) {
            return {
                title: truncateTwitterTitle(articleCandidates[0], 30),
            };
        }
    }

    const preferredTweetTitle = getPreferredTwitterTitleText({
        orderedOriginalText,
        segments: primarySegments,
        fullText: primaryTweetText,
    });
    const rawContentStart = preferredTweetTitle || normalizeTwitterTitleCandidate(primaryTweetText.split('\n')[0] || '');
    const contentPreview = truncateTwitterTitle(rawContentStart, 30);

    if (contentPreview) {
        return { title: contentPreview };
    }

    if (authorName) {
        const fallbackAuthorTitle = `${authorName} 的推文`;
        return {
            title: clipKind === 'x-article'
                ? truncateTwitterTitle(fallbackAuthorTitle, 30)
                : fallbackAuthorTitle,
        };
    }

    const normalizedFallbackTitle = cleanTwitterPageTitle(documentTitle) || '推文';
    return {
        title: clipKind === 'x-article'
            ? truncateTwitterTitle(normalizedFallbackTitle, 30)
            : normalizedFallbackTitle,
    };
}
