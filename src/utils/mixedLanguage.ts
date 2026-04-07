/**
 * Helpers for splitting accidentally concatenated Chinese/English paragraphs.
 *
 * Some article pages render translated text and original text as visually
 * separated lines, but keep them inside the same semantic block. The clipping
 * pipeline then receives a single text run like:
 * - "LLM 知识库Something I'm finding..."
 * - "所以： Data ingest:"
 *
 * This module detects those cross-script boundaries conservatively so callers
 * can turn them back into separate paragraphs before saving.
 */

const SCRIPT_CHARACTER_REGEX = /[\u4e00-\u9fffA-Za-z]/;
const HAN_CHARACTER_REGEX = /[\u4e00-\u9fff]/;
const HAN_CHARACTER_MATCH_REGEX = /[\u4e00-\u9fff]/g;
const LATIN_WORD_REGEX = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const BOUNDARY_FILLER_REGEX = /^[\s\u00a0,，.。!！?？;；:：、\-–—>→()（）[\]【】"“”'‘’/]+$/;
const LATIN_TAIL_REGEX = /[A-Za-z0-9.,!?;:)\]'"“”‘’_-]$/;
const LATIN_HEAD_REGEX = /^[A-Za-z]/;
const HAN_TAIL_REGEX = /[\u4e00-\u9fff]$/;
const HAN_HEAD_REGEX = /^[\u4e00-\u9fff]/;
const METADATA_LABEL_TAIL_REGEX = /(?:来源：|引用文章：)$/;
const MIXED_LANGUAGE_TRAILING_SPACE_REGEX = /[ \t\u00a0\u2060]+$/g;
const MIXED_LANGUAGE_LEADING_SPACE_REGEX = /^[ \t\u00a0\u2060]+/g;
const HAN_TO_LATIN_BOUNDARY_REGEX = /(?<=[\u4e00-\u9fff])[ \t\u00a0\u2060]*(?=[A-Za-z])/g;
const LATIN_TO_HAN_BOUNDARY_REGEX = /(?<=[A-Za-z0-9.,!?;:)\]'"“”‘’_-])[ \t\u00a0\u2060]*(?=[\u4e00-\u9fff])/g;

export const MIXED_LANGUAGE_WORD_JOINER = '\u2060';
export const MIXED_LANGUAGE_SPACE = ' ';
export const MIXED_LANGUAGE_NONBREAKING_GAP = `${MIXED_LANGUAGE_SPACE}${MIXED_LANGUAGE_WORD_JOINER}`;

function countHanCharacters(text: string): number {
  return (text.match(HAN_CHARACTER_MATCH_REGEX) || []).length;
}

function countLatinWords(text: string): number {
  return (text.match(LATIN_WORD_REGEX) || []).length;
}

function trimMixedLanguageBoundary(text: string): string {
  return text
    .replace(/^[\s\u00a0,，.。!！?？;；:：、\-–—>→()（）[\]【】"“”'‘’/]+/, '')
    .trim();
}

function trimMixedLanguageBoundaryTail(text: string): string {
  return text
    .replace(/[\s\u00a0,，.。!！?？;；、\-–—>→()（）[\]【】"“”'‘’/]+$/, '')
    .trim();
}

function startsWithLongEnglishPhrase(text: string): boolean {
  const normalized = trimMixedLanguageBoundary(text);
  if (!normalized || !/^[A-Za-z]/.test(normalized)) {
    return false;
  }

  const head = normalized.slice(0, 80);
  const firstWindow = head.slice(0, 24);
  if (countHanCharacters(firstWindow) > 0) {
    return false;
  }

  if (countLatinWords(head) >= 3) {
    return true;
  }

  const headingWindow = normalized.slice(0, 40);
  return countLatinWords(headingWindow) >= 2 && /^[A-Za-z][A-Za-z\s'’-]{1,40}[:：]/.test(headingWindow);
}

function startsWithLongHanPhrase(text: string): boolean {
  const normalized = trimMixedLanguageBoundary(text);
  if (!normalized) {
    return false;
  }

  const head = normalized.slice(0, 40);
  return countHanCharacters(head) >= 6 && countLatinWords(head.slice(0, 24)) <= 1;
}

function findPreviousScriptCharacter(text: string, startIndex: number): { index: number; char: string } | null {
  for (let index = startIndex; index >= 0; index--) {
    const char = text[index];
    if (SCRIPT_CHARACTER_REGEX.test(char)) {
      return { index, char };
    }
  }

  return null;
}

function findNextScriptCharacter(text: string, startIndex: number): { index: number; char: string } | null {
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];
    if (SCRIPT_CHARACTER_REGEX.test(char)) {
      return { index, char };
    }
  }

  return null;
}

function isShortStandalonePrefix(prefix: string, script: 'han' | 'latin'): boolean {
  const normalized = trimMixedLanguageBoundaryTail(trimMixedLanguageBoundary(prefix));
  if (!normalized || normalized.length > 24) {
    return false;
  }

  if (/[。！？!?；;]/.test(normalized)) {
    return false;
  }

  // Short-title recovery is intentionally stricter than long-paragraph recovery.
  // We only split very compact prefixes that already look like a standalone label.
  // Chinese labels like "完整解析：" may not contain spaces, so allow trailing colon labels too.
  const hasWordBoundary = /\s/.test(normalized);
  const hasLabelSuffix = /[:：]$/.test(normalized);
  if (!hasWordBoundary && !hasLabelSuffix) {
    return false;
  }

  if (script === 'han') {
    const hanCount = countHanCharacters(normalized);
    return hanCount >= 2 && hanCount <= 10;
  }

  return countLatinWords(normalized) >= 2;
}

function findMixedLanguageSplitIndex(text: string): number {
  for (let cursor = 1; cursor < text.length; cursor++) {
    const left = findPreviousScriptCharacter(text, cursor - 1);
    const right = findNextScriptCharacter(text, cursor);

    if (!left || !right || left.index >= right.index) {
      continue;
    }

    const between = text.slice(left.index + 1, right.index);
    if (between && !BOUNDARY_FILLER_REGEX.test(between)) {
      continue;
    }

    const markerMatch = between.match(/[>→\-–—]/);
    const splitIndex = markerMatch
      ? left.index + 1 + (markerMatch.index ?? 0)
      : right.index;

    const prefix = text.slice(0, right.index);
    const suffix = text.slice(right.index);
    const leftIsHan = HAN_CHARACTER_REGEX.test(left.char);
    const rightIsHan = HAN_CHARACTER_REGEX.test(right.char);
    const leftIsLatin = /[A-Za-z]/.test(left.char);
    const rightIsLatin = /[A-Za-z]/.test(right.char);

    if (leftIsHan && rightIsLatin && startsWithLongEnglishPhrase(suffix)) {
      if (countHanCharacters(prefix) >= 6) {
        return splitIndex;
      }

      if (isShortStandalonePrefix(prefix, 'han')) {
        return splitIndex;
      }
    } else if (leftIsLatin && rightIsHan && startsWithLongHanPhrase(suffix)) {
      if (countLatinWords(prefix) >= 3) {
        return splitIndex;
      }

      if (isShortStandalonePrefix(prefix, 'latin')) {
        return splitIndex;
      }
    }

    cursor = right.index;
  }

  return -1;
}

export function findMixedLanguageSplitBoundaries(text: string): number[] {
  const leadingWhitespaceLength = (text.match(/^[\s\u00a0]*/) || [''])[0].length;
  const normalizedText = text.slice(leadingWhitespaceLength).replace(/[\s\u00a0]+$/, '');
  if (!normalizedText || countHanCharacters(normalizedText) === 0 || countLatinWords(normalizedText) === 0) {
    return [];
  }

  const boundaries: number[] = [];
  let offset = 0;
  let remaining = normalizedText;

  for (let round = 0; round < 6; round++) {
    const splitIndex = findMixedLanguageSplitIndex(remaining);
    if (splitIndex <= 0 || splitIndex >= remaining.length) {
      break;
    }

    boundaries.push(leadingWhitespaceLength + offset + splitIndex);
    remaining = remaining.slice(splitIndex);
    offset += splitIndex;
  }

  return boundaries;
}

/**
 * Normalize mixed Chinese/English spacing while keeping the Chinese token that
 * follows a Latin token on the same line.
 *
 * Rules:
 * - Han + Latin => insert one visible space
 * - Latin + Han => insert one visible space plus a word joiner
 *
 * Examples:
 * - "渲染markdown文件" -> "渲染 markdown 文件"
 * - "Obsidian查看" -> "Obsidian 查看" (with a hidden no-break joiner after the space)
 */
export function stabilizeLatinHanLineBreaks(text: string): string {
  return text
    .replace(HAN_TO_LATIN_BOUNDARY_REGEX, MIXED_LANGUAGE_SPACE)
    .replace(LATIN_TO_HAN_BOUNDARY_REGEX, MIXED_LANGUAGE_NONBREAKING_GAP);
}

export function needsLatinHanWordJoiner(leftText: string, rightText: string): boolean {
  const left = leftText.replace(MIXED_LANGUAGE_TRAILING_SPACE_REGEX, '');
  const right = rightText.replace(MIXED_LANGUAGE_LEADING_SPACE_REGEX, '');

  if (!left || !right) {
    return false;
  }

  return LATIN_TAIL_REGEX.test(left) && HAN_HEAD_REGEX.test(right);
}

export function needsHanLatinSpace(leftText: string, rightText: string): boolean {
  const left = leftText.replace(MIXED_LANGUAGE_TRAILING_SPACE_REGEX, '');
  const right = rightText.replace(MIXED_LANGUAGE_LEADING_SPACE_REGEX, '');

  if (!left || !right) {
    return false;
  }

  return HAN_TAIL_REGEX.test(left) && LATIN_HEAD_REGEX.test(right);
}

export function needsMetadataLabelWordJoiner(leftText: string, rightText: string): boolean {
  const left = leftText.replace(MIXED_LANGUAGE_TRAILING_SPACE_REGEX, '');
  const right = rightText.replace(MIXED_LANGUAGE_LEADING_SPACE_REGEX, '');

  if (!left || !right) {
    return false;
  }

  return METADATA_LABEL_TAIL_REGEX.test(left);
}
