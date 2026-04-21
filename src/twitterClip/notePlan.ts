import { truncateTwitterTitle } from '../content/twitter/title.ts';
import type { CreateNoteRequest } from '../types/index.ts';

export interface NoteAtomMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface NoteAtomNode {
  type: string;
  text?: string;
  marks?: NoteAtomMark[];
  content?: NoteAtomNode[];
  attrs?: Record<string, unknown>;
}

export interface NoteAtomDoc {
  type: string;
  content?: NoteAtomNode[];
}

export interface NoteBlockEntry {
  node: NoteAtomNode;
  groupId?: string;
}

const TWITTER_VISIBLE_SPACER_TEXT = '\u00A0';

export function cloneNoteAtomNode<T extends NoteAtomNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

export function getNoteNodeText(node: NoteAtomNode): string {
  if (typeof node.text === 'string') {
    return node.text;
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content.map((child) => getNoteNodeText(child)).join('');
}

export function getNoteNodeTextLength(node: NoteAtomNode): number {
  const textLength = typeof node.text === 'string' ? node.text.length : 0;
  const childrenLength = Array.isArray(node.content)
    ? node.content.reduce((sum, child) => sum + getNoteNodeTextLength(child), 0)
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
  return getNoteNodeTextLength(entry.node);
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
    return start + (lastMatch.index || 0) + lastMatch[0].length;
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
  const codeText = getNoteNodeText(block);
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

function splitOversizedBlock(block: NoteAtomNode, limit: number): NoteAtomNode[] {
  const blockLength = getNoteNodeTextLength(block);
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

export function splitOversizedEntry(entry: NoteBlockEntry, limit: number): NoteBlockEntry[] {
  return splitOversizedBlock(entry.node, limit).map((node) => ({
    node,
    groupId: entry.groupId,
  }));
}

function expandEntryAtomicGroups(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
  const atomicGroups: NoteBlockEntry[][] = [];
  let currentGroupId: string | undefined;
  let currentGroup: NoteBlockEntry[] = [];

  const flushCurrentGroup = () => {
    if (currentGroup.length === 0) {
      return;
    }

    const clonedGroup = currentGroup.map((entry) => ({
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    }));
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
      atomicGroups.push([{
        node: cloneNoteAtomNode(entry.node),
        groupId: entry.groupId,
      }]);
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

export function groupEntriesByLimit(entries: NoteBlockEntry[], limit: number): NoteBlockEntry[][] {
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

    currentGroup.push(...atomicGroup.map((entry) => ({
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    })));
    currentLength += atomicLength;
  }

  if (currentGroup.length > 0) {
    groupedEntries.push(currentGroup);
  }

  return groupedEntries;
}

function createBlankParagraphEntry(groupId?: string): NoteBlockEntry {
  return {
    node: createEmptyParagraphNode(),
    groupId,
  };
}

function normalizeTitleCandidateLine(text: string): string {
  return text
    .replace(/\u2060/g, '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSkipTitleCandidateLine(text: string): boolean {
  if (!text) {
    return true;
  }

  return text === '查看原文'
    || text.startsWith('📄 来源')
    || text.startsWith('🔗 引用文章');
}

function getTitleCandidateFromEntries(entries: NoteBlockEntry[]): string {
  for (const entry of entries) {
    const nodeText = getNoteNodeText(entry.node);
    if (!nodeText.trim()) {
      continue;
    }

    const lines = nodeText
      .split('\n')
      .map((line) => normalizeTitleCandidateLine(line))
      .filter(Boolean);

    const candidate = lines.find((line) => !shouldSkipTitleCandidateLine(line));
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

function getTitleCandidateFromHtml(content: string): string {
  const text = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ');

  return text
    .split('\n')
    .map((line) => normalizeTitleCandidateLine(line))
    .find((line) => !shouldSkipTitleCandidateLine(line)) || '';
}

export function resolveTwitterSaveTitle(
  title: string,
  entries: NoteBlockEntry[],
  content: string
): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle) {
    return normalizedTitle;
  }

  const candidate = getTitleCandidateFromEntries(entries) || getTitleCandidateFromHtml(content);
  return candidate ? truncateTwitterTitle(candidate, 30) : '';
}

export function normalizeTwitterNoteEntries(entries: NoteBlockEntry[]): NoteBlockEntry[] {
  const collapsedEntries: NoteBlockEntry[] = [];
  let pendingBlankEntry: NoteBlockEntry | null = null;

  for (const entry of entries) {
    const clonedEntry: NoteBlockEntry = {
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    };

    if (isBlankParagraphNode(clonedEntry.node)) {
      if (collapsedEntries.length === 0) {
        continue;
      }

      pendingBlankEntry = pendingBlankEntry || createBlankParagraphEntry(clonedEntry.groupId);
      continue;
    }

    if (pendingBlankEntry) {
      collapsedEntries.push(pendingBlankEntry);
      pendingBlankEntry = null;
    }

    collapsedEntries.push(clonedEntry);
  }

  const paddedReferenceEntries = padTwitterReferenceLinkEntries(collapsedEntries);
  const mergedReferenceQuoteEntries = mergeReferenceQuoteRuns(paddedReferenceEntries);
  const trimmedImageSpacingEntries = trimBlankEntriesAroundImages(mergedReferenceQuoteEntries);
  return collapseTwitterBlankEntries(trimmedImageSpacingEntries);
}

function collapseTwitterBlankEntries(entries: NoteBlockEntry[]): NoteBlockEntry[] {
  const normalizedEntries: NoteBlockEntry[] = [];
  let pendingBlankEntry: NoteBlockEntry | null = null;

  for (const entry of entries) {
    const clonedEntry: NoteBlockEntry = {
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    };

    if (isBlankParagraphNode(clonedEntry.node)) {
      if (normalizedEntries.length === 0) {
        continue;
      }

      pendingBlankEntry = pendingBlankEntry || createBlankParagraphEntry(clonedEntry.groupId);
      continue;
    }

    if (pendingBlankEntry) {
      normalizedEntries.push(pendingBlankEntry);
      pendingBlankEntry = null;
    }

    normalizedEntries.push(clonedEntry);
  }

  return normalizedEntries;
}

function isReferenceLinkEntry(entry: NoteBlockEntry): boolean {
  if (entry.node.type !== 'paragraph') {
    return false;
  }

  return /^🔗\s*引用文章：/.test(getNoteNodeText(entry.node).replace(/[\u2060\u200b]/g, '').trim());
}

function isImageEntry(entry: NoteBlockEntry | undefined): boolean {
  return entry?.node.type === 'image';
}

function isQuoteEntry(entry: NoteBlockEntry | undefined): boolean {
  return entry?.node.type === 'quote';
}

function createQuoteSeparatorNode(text: '\n' | '\n\n'): NoteAtomNode {
  return {
    type: 'text',
    text,
  };
}

function mergeQuoteEntries(entries: NoteBlockEntry[]): NoteBlockEntry | null {
  const quoteContent: NoteAtomNode[] = [];
  const mergedGroupId = entries.find((entry) => entry.groupId)?.groupId;
  let pendingBlank = false;

  for (const entry of entries) {
    if (isBlankParagraphNode(entry.node)) {
      pendingBlank = quoteContent.length > 0;
      continue;
    }

    if (!isQuoteEntry(entry)) {
      continue;
    }

    const currentContent = Array.isArray(entry.node.content)
      ? entry.node.content.map((node) => cloneNoteAtomNode(node))
      : [];
    if (currentContent.length === 0) {
      continue;
    }

    if (quoteContent.length > 0) {
      quoteContent.push(createQuoteSeparatorNode(pendingBlank ? '\n\n' : '\n'));
    }

    quoteContent.push(...currentContent);
    pendingBlank = false;
  }

  if (quoteContent.length === 0) {
    return null;
  }

  return {
    node: {
      type: 'quote',
      content: quoteContent,
    },
    groupId: mergedGroupId,
  };
}

function mergeReferenceQuoteRuns(entries: NoteBlockEntry[]): NoteBlockEntry[] {
  const normalizedEntries: NoteBlockEntry[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const clonedEntry: NoteBlockEntry = {
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    };

    if (!isReferenceLinkEntry(clonedEntry)) {
      normalizedEntries.push(clonedEntry);
      continue;
    }

    normalizedEntries.push(clonedEntry);

    let cursor = index + 1;
    if (cursor < entries.length && isBlankParagraphNode(entries[cursor].node)) {
      normalizedEntries.push({
        node: cloneNoteAtomNode(entries[cursor].node),
        groupId: entries[cursor].groupId,
      });
      cursor += 1;
    }

    const quoteRun: NoteBlockEntry[] = [];

    while (cursor < entries.length) {
      const currentEntry = entries[cursor];

      if (isQuoteEntry(currentEntry)) {
        quoteRun.push({
          node: cloneNoteAtomNode(currentEntry.node),
          groupId: currentEntry.groupId,
        });
        cursor += 1;
        continue;
      }

      if (isBlankParagraphNode(currentEntry.node)) {
        const nextEntry = entries[cursor + 1];
        if (quoteRun.length > 0 && isQuoteEntry(nextEntry)) {
          quoteRun.push({
            node: cloneNoteAtomNode(currentEntry.node),
            groupId: currentEntry.groupId,
          });
          cursor += 1;
          continue;
        }
      }

      break;
    }

    if (quoteRun.length > 0) {
      const mergedQuoteEntry = mergeQuoteEntries(quoteRun);
      if (mergedQuoteEntry) {
        normalizedEntries.push(mergedQuoteEntry);
      }
      index = cursor - 1;
    }
  }

  return normalizedEntries;
}

function padTwitterReferenceLinkEntries(entries: NoteBlockEntry[]): NoteBlockEntry[] {
  const normalizedEntries: NoteBlockEntry[] = [];

  entries.forEach((entry, index) => {
    const clonedEntry: NoteBlockEntry = {
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    };

    if (!isReferenceLinkEntry(clonedEntry)) {
      normalizedEntries.push(clonedEntry);
      return;
    }

    const previousEntry = normalizedEntries[normalizedEntries.length - 1];
    if (previousEntry && !isBlankParagraphNode(previousEntry.node)) {
      normalizedEntries.push(createBlankParagraphEntry(clonedEntry.groupId));
    }

    normalizedEntries.push(clonedEntry);

    const nextEntry = entries[index + 1];
    if (nextEntry && !isBlankParagraphNode(nextEntry.node)) {
      normalizedEntries.push(createBlankParagraphEntry(clonedEntry.groupId));
    }
  });

  return normalizedEntries;
}

function trimBlankEntriesAroundImages(entries: NoteBlockEntry[]): NoteBlockEntry[] {
  const normalizedEntries: NoteBlockEntry[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const clonedEntry: NoteBlockEntry = {
      node: cloneNoteAtomNode(entry.node),
      groupId: entry.groupId,
    };

    if (!isBlankParagraphNode(clonedEntry.node)) {
      normalizedEntries.push(clonedEntry);
      continue;
    }

    const previousEntry = normalizedEntries[normalizedEntries.length - 1];
    const nextEntry = entries[index + 1];
    if (isImageEntry(previousEntry) || isImageEntry(nextEntry)) {
      continue;
    }

    normalizedEntries.push(clonedEntry);
  }

  return normalizedEntries;
}

const BLANK_PARAGRAPH_HTML_PATTERN = '<p\\b[^>]*>(?:\\s|&nbsp;|&#160;|<br\\s*\\/?>)*<\\/p>';
const BLANK_LINE_BREAK_HTML_PATTERN = '(?:<br\\s*\\/?>\\s*){3,}';

export function normalizeTwitterHtmlContent(content: string): string {
  if (!content.trim()) {
    return content;
  }

  const consecutiveBlankParagraphs = new RegExp(`(?:\\s*${BLANK_PARAGRAPH_HTML_PATTERN}\\s*){2,}`, 'gi');
  const consecutiveBlankLineBreaks = new RegExp(BLANK_LINE_BREAK_HTML_PATTERN, 'gi');
  const leadingBlankParagraphs = new RegExp(`^(?:\\s*${BLANK_PARAGRAPH_HTML_PATTERN}\\s*)+`, 'i');
  const trailingBlankParagraphs = new RegExp(`(?:\\s*${BLANK_PARAGRAPH_HTML_PATTERN}\\s*)+$`, 'i');

  return content
    .replace(consecutiveBlankLineBreaks, '<br><br>')
    .replace(consecutiveBlankParagraphs, '<p><br></p>')
    .replace(leadingBlankParagraphs, '')
    .replace(trailingBlankParagraphs, '')
    .trim();
}

export function createSourceLinkNoteBlocks(sourceUrl: string): NoteAtomNode[] {
  if (!sourceUrl) {
    return [];
  }

  return [{
    type: 'paragraph',
    content: [
      { type: 'text', text: '📄 来源：' },
      {
        type: 'text',
        text: '查看原文',
        marks: [{ type: 'link', attrs: { href: sourceUrl } }],
      },
    ],
  }];
}

function createEmptyParagraphNode(): NoteAtomNode {
  return {
    type: 'paragraph',
    content: [],
  };
}

export function createVisibleTwitterSpacerNode(): NoteAtomNode {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text: TWITTER_VISIBLE_SPACER_TEXT }],
  };
}

export function isBlankParagraphNode(node: NoteAtomNode): boolean {
  if (node.type !== 'paragraph') {
    return false;
  }

  return getNoteNodeText(node).trim().length === 0;
}

export function isVisibleTwitterSpacerNode(node: NoteAtomNode | undefined): boolean {
  return Boolean(
    node?.type === 'paragraph' &&
    Array.isArray(node.content) &&
    node.content.length === 1 &&
    node.content[0]?.type === 'text' &&
    node.content[0]?.text === TWITTER_VISIBLE_SPACER_TEXT
  );
}

export function normalizeNoteParagraphSpacing(blocks: NoteAtomNode[]): NoteAtomNode[] {
  const normalized: NoteAtomNode[] = [];
  let pendingBlank = false;

  for (const block of blocks) {
    if (isBlankParagraphNode(block)) {
      if (normalized.length === 0) {
        continue;
      }

      pendingBlank = true;
      continue;
    }

    if (pendingBlank) {
      normalized.push(createEmptyParagraphNode());
      pendingBlank = false;
    }

    normalized.push(cloneNoteAtomNode(block));
  }

  return normalized;
}

export function joinNoteBlockSectionsWithSingleSpacer(sections: NoteAtomNode[][]): NoteAtomNode[] {
  const merged: NoteAtomNode[] = [];

  sections.forEach((section) => {
    const normalizedSection = normalizeNoteParagraphSpacing(section);
    if (normalizedSection.length === 0) {
      return;
    }

    if (merged.length > 0) {
      merged.push(createEmptyParagraphNode());
    }

    merged.push(...normalizedSection.map((block) => cloneNoteAtomNode(block)));
  });

  return normalizeNoteParagraphSpacing(merged);
}

export function createLongformTitleNoteBlocks(title: string): NoteAtomNode[] {
  if (!title.trim()) {
    return [];
  }

  return [{
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: title.trim(),
        marks: [{ type: 'bold' }],
      },
    ],
  }];
}

export function createTwitterPrefixSections(title: string, sourceUrl: string): NoteAtomNode[][] {
  const sections: NoteAtomNode[][] = [];
  const titleBlocks = createLongformTitleNoteBlocks(title);
  const sourceBlocks = createSourceLinkNoteBlocks(sourceUrl);

  if (titleBlocks.length > 0) {
    sections.push(titleBlocks);
  }

  if (sourceBlocks.length > 0) {
    sections.push(sourceBlocks);
  }

  return sections;
}

export function buildTwitterLongformBody(
  title: string,
  sourceUrl: string,
  blocks: NoteAtomNode[]
): NoteAtomDoc {
  const contentBlocks = blocks.map((block) => cloneNoteAtomNode(block));

  return {
    type: 'doc',
    content: joinNoteBlockSectionsWithSingleSpacer([
      ...createTwitterPrefixSections(title, sourceUrl),
      contentBlocks,
    ]),
  };
}

export function prepareTwitterLongformNotePlan(params: {
  title: string;
  sourceUrl: string;
  content: string;
  entries: NoteBlockEntry[];
  limit: number;
  singleNoteCreateMode: 'html' | 'body';
}): CreateNoteRequest[] {
  const {
    title,
    sourceUrl,
    content,
    entries,
    limit,
    singleNoteCreateMode,
  } = params;

  const normalizedTitle = resolveTwitterSaveTitle(title, entries, content);
  const effectiveTitle = normalizedTitle || '推文';
  const normalizedContent = normalizeTwitterHtmlContent(content);
  const normalizedEntries = normalizeTwitterNoteEntries(entries);
  const totalTextLength = normalizedEntries.reduce((sum, entry) => sum + getEntryTextLength(entry), 0);

  if (totalTextLength <= limit) {
    if (singleNoteCreateMode === 'html') {
      return [{
        createMode: 'html',
        index: 0,
        total: 1,
        title: effectiveTitle,
        content: normalizedContent,
        sourceUrl,
      }];
    }

    return [{
      createMode: 'body',
      index: 0,
      total: 1,
      title: effectiveTitle,
      body: buildTwitterLongformBody(effectiveTitle, sourceUrl, normalizedEntries.map((entry) => entry.node)),
    }];
  }

  const splitEntries = normalizedEntries.flatMap((entry) => splitOversizedEntry(entry, limit));
  const groupedEntries = groupEntriesByLimit(splitEntries, limit);
  const total = groupedEntries.length;

  if (total <= 1) {
    return [{
      createMode: 'html',
      index: 0,
      total: 1,
      title: effectiveTitle,
      content: normalizedContent,
      sourceUrl,
    }];
  }

  return groupedEntries.map((group, index) => {
    const partTitle = index === 0 ? effectiveTitle : `${effectiveTitle} (${index + 1})`;
    return {
      createMode: 'body' as const,
      index,
      total,
      title: partTitle,
      body: buildTwitterLongformBody(partTitle, sourceUrl, group.map((entry) => entry.node)),
    };
  });
}
