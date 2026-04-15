import type { ContentBlock } from '../../types';
import { generateId } from '../../utils/helpers';
import { normalizeStructuredSequence, TWEET_PARAGRAPH_SPACER_HTML } from './bilingual';

export function createStructuredTwitterSpacerBlock(groupId?: string): ContentBlock {
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

export function isStructuredTwitterTextBlock(block: ContentBlock): boolean {
  return (
    (block.type === 'paragraph' || block.type === 'quote') &&
    block.layout?.preserveInlineParagraphs === true &&
    block.layout.role !== 'spacer' &&
    Boolean(block.text.trim())
  );
}

export function isStructuredTwitterSpacerBlock(block: ContentBlock): boolean {
  return (
    block.type === 'paragraph' &&
    block.layout?.preserveInlineParagraphs === true &&
    block.layout.role === 'spacer'
  );
}

export function normalizeStructuredTwitterBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return normalizeStructuredSequence(blocks, {
    clone: (block, groupId) => ({
      ...block,
      layout: block.layout
        ? { ...block.layout, ...(groupId ? { groupId } : {}) }
        : block.layout,
    }),
    createSpacer: createStructuredTwitterSpacerBlock,
    getGroupId: (block) => block.layout?.groupId,
    getRole: (block) => block.layout?.role,
    hasText: isStructuredTwitterTextBlock,
    isSpacer: isStructuredTwitterSpacerBlock,
  });
}
