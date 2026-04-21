import type { ContentBlock, ExtractResult } from '../../types';

export interface TwitterRuntimeReadinessSnapshot {
  articleCount: number;
  hasHydratedTweetText: boolean;
  tweetTextCount: number;
  tweetTextLength: number;
}

function hasMeaningfulExtractBlocks(blocks: ContentBlock[] | undefined): boolean {
  return Array.isArray(blocks) && blocks.some((block) =>
    block.type !== 'image' && block.text.trim().length > 0
  );
}

export function getTwitterRuntimeReadinessSnapshot(doc: Document = document): TwitterRuntimeReadinessSnapshot {
  const tweetTexts = Array.from(doc.querySelectorAll('[data-testid="tweetText"]'))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const primaryTweetText = tweetTexts[0];
  const tweetTextLength = (primaryTweetText?.innerText || primaryTweetText?.textContent || '').trim().length;

  return {
    articleCount: doc.querySelectorAll('article[data-testid="tweet"]').length,
    hasHydratedTweetText: tweetTextLength >= 80,
    tweetTextCount: tweetTexts.length,
    tweetTextLength,
  };
}

export function shouldReuseTwitterCachedResult(
  result: ExtractResult,
  snapshot: TwitterRuntimeReadinessSnapshot
): boolean {
  if (!snapshot.hasHydratedTweetText) {
    return true;
  }

  if (hasMeaningfulExtractBlocks(result.blocks)) {
    return true;
  }

  if (result.wordCount >= Math.min(120, Math.floor(snapshot.tweetTextLength * 0.6))) {
    return true;
  }

  return false;
}
