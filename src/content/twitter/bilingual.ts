import type { TwitterTextSegment } from './types.ts';
import {
    detectTwitterSegmentLanguage,
    getDominantTwitterLanguage,
    looksLikeStandaloneHeading,
    startsWithExplicitBlockMarker,
} from './language.ts';

export const TWEET_PARAGRAPH_SPACER_HTML = '<p data-mowen-preserve-inline-paragraph="1"><br></p>';

export interface BilingualParagraphSegment {
    html: string;
    text: string;
}

export interface BilingualAlignmentOptions {
    allowReferenceDrivenSplit?: boolean;
}

export interface StructuredSequenceAdapter<T> {
    clone: (item: T, groupId?: string) => T;
    createSpacer: (groupId?: string) => T;
    getGroupId: (item: T) => string | undefined;
    getRole: (item: T) => TwitterTextSegment['role'];
    hasText: (item: T) => boolean;
    isSpacer: (item: T) => boolean;
}

export function createTweetParagraphSpacerSegment(groupId?: string): TwitterTextSegment {
    return {
        html: TWEET_PARAGRAPH_SPACER_HTML,
        text: '',
        role: 'spacer',
        groupId,
    };
}

export function isStructuredTwitterSegment(segment: TwitterTextSegment): boolean {
    return Boolean(
        segment.groupId ||
        segment.role === 'original' ||
        segment.role === 'translation' ||
        segment.role === 'spacer'
    );
}

function findNextNonSpacerIndex<T>(
    items: T[],
    startIndex: number,
    adapter: StructuredSequenceAdapter<T>
): number {
    for (let index = startIndex; index < items.length; index++) {
        if (!adapter.isSpacer(items[index])) {
            return index;
        }
    }

    return -1;
}

function shouldKeepStructuredSpacer<T>(
    previous: T | undefined,
    next: T | undefined,
    adapter: StructuredSequenceAdapter<T>
): boolean {
    if (!previous || !next || !adapter.hasText(previous) || !adapter.hasText(next)) {
        return false;
    }

    const previousGroupId = adapter.getGroupId(previous);
    const nextGroupId = adapter.getGroupId(next);
    const isBilingualPair =
        Boolean(previousGroupId) &&
        previousGroupId === nextGroupId &&
        adapter.getRole(previous) === 'original' &&
        adapter.getRole(next) === 'translation';

    return !isBilingualPair;
}

export function normalizeStructuredSequence<T>(
    items: T[],
    adapter: StructuredSequenceAdapter<T>
): T[] {
    const hasStructuredItems = items.some((item) => {
        const role = adapter.getRole(item);
        return Boolean(
            adapter.getGroupId(item) ||
            role === 'original' ||
            role === 'translation' ||
            role === 'spacer'
        );
    });
    if (!hasStructuredItems) {
        return items;
    }

    const result: T[] = [];

    for (let index = 0; index < items.length; index++) {
        const current = items[index];

        if (adapter.isSpacer(current)) {
            const previous = result[result.length - 1];
            const nextIndex = findNextNonSpacerIndex(items, index + 1, adapter);
            const next = nextIndex >= 0 ? items[nextIndex] : undefined;

            if (shouldKeepStructuredSpacer(previous, next, adapter)) {
                result.push(adapter.clone(current, adapter.getGroupId(current) || (previous ? adapter.getGroupId(previous) : undefined)));
            }
            continue;
        }

        result.push(adapter.clone(current));

        const nextIndex = findNextNonSpacerIndex(items, index + 1, adapter);
        const next = nextIndex >= 0 ? items[nextIndex] : undefined;
        if (!shouldKeepStructuredSpacer(current, next, adapter)) {
            continue;
        }

        const hasExplicitSpacerAhead = nextIndex > index + 1;
        if (!hasExplicitSpacerAhead) {
            result.push(adapter.createSpacer(adapter.getGroupId(current)));
        }
    }

    return result;
}

export function isTranslatedTweetParagraphPair(
    firstSegments: TwitterTextSegment[],
    secondSegments: TwitterTextSegment[]
): boolean {
    if (firstSegments.length === 0 || secondSegments.length === 0) {
        return false;
    }

    if (firstSegments.length !== secondSegments.length || firstSegments.length < 3) {
        return false;
    }

    const firstLanguage = getDominantTwitterLanguage(firstSegments);
    const secondLanguage = getDominantTwitterLanguage(secondSegments);

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
            looksLikeStandaloneHeading(firstText, detectTwitterSegmentLanguage(firstText)) ||
            looksLikeStandaloneHeading(secondText, detectTwitterSegmentLanguage(secondText))
        );
    }).length;

    return headingLikeMatches >= Math.min(3, firstSegments.length);
}

export function buildBilingualTweetParagraphSegments(
    originalSegments: TwitterTextSegment[],
    translatedSegments: TwitterTextSegment[],
    createId: () => string
): TwitterTextSegment[] {
    const originalLanguage = getDominantTwitterLanguage(originalSegments);
    const translatedLanguage = getDominantTwitterLanguage(translatedSegments);
    const englishFirst = originalLanguage === 'english' || translatedLanguage !== 'english';
    const primarySegments = englishFirst ? originalSegments : translatedSegments;
    const secondarySegments = englishFirst ? translatedSegments : originalSegments;
    const total = Math.max(primarySegments.length, secondarySegments.length);

    const result: TwitterTextSegment[] = [];

    for (let index = 0; index < total; index++) {
        const groupId = createId();
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
                groupId,
            });
        }

        if (secondary) {
            result.push({
                ...secondary,
                role: 'translation',
                textOnly: true,
                groupId,
            });
        }

        if (index < total - 1) {
            result.push(createTweetParagraphSpacerSegment(groupId));
        }
    }

    return result;
}

function escapeSegmentHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getSegmentWeight(text: string): number {
    const normalized = text.replace(/\s+/g, '');
    return normalized.length > 0 ? normalized.length : text.trim().length;
}

function mergeBilingualParagraphSegments(
    segments: BilingualParagraphSegment[]
): BilingualParagraphSegment | null {
    const trimmedSegments = segments
        .map((segment) => ({
            html: segment.html.trim(),
            text: segment.text.trim(),
        }))
        .filter((segment) => segment.html && segment.text);

    if (trimmedSegments.length === 0) {
        return null;
    }

    return {
        html: trimmedSegments.map((segment) => segment.html).join('<br><br>'),
        text: trimmedSegments.map((segment) => segment.text).join('\n\n'),
    };
}

function findSplitBoundary(
    text: string,
    start: number,
    target: number,
    remainingParts: number
): number {
    const min = start + 1;
    const max = text.length - Math.max(remainingParts, 1);
    if (min >= max) {
        return target;
    }

    const clampedTarget = Math.min(Math.max(target, min), max);
    const searchRadius = Math.max(6, Math.min(28, Math.floor(text.length * 0.12)));
    const searchStart = Math.max(min, clampedTarget - searchRadius);
    const searchEnd = Math.min(max, clampedTarget + searchRadius);

    const boundaryPatterns = [
        /\n+/g,
        /[。！？!?；;:：]\s*/g,
        /[,，]\s*/g,
        /\s+/g,
    ];

    let bestBoundary = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const pattern of boundaryPatterns) {
        const window = text.slice(searchStart, searchEnd);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(window)) !== null) {
            const boundary = searchStart + match.index + match[0].length;
            if (boundary <= min || boundary >= max) {
                continue;
            }

            const distance = Math.abs(boundary - clampedTarget);
            if (distance < bestDistance) {
                bestBoundary = boundary;
                bestDistance = distance;
            }
        }

        if (bestBoundary >= 0) {
            return bestBoundary;
        }
    }

    return clampedTarget;
}

function splitSingleParagraphSegmentByReferences(
    segment: BilingualParagraphSegment,
    references: BilingualParagraphSegment[]
): BilingualParagraphSegment[] {
    const normalizedText = segment.text.trim();
    const referenceWeights = references.map((reference) => getSegmentWeight(reference.text));
    const totalReferenceWeight = referenceWeights.reduce((sum, weight) => sum + weight, 0);

    if (!normalizedText || references.length <= 1 || totalReferenceWeight <= 0) {
        return [segment];
    }

    if (/<(a|strong|em|code)\b/i.test(segment.html)) {
        return [segment];
    }

    const parts: BilingualParagraphSegment[] = [];
    let start = 0;
    let consumedWeight = 0;

    for (let index = 0; index < references.length; index++) {
        if (index === references.length - 1) {
            const trailingText = normalizedText.slice(start).trim();
            if (!trailingText) {
                return [segment];
            }

            parts.push({
                html: escapeSegmentHtml(trailingText),
                text: trailingText,
            });
            continue;
        }

        consumedWeight += referenceWeights[index];
        const approximateBoundary = Math.round((normalizedText.length * consumedWeight) / totalReferenceWeight);
        const boundary = findSplitBoundary(
            normalizedText,
            start,
            approximateBoundary,
            references.length - index - 1
        );
        const partText = normalizedText.slice(start, boundary).trim();
        if (!partText) {
            return [segment];
        }

        parts.push({
            html: escapeSegmentHtml(partText),
            text: partText,
        });
        start = boundary;
    }

    return parts.length === references.length ? parts : [segment];
}

function splitSingleParagraphSegmentByExplicitBreaks(
    segment: BilingualParagraphSegment
): BilingualParagraphSegment[] {
    const normalizedText = segment.text
        .replace(/\r\n?/g, '\n')
        .trim();

    if (!normalizedText) {
        return [segment];
    }

    if (/<(a|strong|em|code)\b/i.test(segment.html)) {
        return [segment];
    }

    const paragraphs = normalizedText
        .split(/\n\s*\n+/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);

    if (paragraphs.length <= 1) {
        return [segment];
    }

    return paragraphs.map((paragraph) => ({
        html: escapeSegmentHtml(paragraph),
        text: paragraph,
    }));
}

export function alignBilingualSegmentRuns(
    originalSegments: BilingualParagraphSegment[],
    translationSegments: BilingualParagraphSegment[],
    options: BilingualAlignmentOptions = {}
): {
    originalSegments: BilingualParagraphSegment[];
    translationSegments: BilingualParagraphSegment[];
} {
    const { allowReferenceDrivenSplit = true } = options;

    if (originalSegments.length === 0 || translationSegments.length === 0) {
        return { originalSegments, translationSegments };
    }

    if (originalSegments.length === translationSegments.length) {
        return { originalSegments, translationSegments };
    }

    if (originalSegments.length > 1 && translationSegments.length === 1) {
        const explicitSplitTranslation = splitSingleParagraphSegmentByExplicitBreaks(
            translationSegments[0],
        );
        if (explicitSplitTranslation.length === originalSegments.length) {
            return {
                originalSegments,
                translationSegments: explicitSplitTranslation,
            };
        }

        if (allowReferenceDrivenSplit) {
            const splitTranslation = splitSingleParagraphSegmentByReferences(
                translationSegments[0],
                originalSegments
            );
            if (splitTranslation.length === originalSegments.length) {
                return {
                    originalSegments,
                    translationSegments: splitTranslation,
                };
            }
        }
    }

    if (translationSegments.length > 1 && originalSegments.length === 1) {
        const explicitSplitOriginal = splitSingleParagraphSegmentByExplicitBreaks(
            originalSegments[0],
        );
        if (explicitSplitOriginal.length === translationSegments.length) {
            return {
                originalSegments: explicitSplitOriginal,
                translationSegments,
            };
        }

        if (allowReferenceDrivenSplit) {
            const splitOriginal = splitSingleParagraphSegmentByReferences(
                originalSegments[0],
                translationSegments
            );
            if (splitOriginal.length === translationSegments.length) {
                return {
                    originalSegments: splitOriginal,
                    translationSegments,
                };
            }
        }
    }

    const mergedOriginal = mergeBilingualParagraphSegments(originalSegments);
    const mergedTranslation = mergeBilingualParagraphSegments(translationSegments);
    if (!mergedOriginal || !mergedTranslation) {
        return { originalSegments, translationSegments };
    }

    return {
        originalSegments: [mergedOriginal],
        translationSegments: [mergedTranslation],
    };
}
