import {
  ClipKind,
  ContentBlock,
  CreateNoteRequest,
} from '../types';
import {
  createVisibleTwitterSpacerNode,
  NoteAtomDoc,
  NoteAtomNode,
  NoteBlockEntry,
  cloneNoteAtomNode,
  createTwitterPrefixSections,
  isBlankParagraphNode,
  isVisibleTwitterSpacerNode,
  joinNoteBlockSectionsWithSingleSpacer,
  normalizeTwitterHtmlContent,
  normalizeTwitterNoteEntries,
  prepareTwitterLongformNotePlan,
  resolveTwitterSaveTitle,
} from '../twitterClip/notePlan';
import { htmlToNoteAtom } from '../utils/noteAtom';
import { stabilizeLatinHanLineBreaks } from '../utils/mixedLanguage';

type TwitterClipKind = Exclude<ClipKind, 'default'>;

export function planTwitterSaveRequests(params: {
  clipKind: TwitterClipKind;
  title: string;
  sourceUrl: string;
  content: string;
  limit: number;
  blocks?: ContentBlock[];
}): CreateNoteRequest[] {
  const { clipKind, title, sourceUrl, content, limit, blocks } = params;
  const contentEntries = blocks && blocks.length > 0
    ? convertExtractBlocksToNoteBlocks(blocks)
    : noteBlocksFromHtml(content);
  return planTwitterSaveRequestsFromEntries({
    clipKind,
    title,
    sourceUrl,
    content,
    limit,
    contentEntries,
  });
}

export function planTwitterSaveRequestsFromEntries(params: {
  clipKind: TwitterClipKind;
  title: string;
  sourceUrl: string;
  content: string;
  limit: number;
  contentEntries: NoteBlockEntry[];
  buildMultipartBody?: (
    title: string,
    sourceUrl: string,
    contentBlocks: NoteAtomNode[]
  ) => NoteAtomDoc;
}): CreateNoteRequest[] {
  const {
    clipKind,
    title,
    sourceUrl,
    content,
    limit,
    contentEntries,
    buildMultipartBody = buildTwitterMultipartBody,
  } = params;
  const normalizedTitle = resolveTwitterSaveTitle(title, contentEntries, content) || '推文';
  const normalizedContentEntries = normalizeTwitterNoteEntries(contentEntries);
  const normalizedContent = normalizeTwitterHtmlContent(content);

  if (clipKind === 'x-longform') {
    return prepareTwitterLongformNotePlan({
      title: normalizedTitle,
      sourceUrl,
      content: normalizedContent,
      entries: normalizedContentEntries,
      limit,
      singleNoteCreateMode: 'body',
    });
  }

  const totalTextLength = normalizedContentEntries.reduce((sum, entry) => sum + getEntryTextLength(entry), 0);

  if (totalTextLength <= limit) {
    return [{
      createMode: 'body',
      index: 0,
      total: 1,
      title: normalizedTitle,
      body: buildMultipartBody(normalizedTitle, sourceUrl, normalizedContentEntries.map((entry) => entry.node)),
    }];
  }

  const splitEntries = normalizedContentEntries.flatMap((entry) => splitOversizedEntry(entry, limit));
  const groupedEntries = groupEntriesByLimit(splitEntries, limit);

  return groupedEntries.map((group, index) => {
    const partTitle = index === 0 ? normalizedTitle : `${normalizedTitle} (${index + 1})`;
    return {
      createMode: 'body' as const,
      index,
      total: groupedEntries.length,
      title: partTitle,
      body: buildMultipartBody(partTitle, sourceUrl, group.map((entry) => entry.node)),
    };
  });
}

function noteBlocksFromHtml(content: string): NoteBlockEntry[] {
  const body = htmlToNoteAtom(content) as unknown as NoteAtomDoc;
  const blocks = Array.isArray(body.content) ? body.content : [];
  return blocks.map((block) => ({ node: cloneNoteAtomNode(block) }));
}

function convertExtractBlocksToNoteBlocks(blocks: ContentBlock[]): NoteBlockEntry[] {
  const noteBlocks: NoteBlockEntry[] = [];

  for (const block of blocks) {
    if (block.layout?.preserveInlineParagraphs === true && block.layout?.role === 'spacer') {
      noteBlocks.push({
        node: {
          type: 'paragraph',
          content: [],
        },
        groupId: block.layout?.groupId,
      });
      continue;
    }

    const atom = htmlToNoteAtom(block.html, {
      preserveInlineParagraphs: block.layout?.preserveInlineParagraphs === true,
    }) as unknown as NoteAtomDoc;
    const atomBlocks = Array.isArray(atom.content) ? atom.content : [];

    if (atomBlocks.length > 0) {
      noteBlocks.push(...atomBlocks.map((node) => ({
        node: cloneNoteAtomNode(node),
        groupId: block.layout?.groupId,
      })));
      continue;
    }

    const text = block.text?.trim();
    if (!text) {
      continue;
    }

    noteBlocks.push({
      node: {
        type: block.type === 'quote' ? 'quote' : 'paragraph',
        content: [{ type: 'text', text: stabilizeLatinHanLineBreaks(text) }],
      },
      groupId: block.layout?.groupId,
    });
  }

  return noteBlocks;
}

function buildTwitterMultipartBody(
  title: string,
  sourceUrl: string,
  contentBlocks: NoteAtomNode[]
): NoteAtomDoc {
  const mergedContent = joinNoteBlockSectionsWithSingleSpacer([
    ...createTwitterPrefixSections(title, sourceUrl),
    contentBlocks.map((block) => cloneNoteAtomNode(block)),
  ]);

  return {
    type: 'doc',
    content: stabilizeTwitterLinkParagraphSpacing(mergedContent),
  };
}

function isLinkOnlyParagraphNode(node: NoteAtomNode | undefined): boolean {
  if (!node || node.type !== 'paragraph' || !Array.isArray(node.content) || node.content.length === 0) {
    return false;
  }

  let hasLinkedText = false;

  for (const child of node.content) {
    const text = typeof child.text === 'string' ? child.text : '';
    if (!text.trim()) {
      continue;
    }

    const hasLinkMark = Array.isArray(child.marks) && child.marks.some((mark) => mark.type === 'link');
    if (!hasLinkMark) {
      return false;
    }

    hasLinkedText = true;
  }

  return hasLinkedText;
}

function stabilizeTwitterLinkParagraphSpacing(blocks: NoteAtomNode[]): NoteAtomNode[] {
  const normalizedBlocks = blocks.map((block) => cloneNoteAtomNode(block));

  for (let index = 0; index < normalizedBlocks.length; index += 1) {
    const current = normalizedBlocks[index];
    if (!isBlankParagraphNode(current)) {
      continue;
    }

    const previous = normalizedBlocks[index - 1];
    const next = normalizedBlocks[index + 1];
    if (isLinkOnlyParagraphNode(previous) || isLinkOnlyParagraphNode(next)) {
      normalizedBlocks[index] = createVisibleTwitterSpacerNode();
    }
  }

  const result: NoteAtomNode[] = [];

  for (let index = 0; index < normalizedBlocks.length; index += 1) {
    const current = normalizedBlocks[index];

    if (!isLinkOnlyParagraphNode(current)) {
      result.push(current);
      continue;
    }

    const previous = result[result.length - 1];
    if (previous && !isBlankParagraphNode(previous) && !isVisibleTwitterSpacerNode(previous)) {
      result.push(createVisibleTwitterSpacerNode());
    }

    result.push(current);

    const next = normalizedBlocks[index + 1];
    if (next && !isBlankParagraphNode(next) && !isVisibleTwitterSpacerNode(next)) {
      result.push(createVisibleTwitterSpacerNode());
    }
  }

  return result;
}

function cloneNoteBlockEntry(entry: NoteBlockEntry): NoteBlockEntry {
  return {
    node: cloneNoteAtomNode(entry.node),
    groupId: entry.groupId,
  };
}

function getNodeText(node: NoteAtomNode): string {
  if (typeof node.text === 'string') {
    return node.text;
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content.map((child) => getNodeText(child)).join('');
}

function getNodeTextLength(node: NoteAtomNode): number {
  const textLength = typeof node.text === 'string' ? node.text.length : 0;
  const childrenLength = Array.isArray(node.content)
    ? node.content.reduce((sum, child) => sum + getNodeTextLength(child), 0)
    : 0;
  const combinedLength = textLength + childrenLength;

  if (combinedLength > 0) {
    return combinedLength;
  }

  if (node.type === 'image' || node.type === 'note' || node.type === 'file') {
    return 1;
  }

  return 0;
}

function getEntryTextLength(entry: NoteBlockEntry): number {
  return getNodeTextLength(entry.node);
}

function splitOversizedEntry(entry: NoteBlockEntry, limit: number): NoteBlockEntry[] {
  return splitOversizedBlock(entry.node, limit).map((node) => ({
    node,
    groupId: entry.groupId,
  }));
}

function splitOversizedBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const blockLength = getNodeTextLength(block);
  if (blockLength <= limit) {
    return [cloneNoteAtomNode(block)];
  }

  if (block.type === 'paragraph' || block.type === 'quote') {
    return splitTextBlock(block, limit);
  }

  if (block.type === 'codeblock') {
    return splitCodeBlock(block, limit);
  }

  return [cloneNoteAtomNode(block)];
}

function splitTextBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const content = Array.isArray(block.content) ? block.content : [];
  const fullText = content.map((node) => node.text || '').join('');
  if (!fullText) {
    return [cloneNoteAtomNode(block)];
  }

  const chunks: NoteAtomNode[] = [];
  let start = 0;

  while (start < fullText.length) {
    const nextEnd = findPreferredTextSplit(fullText, start, limit);
    const end = nextEnd > start ? nextEnd : Math.min(fullText.length, start + limit);
    const slicedContent = sliceInlineTextNodes(content, start, end);
    const slicedLength = slicedContent.reduce((sum, node) => sum + (node.text?.length || 0), 0);

    if (slicedLength === 0) {
      break;
    }

    chunks.push({
      ...cloneNoteAtomNode(block),
      content: slicedContent,
    });
    start = end;
  }

  return chunks.length > 0 ? chunks : [cloneNoteAtomNode(block)];
}

function splitCodeBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const codeText = getNodeText(block);
  if (!codeText) {
    return [cloneNoteAtomNode(block)];
  }

  const lines = codeText.match(/[^\n]*\n?|[^\n]+/g)?.filter(Boolean) || [codeText];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    if (line.length > limit) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }

    if (currentChunk && currentChunk.length + line.length > limit) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    currentChunk += line;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.map((chunk) => ({
    ...cloneNoteAtomNode(block),
    content: [{ type: 'text', text: chunk }],
  }));
}

function findPreferredTextSplit(text: string, start: number, limit: number): number {
  const maxEnd = Math.min(text.length, start + limit);
  if (maxEnd >= text.length) {
    return text.length;
  }

  const window = text.slice(start, maxEnd);
  const newlineBoundary = window.lastIndexOf('\n');
  if (newlineBoundary > 0) {
    return start + newlineBoundary + 1;
  }

  const sentenceMatches = Array.from(window.matchAll(/[。！？!?；;](?:\s|$)|\.(?:\s|$)/g));
  if (sentenceMatches.length > 0) {
    const lastMatch = sentenceMatches[sentenceMatches.length - 1];
    return start + lastMatch.index + lastMatch[0].length;
  }

  const whitespaceBoundary = window.search(/\s+[^\s]*$/);
  if (whitespaceBoundary > 0) {
    return start + whitespaceBoundary + 1;
  }

  return maxEnd;
}

function sliceInlineTextNodes(content: NoteAtomNode[], start: number, end: number): NoteAtomNode[] {
  const result: NoteAtomNode[] = [];
  let offset = 0;

  for (const node of content) {
    const text = node.text || '';
    const nodeStart = offset;
    const nodeEnd = offset + text.length;
    offset = nodeEnd;

    if (nodeEnd <= start || nodeStart >= end) {
      continue;
    }

    const sliceStart = Math.max(0, start - nodeStart);
    const sliceEnd = Math.min(text.length, end - nodeStart);
    const nextText = text.slice(sliceStart, sliceEnd);
    if (!nextText) {
      continue;
    }

    result.push({
      ...cloneNoteAtomNode(node),
      text: nextText,
      content: undefined,
    });
  }

  return result;
}

function expandEntryAtomicGroups(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
  const atomicGroups: NoteBlockEntry[][] = [];
  let currentGroupId: string | undefined;
  let currentGroup: NoteBlockEntry[] = [];

  const flushCurrentGroup = () => {
    if (currentGroup.length === 0) {
      return;
    }

    const clonedGroup = currentGroup.map((entry) => cloneNoteBlockEntry(entry));
    const groupLength = clonedGroup.reduce((sum, entry) => sum + Math.max(getEntryTextLength(entry), 1), 0);
    if (currentGroupId && groupLength <= limit) {
      atomicGroups.push(clonedGroup);
    } else {
      clonedGroup.forEach((entry) => {
        atomicGroups.push([entry]);
      });
    }

    currentGroup = [];
    currentGroupId = undefined;
  };

  for (const entry of entries) {
    if (!entry.groupId) {
      flushCurrentGroup();
      atomicGroups.push([cloneNoteBlockEntry(entry)]);
      continue;
    }

    if (currentGroupId === entry.groupId) {
      currentGroup.push(entry);
      continue;
    }

    flushCurrentGroup();
    currentGroupId = entry.groupId;
    currentGroup = [entry];
  }

  flushCurrentGroup();
  return atomicGroups;
}

function groupEntriesByLimit(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
  const atomicGroups = expandEntryAtomicGroups(entries, limit);
  const groupedEntries: NoteBlockEntry[][] = [];
  let currentGroup: NoteBlockEntry[] = [];
  let currentLength = 0;

  for (const atomicGroup of atomicGroups) {
    const atomicLength = atomicGroup.reduce((sum, entry) => sum + Math.max(getEntryTextLength(entry), 1), 0);

    if (currentGroup.length > 0 && currentLength + atomicLength > limit) {
      groupedEntries.push(currentGroup);
      currentGroup = [];
      currentLength = 0;
    }

    currentGroup.push(...atomicGroup.map((entry) => cloneNoteBlockEntry(entry)));
    currentLength += atomicLength;
  }

  if (currentGroup.length > 0) {
    groupedEntries.push(currentGroup);
  }

  return groupedEntries;
}
