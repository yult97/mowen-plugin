import { createTweetParagraphSpacerSegment } from './bilingual.ts';
import {
    countHanCharacters,
    countLatinWords,
    detectTwitterSegmentLanguage,
    getDominantTwitterLanguage,
    looksLikeStandaloneHeading,
    splitMixedLanguageText,
    startsWithExplicitBlockMarker,
} from './language.ts';
import type { TwitterTextSegment } from './types.ts';

export function isTwitterCardMetadataText(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) {
        return true;
    }

    if (/^https?:\/\/\S+$/i.test(normalized)) {
        return true;
    }

    return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(normalized);
}

export function buildTwitterCardSegments(
    rowGroups: TwitterTextSegment[][],
    createId: () => string
): TwitterTextSegment[] {
    const meaningfulGroups = normalizeMixedLanguageCardRowGroups(rowGroups, createId)
        .map((group) => group.filter((segment) => {
            if (segment.role === 'spacer') {
                return false;
            }

            return !isTwitterCardMetadataText(segment.text);
        }))
        .filter((group) => group.length > 0);

    const result: TwitterTextSegment[] = [];

    for (let index = 0; index < meaningfulGroups.length; index++) {
        const group = meaningfulGroups[index];
        const nextGroup = meaningfulGroups[index + 1];

        if (group && nextGroup && shouldPairBilingualCardGroups(group, nextGroup)) {
            const groupId = createId();
            const currentLanguage = detectCardGroupLanguage(group);
            const nextLanguage = detectCardGroupLanguage(nextGroup);
            const englishFirst = currentLanguage === 'english' || nextLanguage !== 'english';
            const originalGroup = englishFirst ? group : nextGroup;
            const translationGroup = englishFirst ? nextGroup : group;

            result.push(...originalGroup.map((segment) => ({
                ...segment,
                role: 'original' as const,
                groupId,
            })));
            result.push(...translationGroup.map((segment) => ({
                ...segment,
                role: 'translation' as const,
                textOnly: true,
                groupId,
            })));

            if (index < meaningfulGroups.length - 2) {
                result.push(createTweetParagraphSpacerSegment(groupId));
            }

            index += 1;
            continue;
        }

        result.push(...group.map((segment) => ({
            ...segment,
            role: segment.role ?? 'normal',
        })));

        if (index < meaningfulGroups.length - 1) {
            const spacerGroupId = group.find((segment) => Boolean(segment.groupId))?.groupId || createId();
            result.push(createTweetParagraphSpacerSegment(spacerGroupId));
        }
    }

    return result;
}

function normalizeMixedLanguageCardRowGroups(
    rowGroups: TwitterTextSegment[][],
    createId: () => string
): TwitterTextSegment[][] {
    return rowGroups.map((group) => splitSingleSegmentMixedLanguageCardGroup(group, createId));
}

function splitSingleSegmentMixedLanguageCardGroup(
    group: TwitterTextSegment[],
    createId: () => string
): TwitterTextSegment[] {
    if (group.length !== 1) {
        return group;
    }

    const [segment] = group;
    if (!segment || (segment.role && segment.role !== 'normal')) {
        return group;
    }

    const trimmedText = segment.text.trim();
    const trimmedHtml = segment.html.trim();
    if (!trimmedText || !trimmedHtml || /<[^>]+>/.test(trimmedHtml)) {
        return group;
    }

    const parts = splitMixedLanguageText(trimmedText);
    if (parts.length !== 2) {
        return group;
    }

    const partLanguages = parts.map((part) => detectTwitterSegmentLanguage(part));
    if (
        partLanguages[0] === 'other' ||
        partLanguages[1] === 'other' ||
        partLanguages[0] === partLanguages[1]
    ) {
        return group;
    }

    const englishIndex = partLanguages[0] === 'english' ? 0 : 1;
    const chineseIndex = englishIndex === 0 ? 1 : 0;
    const groupId = createId();

    return [
        {
            ...segment,
            html: escapeCardSegmentHtml(parts[englishIndex]),
            text: parts[englishIndex],
            role: 'original',
            groupId,
        },
        {
            ...segment,
            html: escapeCardSegmentHtml(parts[chineseIndex]),
            text: parts[chineseIndex],
            role: 'translation',
            textOnly: true,
            groupId,
        },
    ];
}

function escapeCardSegmentHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function shouldPairBilingualCardGroups(
    currentGroup: TwitterTextSegment[],
    nextGroup: TwitterTextSegment[]
): boolean {
    if (
        currentGroup.some((segment) => segment.role === 'original' || segment.role === 'translation') ||
        nextGroup.some((segment) => segment.role === 'original' || segment.role === 'translation')
    ) {
        return false;
    }

    const currentLanguage = detectCardGroupLanguage(currentGroup);
    const nextLanguage = detectCardGroupLanguage(nextGroup);
    if (
        currentLanguage === 'other' ||
        nextLanguage === 'other' ||
        currentLanguage === nextLanguage
    ) {
        return false;
    }

    const currentText = currentGroup.map((segment) => segment.text.trim()).filter(Boolean).join(' ');
    const nextText = nextGroup.map((segment) => segment.text.trim()).filter(Boolean).join(' ');
    if (!currentText || !nextText) {
        return false;
    }

    const currentHasMarker = startsWithExplicitBlockMarker(currentText);
    const nextHasMarker = startsWithExplicitBlockMarker(nextText);
    if (currentHasMarker !== nextHasMarker) {
        return false;
    }

    const currentHeading = looksLikeStandaloneHeading(currentText, currentLanguage);
    const nextHeading = looksLikeStandaloneHeading(nextText, nextLanguage);
    if (!currentHasMarker && !nextHasMarker && currentHeading !== nextHeading && (currentHeading || nextHeading)) {
        return false;
    }

    if (Math.abs(currentGroup.length - nextGroup.length) > 1) {
        return false;
    }

    const currentLength = currentText.replace(/\s+/g, '').length;
    const nextLength = nextText.replace(/\s+/g, '').length;
    const longer = Math.max(currentLength, nextLength);
    const shorter = Math.min(currentLength, nextLength);

    return longer > 0 && shorter / longer >= 0.2;
}

function detectCardGroupLanguage(group: TwitterTextSegment[]): 'english' | 'chinese' | 'other' {
    const dominantLanguage = getDominantTwitterLanguage(group);
    if (dominantLanguage !== 'other') {
        return dominantLanguage;
    }

    const combinedText = group.map((segment) => segment.text.trim()).filter(Boolean).join(' ');
    if (!combinedText) {
        return 'other';
    }

    if (countHanCharacters(combinedText) >= 1) {
        return 'chinese';
    }

    if (countLatinWords(combinedText) >= 1) {
        return 'english';
    }

    return 'other';
}
