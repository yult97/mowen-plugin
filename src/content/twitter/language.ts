import { findMixedLanguageSplitBoundaries } from '../../utils/mixedLanguage.ts';
import type { TwitterSegmentLanguageKind } from './types.ts';

export function countHanCharacters(text: string): number {
    return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

export function countLatinWords(text: string): number {
    return (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length;
}

export function detectTwitterSegmentLanguage(text: string): TwitterSegmentLanguageKind {
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

export function getDominantTwitterLanguage<T extends { text: string }>(
    segments: T[]
): TwitterSegmentLanguageKind {
    let englishCount = 0;
    let chineseCount = 0;

    for (const segment of segments) {
        const kind = detectTwitterSegmentLanguage(segment.text);
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

export function splitMixedLanguageText(text: string): string[] {
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

export function endsWithHardParagraphBoundary(text: string): boolean {
    return /[。！？!?；;:：]$/.test(text.trim());
}

export function startsWithExplicitBlockMarker(text: string): boolean {
    return /^([→➜•\-–—*]|\d+\s*[-.:：)]|[A-Za-z]\)|[A-Za-z]\.)\s*/.test(text.trim());
}

export function looksLikeStandaloneHeading(
    text: string,
    kind: TwitterSegmentLanguageKind
): boolean {
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

export function getSegmentJoiner(
    left: string,
    right: string,
    kind: TwitterSegmentLanguageKind
): string {
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
