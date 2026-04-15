import type { TwitterClipKind, TwitterTextSegment } from './types.ts';
import { normalizeTwitterTitleCandidate } from './title.ts';

export interface TwitterContentClassification {
    isXArticle: boolean;
    kind: TwitterClipKind;
    looksLikeLongformTweet: boolean;
}

export function detectDraftXArticle(container: HTMLElement): boolean {
    const draftBlocks = Array.from(container.querySelectorAll('.public-DraftStyleDefault-block'));

    const validBlocks = draftBlocks.filter((block) => {
        if (!block.textContent?.trim()) {
            return false;
        }

        if (block.getAttribute('contenteditable') === 'true') {
            return false;
        }

        if (block.closest('[contenteditable="true"]')) {
            return false;
        }

        return true;
    });

    if (validBlocks.length > 0) {
        console.log(`[twitterExtractor] 📄 检测到 ${validBlocks.length} 个有效的 Draft.js 块 (已过滤空块和编辑器)`);
        return true;
    }

    return false;
}

function hasBilingualStructure(segments: TwitterTextSegment[]): boolean {
    return segments.some((segment) => segment.role === 'original')
        && segments.some((segment) => segment.role === 'translation');
}

export function classifyTwitterContentShape(options: {
    hasDraftArticle: boolean;
    fullText: string;
    segments: TwitterTextSegment[];
}): TwitterContentClassification {
    const { hasDraftArticle, fullText, segments } = options;
    const normalizedText = fullText.trim();

    if (hasDraftArticle) {
        return {
            isXArticle: true,
            looksLikeLongformTweet: false,
            kind: 'x-article',
        };
    }

    if (!normalizedText) {
        return {
            isXArticle: false,
            looksLikeLongformTweet: false,
            kind: 'tweet',
        };
    }

    const looksLikeLongform = looksLikeLongformTweetText(normalizedText, segments);

    return {
        isXArticle: false,
        looksLikeLongformTweet: looksLikeLongform,
        kind: looksLikeLongform ? 'tweet-longform' : 'tweet',
    };
}

function looksLikeLongformTweetText(
    fullText: string,
    segments: TwitterTextSegment[]
): boolean {
    if (!fullText) {
        return false;
    }

    const contentSegments = segments.filter((segment) => segment.role !== 'spacer' && segment.text.trim());
    const substantialSegments = contentSegments.filter((segment) =>
        normalizeTwitterTitleCandidate(segment.text).length >= 40
    );
    const paragraphCount = fullText
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .length;

    return paragraphCount >= 4 &&
        substantialSegments.length >= 4 &&
        (hasBilingualStructure(segments) || fullText.length >= 500 || substantialSegments.length >= 6);
}

export function classifyTwitterContent(options: {
    container: HTMLElement;
    primaryTweetText: HTMLElement | null;
    primarySegments?: TwitterTextSegment[];
}): TwitterContentClassification {
    const { container, primaryTweetText, primarySegments = [] } = options;
    const isXArticle = detectDraftXArticle(container);
    const fullText = (primaryTweetText?.innerText || primaryTweetText?.textContent || '').trim();
    return classifyTwitterContentShape({
        hasDraftArticle: isXArticle,
        fullText,
        segments: primarySegments,
    });
}
