/**
 * HTML to NoteAtom Converter (Block-Aware)
 * 
 * Key improvements:
 * 1. Block-level first: Parse HTML by block boundaries (p, div, section, li, etc.)
 * 2. Preserve paragraph structure: Each block element = one paragraph node
 * 3. Support lists: ul/ol → paragraphs with bullet/number prefix
 * 4. Support code blocks: pre/code → codeblock (with language) or quote (without language)
 * 5. Structure summary logging for debugging
 * 
 * NoteAtom supported types (per official API):
 * - doc (root)
 * - paragraph (main content)
 * - quote (blockquote)
 * - codeblock (code block with language)
 * - image (with uuid)
 * 
 * Marks: bold, italic, highlight, link, code
 */

import {
  findMixedLanguageSplitBoundaries,
  MIXED_LANGUAGE_NONBREAKING_GAP,
  MIXED_LANGUAGE_WORD_JOINER,
  needsHanLatinSpace,
  needsMetadataLabelWordJoiner,
  needsLatinHanWordJoiner,
  stabilizeLatinHanLineBreaks,
} from './mixedLanguage';
import { detectCodeLanguage } from './shikiLanguages';

interface NoteAtomMark {
  type: 'bold' | 'italic' | 'highlight' | 'link' | 'code';
  attrs?: { href?: string };
}

interface NoteAtom {
  type: string;
  text?: string;
  content?: NoteAtom[];
  marks?: NoteAtomMark[];
  attrs?: Record<string, string | number | boolean>;
}

interface ImageData {
  src: string;
  alt: string;
  uuid?: string;
}

interface ConvertStats {
  source: string;
  total: number;
  paragraph: number;
  quote: number;
  image: number;
  list: number;
  code: number;
}

interface MowenNoteImageAsset {
  fileUuid?: string;
  url?: string;
  scale?: Record<string, string | undefined>;
  uuid?: string;
}

interface MowenNoteFileLike {
  images?: Record<string, MowenNoteImageAsset | undefined>;
}

interface MowenNoteFileTreeLike {
  imageAttach?: unknown[];
}

interface NoteAtomToHtmlOptions {
  resolveImageUrl?: (uuid: string) => string;
}

interface NormalizeMowenHtmlOptions {
  noteFile?: MowenNoteFileLike;
  noteFileTree?: MowenNoteFileTreeLike;
  /** API 返回的 noteGallery 数据，包含画廊图片 UUID 列表 */
  noteGallery?: MowenNoteGalleryLike;
}

/** 画廊数据结构（从 API response.detail.noteGallery 中提取） */
interface MowenNoteGalleryLike {
  gallerys?: Record<string, { fileUuids?: string[] } | undefined>;
}

interface ProtectedCodeBlock {
  placeholder: string;
  content: string;
  language: string | null;
}

interface ProtectedInlineParagraph {
  placeholder: string;
  content: string;
}

interface HtmlToNoteAtomOptions {
  preserveInlineParagraphs?: boolean;
}

const PRESERVE_INLINE_PARAGRAPH_ATTR = 'data-mowen-preserve-inline-paragraph';
const INLINE_BREAK_SENTINEL = '\uE000';

// Block-level tags are handled inline in parseBlockContent

function protectCodeBlocks(html: string): { html: string; codeBlocks: ProtectedCodeBlock[] } {
  const codeBlocks: ProtectedCodeBlock[] = [];

  const registerCodeBlock = (preAttrs: string, content: string): string => {
    const placeholder = `@@MOWEN_CODE_BLOCK_${codeBlocks.length}@@`;
    const codeTagMatch = content.match(/<code\b([^>]*)>/i);
    const codeAttrs = codeTagMatch ? codeTagMatch[1] : '';
    const language = detectCodeLanguage(preAttrs, codeAttrs);
    const codeContent = content.replace(/<\/?code[^>]*>/gi, '');

    codeBlocks.push({
      placeholder,
      content: codeContent,
      language,
    });

    return `\n${placeholder}\n`;
  };

  let protectedHtml = html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_match, preAttrs, content) => (
    registerCodeBlock(preAttrs, content)
  ));

  // 有些站点会把块级代码打散成 <p><code>...</code></p> 或 <div><code>...</code></div>
  // 只在“容器内只有 code + 空白”的情况下识别，避免误伤行内 code。
  protectedHtml = protectedHtml.replace(
    /<(p|div|section|article|li)\b([^>]*)>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/\1>/gi,
    (match, _tag, wrapperAttrs, codeAttrs, content) => {
      const looksLikeBlockCode = /\n/.test(content) || Boolean(detectCodeLanguage(wrapperAttrs, codeAttrs));
      if (!looksLikeBlockCode) {
        return match;
      }

      return registerCodeBlock(`${wrapperAttrs} ${codeAttrs}`, content);
    }
  );

  return {
    html: protectedHtml,
    codeBlocks,
  };
}

/**
 * Main conversion function
 */
export function htmlToNoteAtom(html: string, options: HtmlToNoteAtomOptions = {}): NoteAtom {
  const stats: ConvertStats = {
    source: 'block-parser',
    total: 0,
    paragraph: 0,
    quote: 0,
    image: 0,
    list: 0,
    code: 0
  };

  try {
    const protectedCode = protectCodeBlocks(html);

    // 1. Clean script/style/comments
    let processed = protectedCode.html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gmi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gmi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // 2. Extract images and replace with placeholders
    const images: ImageData[] = [];
    processed = processed.replace(/<img\b[^>]+>/gmi, (match) => {
      const imgData = extractImageData(match);
      if (imgData) {
        images.push(imgData);
        return `\n<!--IMG:${images.length - 1}-->\n`;
      }
      return '';
    });

    // 3. Parse blocks
    const blocks = parseBlockContent(processed, images, stats, protectedCode.codeBlocks, options);
    stats.total = blocks.length;

    // 4. Ensure at least one block
    if (blocks.length === 0) {
      blocks.push({ type: 'paragraph', content: [{ type: 'text', text: ' ' }] });
    }

    return {
      type: 'doc',
      content: blocks
    };
  } catch (e) {
    console.error('[noteAtom] Conversion failed:', e);
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Error converting content.' }] }]
    };
  }
}

/**
 * Parse block-level content from HTML
 * Uses a streaming approach to handle nested structures
 */
function parseBlockContent(
  html: string,
  images: ImageData[],
  stats: ConvertStats,
  protectedCodeBlocks: ProtectedCodeBlock[] = [],
  options: HtmlToNoteAtomOptions = {}
): NoteAtom[] {
  const blocks: NoteAtom[] = [];

  // Strategy: Use regex to find block boundaries and process sequentially
  // This handles nesting better than splitting by tags

  // First, normalize the HTML structure to ensure block tags create boundaries
  let normalized = html;

  // 1. Handle headings first (convert to bold paragraphs)
  normalized = normalized.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, _l, content) => `\n<p class="__heading__"><strong>${content}</strong></p>\n`);

  // 2. Handle blockquotes
  const quoteBlocks: Array<{ placeholder: string; content: string }> = [];
  normalized = normalized.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) => {
    const placeholder = `<!--QUOTE:${quoteBlocks.length}-->`;
    quoteBlocks.push({ placeholder, content });
    return `\n${placeholder}\n`;
  });

  // 3. Handle protected code block placeholders extracted before any global HTML cleanup.
  const codeBlocks = protectedCodeBlocks;

  // 4. Handle lists (convert to individual paragraphs with prefixes)
  normalized = normalized.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, content) => {
    return convertListItems(content, false);
  });
  normalized = normalized.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, content) => {
    return convertListItems(content, true);
  });

  // 5.1 保护需要“禁止二次按中英混排拆段”的段落（例如 X Article 原文/译文对照）
  const protectedInlineParagraphs: ProtectedInlineParagraph[] = [];
  normalized = normalized.replace(
    new RegExp(`<p\\b([^>]*)${PRESERVE_INLINE_PARAGRAPH_ATTR}=["']1["']([^>]*)>([\\s\\S]*?)<\\/p>`, 'gi'),
    (_m, _beforeAttrs, _afterAttrs, content) => {
      const placeholder = `@@MOWEN_PRESERVE_PARAGRAPH_${protectedInlineParagraphs.length}@@`;
      protectedInlineParagraphs.push({ placeholder, content });
      return `\n${placeholder}\n`;
    }
  );

  // 5. Normalize block boundaries: ensure each block-level element creates a clear boundary
  // Close tags + open tags both create boundaries
  normalized = normalized
    .replace(/<\/(p|div|section|article|main|aside|header|footer|figure|figcaption|tr|td|th)>/gi, '\n<!--BLOCK_END-->\n')
    .replace(/<(p|div|section|article|main|aside|header|footer|figure|figcaption|tr|td|th)\b[^>]*>/gi, '\n<!--BLOCK_START-->\n')
    .replace(/<br\s*\/?>/gi, '\n<!--EMPTY_LINE-->\n')
    .replace(/<hr\s*\/?>/gi, '\n<!--HR-->\n');

  // 6. 确保 QUOTE、CODE、IMG 占位符独立成行，便于后续匹配
  normalized = normalized
    .replace(/(<!--QUOTE:\d+-->)/g, '\n$1\n')
    .replace(/(@@MOWEN_CODE_BLOCK_\d+@@)/g, '\n$1\n')
    .replace(/(@@MOWEN_PRESERVE_PARAGRAPH_\d+@@)/g, '\n$1\n')
    .replace(/(<!--IMG:\d+-->)/g, '$1');

  // 7. Split by block boundaries
  // Note: EMPTY_LINE is NOT in the split regex, so it is preserved inside segments
  const segments = normalized.split(/<!--(?:BLOCK_START|BLOCK_END|HR)-->/);


  for (const segment of segments) {
    // 将每个 segment 按换行符分割成多行，逐行处理
    // 这样可以正确识别 QUOTE、CODE、IMG 占位符
    const lines = segment.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Check if this segment represents an intentionally empty block (e.g., from empty <p></p>)
      // We look for segments that are just whitespace with block markers but no real content
      const isEmptyBlock = !trimmed || /^[\s\n]*$/.test(trimmed);

      // Handle empty block - create empty paragraph for spacing
      if (isEmptyBlock) {
        // Only add empty paragraph if we already have content (avoid leading empty lines)
        if (blocks.length > 0) {
          blocks.push({ type: 'paragraph' }); // No content field for empty paragraph per API spec
          stats.paragraph++;
        }
        continue;
      }

      // Check for image placeholder
      const imgMatch = trimmed.match(/^<!--IMG:(\d+)-->$/);
      if (imgMatch) {
        const imgIndex = parseInt(imgMatch[1]);
        const imgData = images[imgIndex];
        if (imgData) {
          const imageBlock = createImageBlock(imgData);
          if (imageBlock) {
            blocks.push(imageBlock);
            stats.image++;
          }
        }
        continue;
      }

      const protectedParagraphMatch = trimmed.match(/^@@MOWEN_PRESERVE_PARAGRAPH_(\d+)@@$/);
      if (protectedParagraphMatch) {
        const protectedParagraphIndex = parseInt(protectedParagraphMatch[1], 10);
        const protectedParagraph = protectedInlineParagraphs[protectedParagraphIndex];
        if (protectedParagraph) {
          appendPreservedInlineParagraphBlock(blocks, stats, protectedParagraph.content);
        }
        continue;
      }

      // Check for quote placeholder
      const quoteMatch = trimmed.match(/^<!--QUOTE:(\d+)-->$/);
      if (quoteMatch) {
        const quoteIndex = parseInt(quoteMatch[1]);
        const quoteData = quoteBlocks[quoteIndex];
        if (quoteData) {
          // Preserve line breaks inside blockquote content
          // Split by <br>, <p>, and newlines to maintain structure
          let quoteContent = quoteData.content;

          // Normalize various line break patterns to a consistent marker
          quoteContent = quoteContent
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
            .replace(/<\/div>\s*<div[^>]*>/gi, '\n')
            .replace(/<\/?(?:p|div)[^>]*>/gi, '\n')
            .replace(/\n\s*\n/g, '\n'); // Collapse multiple newlines

          // Split into lines and process each
          const lines = quoteContent.split('\n').filter(line => line.trim());

          if (lines.length > 0) {
            // Build content array with text nodes and explicit newlines
            const quoteContentNodes: NoteAtom[] = [];

            for (let i = 0; i < lines.length; i++) {
              const lineContent = parseInlineContent(lines[i].trim());
              if (lineContent.length > 0) {
                quoteContentNodes.push(...lineContent);
                // Add newline after each line except the last
                if (i < lines.length - 1) {
                  quoteContentNodes.push({ type: 'text', text: '\n' });
                }
              }
            }

            if (quoteContentNodes.length > 0) {
              blocks.push({ type: 'quote', content: quoteContentNodes });
              stats.quote++;
            }
          }
        }
        continue;
      }

      // Check for code placeholder
      const codeMatch = trimmed.match(/^@@MOWEN_CODE_BLOCK_(\d+)@@$/);
      if (codeMatch) {
        const codeIndex = parseInt(codeMatch[1]);
        const codeData = codeBlocks[codeIndex];
        if (codeData) {
          // 保留换行，仅解码 HTML 实体
          let codeText = codeData.content;

          // 移除 HTML 标签但保留换行
          codeText = codeText
            .replace(/<br\s*\/?>/gi, '\n')  // 将 <br> 转为换行
            .replace(/<[^>]+>/g, '')         // 移除其他 HTML 标签
            .replace(/&lt;/g, '<')           // 解码常见实体
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .trim();

          if (codeText) {
            // 即便未识别语言，也保留为代码块，默认使用 text。
            blocks.push({
              type: 'codeblock',
              attrs: { language: codeData.language || 'text' },
              content: [{ type: 'text', text: codeText }]
            });
            stats.code++;
          }
        }
        continue;
      }

      // Check if segment contains image placeholder mixed with text
      // Handle image + text split logic
      if (trimmed.includes('<!--IMG:')) {
        const parts = trimmed.split(/(<!--IMG:\d+-->)/);
        for (const part of parts) {
          const partTrimmed = part.trim();
          if (!partTrimmed) continue;

          const pImgMatch = partTrimmed.match(/^<!--IMG:(\d+)-->$/);
          if (pImgMatch) {
            const imgIndex = parseInt(pImgMatch[1]);
            const imgData = images[imgIndex];
            if (imgData) {
              const imageBlock = createImageBlock(imgData);
              if (imageBlock) {
                blocks.push(imageBlock);
                stats.image++;
              }
            }
          } else {
            // Process text part
            // Check if this text looks like a continuation or a new paragraph
            // For now, we add it as a paragraph, but we should make sure we don't add empty ones
            // if the text is just a spacer.
            appendParagraphBlocks(blocks, stats, partTrimmed, options);
          }
        }
        continue;
      }

      // Regular paragraph (potentially containing EMPTY_LINE)
      const parts = trimmed.split('<!--EMPTY_LINE-->');

      // Process all parts, including empty ones to preserve empty lines
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const partTrimmed = part.trim();

        if (!partTrimmed) {
          // Empty part -> Create Empty Paragraph (preserves blank lines)
          // Only create empty paragraph if this is between content (not at end unless there was content before)
          if (index < parts.length - 1 || (index > 0 && parts.slice(0, index).some(p => p.trim()))) {
            blocks.push({ type: 'paragraph' }); // No content field for empty paragraph per API spec
            stats.paragraph++;
          }
        } else {
          // Non-empty part -> Parse Content
          appendParagraphBlocks(blocks, stats, partTrimmed, options);
        }
      }
    }
  } // 结束 for (const segment of segments)

  // 7. Post-process blocks for better layout (styles, splitting, empty lines)
  return postProcessBlocks(blocks);
}

/**
 * Post-process blocks to enhance layout:
 * 1. Identify headings (pattern based)
 * 2. Format meta info (convert quote to paragraph)
 * 3. Split paragraphs on keywords
 * 4. Insert smart empty lines
 */
function postProcessBlocks(blocks: NoteAtom[]): NoteAtom[] {
  const result: NoteAtom[] = [];

  for (let i = 0; i < blocks.length; i++) {
    let block = blocks[i];

    // Rule 2: Meta Info - Convert specific quote to paragraph
    if (block.type === 'quote' && block.content && block.content.length > 0) {
      const text = getTextFromAtom(block);
      if (text.includes('来源：') || text.includes('作者/公众号：')) {
        // Convert to paragraph
        // Check for links in content and preserve them
        block = {
          type: 'paragraph',
          content: block.content
        };
      }
    }

    // Rule 4: Split paragraphs on keywords (Force Split)
    // Keywords: "提示词：", "适用：", "——", "一、", "二、" ...
    if (block.type === 'paragraph' && block.content) {
      const splitBlocks = splitParagraphByKeywords(block);
      if (splitBlocks.length > 1) {
        // Process the split blocks (recursion not needed as logic is flat)
        // Add them to result with potential empty lines processing (handled after loop or in-loop?)
        // Let's add them to processing queue or handle immediately?
        // Simpler: just push all split blocks to a temp list and let the main loop continue? 
        // No, we need to replace current block with multiple blocks.
        // Let's iterate over the split blocks as if they were original blocks.
        for (const splitBlock of splitBlocks) {
          processSingleBlock(splitBlock, result);
        }
        continue;
      }
    }

    processSingleBlock(block, result);
  }

  // Deduplicate consecutive empty paragraphs - keep only one
  // Also filter out unwanted social media content
  return filterAndDeduplicateBlocks(result);
}

/**
 * Helper function to check if a block is an empty paragraph
 */
function isEmptyParagraph(block: NoteAtom): boolean {
  return block.type === 'paragraph' && (!block.content || block.content.length === 0);
}

/**
 * 这些块在墨问里本身就有明显的块级样式，不需要额外空段落撑开间距。
 */
function isSelfSpacedBlock(block: NoteAtom | undefined): boolean {
  if (!block) {
    return false;
  }

  return (
    block.type === 'quote' ||
    block.type === 'codeblock' ||
    block.type === 'image' ||
    block.type === 'note' ||
    block.type === 'file'
  );
}

/**
 * Collapse consecutive empty paragraphs into a single one
 * Also filter out unwanted social media metadata content
 */
function filterAndDeduplicateBlocks(blocks: NoteAtom[]): NoteAtom[] {
  const filtered: NoteAtom[] = [];

  // Patterns to filter out (social media metadata) - but NOT bullet-only content
  const unwantedPatterns = [
    /^订阅$/,
    /^点击\s*订阅\s*到/,
    /^Subscribe$/i,
    /^Click.*subscribe/i,
    /^Follow$/i,
    /^\d+\.\s*$/,  // Number-only list items (no content)
  ];

  // Patterns that indicate a bullet prefix to merge with next paragraph
  const bulletPatterns = [
    /^•\s*$/,  // Bullet-only content
    /^·\s*$/,  // Alternative bullet
    /^[-–—]\s*$/,  // Dash-only
  ];

  let pendingBullet: string | null = null;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Check if this block should be filtered
    if (block.type === 'paragraph' && block.content) {
      const text = getTextFromAtom(block).trim();

      // Skip if matches unwanted patterns
      const shouldFilter = unwantedPatterns.some(pattern => pattern.test(text));
      if (shouldFilter) {
        continue;
      }

      // Check if this is a bullet-only paragraph
      const isBulletOnly = bulletPatterns.some(pattern => pattern.test(text));
      if (isBulletOnly) {
        // Save the bullet prefix and skip this paragraph
        pendingBullet = text.replace(/\s*$/, ' '); // Normalize to "• "
        continue;
      }

      // If we have a pending bullet, prepend it to this paragraph
      if (pendingBullet && block.content && block.content.length > 0) {
        const firstNode = block.content[0];
        if (firstNode.type === 'text' && firstNode.text) {
          firstNode.text = pendingBullet + firstNode.text;
        } else {
          // Insert a new text node with the bullet
          block.content.unshift({ type: 'text', text: pendingBullet });
        }
        pendingBullet = null;
      }
    }

    // Reset pending bullet if we encounter non-paragraph block
    if (block.type !== 'paragraph') {
      pendingBullet = null;
    }

    const lastBlock = filtered[filtered.length - 1];

    // If current and previous are both empty paragraphs, skip current
    if (isEmptyParagraph(block) && lastBlock && isEmptyParagraph(lastBlock)) {
      continue; // Skip duplicate empty paragraph
    }

    // Remove empty paragraph if adjacent to structural blocks that already carry spacing.
    // Preserve empty paragraphs only between text paragraphs.
    if (isEmptyParagraph(block)) {
      const isAfterSelfSpacedBlock = isSelfSpacedBlock(lastBlock);

      // Check if next NON-EMPTY block is a self-spaced block (look-ahead)
      // We need to find the next block that will actually be in the output
      let nextRealBlock: NoteAtom | undefined;
      for (let j = i + 1; j < blocks.length; j++) {
        if (!isEmptyParagraph(blocks[j])) {
          nextRealBlock = blocks[j];
          break;
        }
      }
      const isBeforeSelfSpacedBlock = isSelfSpacedBlock(nextRealBlock);

      if (isAfterSelfSpacedBlock || isBeforeSelfSpacedBlock) {
        continue; // Skip placeholder-derived spacers around structural blocks
      }
    }

    // 【新增】Caption 去重逻辑
    // 如果上一块是图片且带有 Alt，当前块是文本段落且内容与 Alt 相同，说明该段落是 Caption 的来源，应删除避免重复显示。
    if (block.type === 'paragraph' && lastBlock && lastBlock.type === 'image') {
      const altText = String(lastBlock.attrs?.alt || '').trim();
      if (altText) {
        // Normalize: remove punctuation and whitespace for loose comparison
        const normalize = (s: string) => s.replace(/[.,;!。，；！\s]/g, '').toLowerCase();
        const currentText = getTextFromAtom(block).trim();

        if (currentText) {
          const normAlt = normalize(altText);
          const normCurr = normalize(currentText);

          // Keep if not similar. Filter if similar.
          // Allow containment (e.g. caption extracted is substring of paragraph)
          if (normAlt === normCurr || normCurr.includes(normAlt) || normAlt.includes(normCurr)) {
            // console.log('[noteAtom] Removing duplicate caption paragraph:', currentText);
            continue;
          }
        }
      }
    }

    filtered.push(block);
  }

  // Remove leading empty paragraphs
  while (filtered.length > 0 && isEmptyParagraph(filtered[0])) {
    filtered.shift();
  }

  // Remove trailing empty paragraphs
  while (filtered.length > 0 && isEmptyParagraph(filtered[filtered.length - 1])) {
    filtered.pop();
  }

  return filtered;
}

/**
 * Process a single block and apply formatting/empty line rules
 */
function processSingleBlock(block: NoteAtom, result: NoteAtom[]) {
  // Apply formatting (Heading detection)
  if (block.type === 'paragraph') {
    const text = getTextFromAtom(block).trim();

    // Rule 1 & 4 (Heading patterns): "一、", "二、", "16 个..." (Title-like?), "5 个..."
    // Heuristic: Short lines starting with number patterns or specific chars
    const isHeadingPattern = /^(一|二|三|四|五|六|七|八|九|十|\d+)(\.|、|\s)/.test(text) ||
      text.length < 30 && /^(提示词|适用|核心问题)/.test(text);

    // Apply bold if heading pattern (and not already bold)
    if (isHeadingPattern && block.content) {
      // make whole paragraph bold, but avoid duplicate marks
      block.content = block.content.map(c => {
        if (c.type === 'text') {
          const existingMarks = c.marks || [];
          const hasBold = existingMarks.some(m => m.type === 'bold');
          if (hasBold) {
            return c; // Already bold, don't add again
          }
          return { ...c, marks: [...existingMarks, { type: 'bold' }] };
        }
        return c;
      });
    }
  }

  // Deduplicate marks in all text nodes before pushing
  if (block.content) {
    block.content = block.content.map(node => {
      if (node.type === 'text' && node.marks && node.marks.length > 0) {
        // Deduplicate marks by type
        const seenTypes = new Set<string>();
        const uniqueMarks: NoteAtomMark[] = [];
        for (const mark of node.marks) {
          if (!seenTypes.has(mark.type)) {
            seenTypes.add(mark.type);
            uniqueMarks.push(mark);
          }
        }
        return { ...node, marks: uniqueMarks.length > 0 ? uniqueMarks : undefined };
      }
      return node;
    });
  }

  result.push(block);
}

/**
 * Add an empty paragraph if the last block isn't one
 */


/**
 * Helper to get text from atom
 */
function getTextFromAtom(atom: NoteAtom): string {
  if (atom.type === 'text') return atom.text || '';
  if (atom.content) return atom.content.map(getTextFromAtom).join('');
  return '';
}

/**
 * Split paragraph content by keywords
 */
function splitParagraphByKeywords(block: NoteAtom): NoteAtom[] {
  if (!block.content) return [block];

  // We need to split the 'content' array based on text content boundaries.
  // This is tricky if keywords are split across nodes (unlikely for "提示词：" but possible).
  // Simplified approach: Re-construct text, find split indices, then rebuild nodes? Too complex.
  // approach: Iterate nodes, if text node contains keyword, split node and create new block.

  const blocks: NoteAtom[] = [];
  let currentContent: NoteAtom[] = [];

  // Keywords to split BEFORE (start new paragraph):
  // "提示词：", "适用："
  // Note: 移除了 '——' 因为破折号是正常标点，不应用于段落拆分
  const splitKeywordsList = ['提示词：', '适用：'];
  const splitRegex = new RegExp(`(${splitKeywordsList.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');

  for (const node of block.content) {
    if (node.type !== 'text' || !node.text) {
      currentContent.push(node);
      continue;
    }

    // Split text by regex
    const parts = node.text.split(splitRegex);

    // The split result will look like: ["Prefix", "Keyword", "Suffix", "Keyword", "Suffix"...] 
    // or ["", "Keyword", "Suffix"] if starts with keyword

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue; // Skip empty strings

      // If part is a keyword, it STARTS a new block
      if (splitKeywordsList.includes(part)) {
        if (currentContent.length > 0) {
          blocks.push({ type: 'paragraph', content: currentContent });
          currentContent = [];
        }
        // Start new content with this keyword text node
        // We need to preserve marks? The original node might have marks.
        // Assuming keyword splitting usually happens in plain text or we duplicate marks.
        currentContent.push({ ...node, text: part });
      } else {
        // Normal text, append to current content
        currentContent.push({ ...node, text: part });
      }
    }
  }

  if (currentContent.length > 0) {
    blocks.push({ type: 'paragraph', content: currentContent });
  }

  return blocks.length > 0 ? blocks : [block];
}


/**
 * Convert list items to paragraphs with prefixes
 */
function convertListItems(listHtml: string, ordered: boolean): string {
  let result = '';
  let itemIndex = 1;

  // Match each <li> and convert to paragraph with prefix
  const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = liRegex.exec(listHtml)) !== null) {
    let content = match[1];
    // Strip inner <p> tags to avoid extra block creation
    content = content.replace(/<\/?p[^>]*>/gi, '').trim();
    // Skip empty list items
    if (!content) continue;

    const prefix = ordered ? `${itemIndex}. ` : '• ';
    // Use compact format: no extra newlines between items
    result += `<p>${prefix}${content}</p>`;
    itemIndex++;
  }

  return result;
}

/**
 * Check if inline content has actual readable content  
 */
function hasRealContent(inline: NoteAtom[]): boolean {
  for (const node of inline) {
    if (node.type === 'text' && node.text) {
      const text = node.text.trim();
      if (text && text !== ' ' && !/^[\s\u00a0]+$/.test(text)) {
        return true;
      }
    }
  }
  return false;
}

function appendParagraphBlocks(
  blocks: NoteAtom[],
  stats: ConvertStats,
  html: string,
  options: HtmlToNoteAtomOptions = {}
): void {
  const inline = normalizeInlineTypography(parseInlineContent(html));
  if (inline.length === 0 || !hasRealContent(inline)) {
    return;
  }

  const paragraphSegments = splitParagraphInlineContent(inline, options);
  for (const content of paragraphSegments) {
    if (!hasRealContent(content)) {
      continue;
    }

    blocks.push({ type: 'paragraph', content });
    stats.paragraph++;
  }
}

function appendPreservedInlineParagraphBlock(
  blocks: NoteAtom[],
  stats: ConvertStats,
  html: string
): void {
  const inline = normalizeInlineTypography(parseInlineContent(html, { preserveLineBreaks: true }));
  if (inline.length === 0 || !hasRealContent(inline)) {
    return;
  }

  blocks.push({ type: 'paragraph', content: inline });
  stats.paragraph++;
}

function splitParagraphInlineContent(
  inline: NoteAtom[],
  options: HtmlToNoteAtomOptions = {}
): NoteAtom[][] {
  const text = inline
    .map((node) => (node.type === 'text' ? node.text || '' : ''))
    .join('');

  if (options.preserveInlineParagraphs || shouldPreserveInlineParagraph(text)) {
    return [inline];
  }

  const boundaries = findMixedLanguageSplitBoundaries(text);

  if (boundaries.length === 0) {
    return [inline];
  }

  const segments: NoteAtom[][] = [];
  let start = 0;
  const allBoundaries = [...boundaries, text.length];

  for (const end of allBoundaries) {
    const sliced = trimInlineBoundaryWhitespace(sliceInlineContentNodes(inline, start, end));
    if (sliced.length > 0) {
      segments.push(sliced);
    }
    start = end;
  }

  return segments.length > 1 ? segments : [inline];
}

function shouldPreserveInlineParagraph(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  // Preserve metadata rows such as source / quoted-article labels.
  // These rows often intentionally mix Chinese labels with English link titles
  // and should stay inline instead of being split into separate paragraphs.
  return /^([📄🔗]\s*)?(来源：|引用文章：)/.test(normalized);
}

function sliceInlineContentNodes(content: NoteAtom[], start: number, end: number): NoteAtom[] {
  const result: NoteAtom[] = [];
  let offset = 0;

  for (const node of content) {
    const text = node.type === 'text' ? node.text || '' : '';
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
      ...node,
      text: nextText,
      content: undefined,
      marks: node.marks ? [...node.marks] : undefined,
    });
  }

  return result;
}

function trimInlineBoundaryWhitespace(inline: NoteAtom[]): NoteAtom[] {
  const trimmed = inline.map((node) => ({
    ...node,
    marks: node.marks ? [...node.marks] : undefined,
    content: undefined,
  }));

  while (trimmed.length > 0) {
    const first = trimmed[0];
    if (first.type !== 'text' || !first.text) {
      break;
    }

    const nextText = first.text.replace(/^[\s\u00a0]+/, '');
    if (!nextText) {
      trimmed.shift();
      continue;
    }

    first.text = nextText;
    break;
  }

  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last.type !== 'text' || !last.text) {
      break;
    }

    const nextText = last.text.replace(/[\s\u00a0]+$/, '');
    if (!nextText) {
      trimmed.pop();
      continue;
    }

    last.text = nextText;
    break;
  }

  return trimmed;
}

function shouldPreserveOriginalTypography(text: string, marks?: NoteAtomMark[]): boolean {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return false;
  }

  const hasCodeMark = (marks || []).some((mark) => mark.type === 'code');
  if (hasCodeMark) {
    return true;
  }

  const hasLinkMark = (marks || []).some((mark) => mark.type === 'link');
  if (!hasLinkMark) {
    return false;
  }

  return /^https?:\/\//i.test(normalizedText) || /^www\./i.test(normalizedText);
}

function hasLinkMark(marks?: NoteAtomMark[]): boolean {
  return (marks || []).some((mark) => mark.type === 'link');
}

function normalizeInlineTypography(inline: NoteAtom[]): NoteAtom[] {
  const normalized = inline.map((node) => {
    if (node.type !== 'text' || !node.text) {
      return node;
    }

    return {
      ...node,
      text: shouldPreserveOriginalTypography(node.text, node.marks) ? node.text : stabilizeLatinHanLineBreaks(node.text),
      marks: node.marks ? [...node.marks] : undefined,
    };
  });

  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1];
    const current = normalized[index];

    if (
      previous.type === 'text' &&
      current.type === 'text' &&
      previous.text &&
      current.text
    ) {
      if (hasLinkMark(current.marks) && needsMetadataLabelWordJoiner(previous.text, current.text)) {
        previous.text = `${previous.text.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_WORD_JOINER}`;
        continue;
      }

      if (
        shouldPreserveOriginalTypography(previous.text, previous.marks) ||
        shouldPreserveOriginalTypography(current.text, current.marks)
      ) {
        continue;
      }

      if (needsHanLatinSpace(previous.text, current.text)) {
        previous.text = `${previous.text.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_NONBREAKING_GAP}`;
        continue;
      }

      if (needsLatinHanWordJoiner(previous.text, current.text)) {
        previous.text = `${previous.text.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_NONBREAKING_GAP}`;
      }
    }
  }

  return normalized;
}

/**
 * Parse inline content with marks (bold, italic, links, etc.)
 */
function parseInlineContent(
  html: string,
  options: { preserveLineBreaks?: boolean } = {}
): NoteAtom[] {
  const result: NoteAtom[] = [];
  const { preserveLineBreaks = false } = options;

  // Remove placeholders
  html = html.replace(/<!--(?:IMG|QUOTE):\d+-->|@@MOWEN_CODE_BLOCK_\d+@@/g, '');
  if (preserveLineBreaks) {
    html = html.replace(/<br\s*\/?>/gi, INLINE_BREAK_SENTINEL);
  }

  // Parse inline elements
  const inlineRegex = /<(strong|b|em|i|mark|a|code|span)(\s[^>]*)?>|<\/(strong|b|em|i|mark|a|code|span)>/gi;

  let lastIndex = 0;
  let currentMarks: NoteAtomMark[] = [];
  const markStack: Array<{ tagName: string; marks: NoteAtomMark[] }> = [];
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(html)) !== null) {
    // Add text before this tag
    if (match.index > lastIndex) {
      const text = preserveLineBreaks
        ? stripHtmlAndDecodePreserveLineBreaks(html.slice(lastIndex, match.index))
        : stripHtmlAndDecode(html.slice(lastIndex, match.index));
      if (text) {
        result.push(...createTextNodesWithAutoLinks(text, currentMarks));
      }
    }

    const fullTag = match[0].toLowerCase();

    if (fullTag.startsWith('</')) {
      // Closing tag - remove mark
      const tagName = (match[3] || '').toLowerCase();
      let realIndex = -1;
      for (let index = markStack.length - 1; index >= 0; index--) {
        if (markStack[index].tagName === tagName) {
          realIndex = index;
          break;
        }
      }

      if (realIndex !== -1) {
        const [entry] = markStack.splice(realIndex, 1);
        const marksToRemove = [...entry.marks];

        currentMarks = currentMarks.filter((mark) => {
          const markIndex = marksToRemove.indexOf(mark);
          if (markIndex === -1) {
            return true;
          }

          marksToRemove.splice(markIndex, 1);
          return false;
        });
      }
    } else {
      // Opening tag - add mark
      const tagName = (match[1] || '').toLowerCase();
      const attributes = match[2] || '';
      const nextMarks: NoteAtomMark[] = [];

      // Get semantic mark (from tag name)
      const semanticMarkType = getMarkType(tagName);
      if (semanticMarkType) {
        // Handle anchor tag special case
        if (tagName === 'a') {
          const hrefMatch = attributes.match(/href=["']([^"']*)["']/i);
          nextMarks.push({
            type: 'link',
            attrs: hrefMatch ? { href: hrefMatch[1] } : undefined
          });
        } else {
          nextMarks.push({ type: semanticMarkType });
        }
      }

      // Get style marks (from style attribute)
      // This works for span, p, div, etc if they pass through the regex (currently mostly span)
      const styleMarks = getStyleMarks(attributes);
      if (styleMarks.length > 0) {
        nextMarks.push(...styleMarks);
      }

      if (nextMarks.length > 0) {
        currentMarks = [...currentMarks, ...nextMarks];
      }

      markStack.push({ tagName, marks: nextMarks });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < html.length) {
    const text = preserveLineBreaks
      ? stripHtmlAndDecodePreserveLineBreaks(html.slice(lastIndex))
      : stripHtmlAndDecode(html.slice(lastIndex));
    if (text) {
      result.push(...createTextNodesWithAutoLinks(text, currentMarks));
    }
  }

  // Fallback: if no content extracted but there's text, do simple strip
  if (result.length === 0) {
    const plainText = preserveLineBreaks
      ? stripHtmlAndDecodePreserveLineBreaks(html)
      : stripHtmlAndDecode(html);
    if (plainText && plainText.trim()) {
      result.push(...createTextNodesWithAutoLinks(plainText, []));
    }
  }

  return result;
}

/**
 * Get mark type from HTML tag name
 */
function getMarkType(tagName: string): NoteAtomMark['type'] | null {
  switch (tagName) {
    case 'strong':
    case 'b':
      return 'bold';
    case 'em':
    case 'i':
      return 'italic';
    case 'mark':
      return 'highlight';
    case 'a':
      return 'link';
    case 'code':
      return 'code';
    default:
      return null;
  }
}

/**
 * Extract marks from style attribute
 */
function getStyleMarks(attributes: string): NoteAtomMark[] {
  const marks: NoteAtomMark[] = [];

  if (!attributes) return marks;

  const styleMatch = attributes.match(/style=["']([^"']*)["']/i);
  if (!styleMatch || !styleMatch[1]) return marks;

  const styleStr = styleMatch[1].toLowerCase();

  // Font Weight -> Bold
  // Matches: font-weight: bold, font-weight: 700, font-weight: 800, etc.
  if (
    /font-weight\s*:\s*(bold|[7-9]\d{2})/.test(styleStr)
  ) {
    marks.push({ type: 'bold' });
  }

  // Font Style -> Italic
  if (/font-style\s*:\s*italic/.test(styleStr)) {
    marks.push({ type: 'italic' });
  }

  // Text Decoration -> Underline/Strikethrough (Note: API only supports bold/italic/highlight/link/code)
  // Converting specific colors or backgrounds to highlight?
  // Common highlight colors (yellow, etc) could be mapped, but let's stick to safe defaults.
  // The user mainly complained about bolding.

  return marks;
}

/**
 * URL regex pattern for detecting plain URLs in text
 * Matches http:// and https:// URLs
 */
const URL_REGEX = /(https?:\/\/[^\s<>"')\]]+)/gi;

/**
 * Create text nodes with automatic URL linking
 * If text contains plain URLs, split into multiple nodes with link marks
 */
function createTextNodesWithAutoLinks(text: string, baseMarks: NoteAtomMark[]): NoteAtom[] {
  const result: NoteAtom[] = [];

  // Check if already inside a link, don't double-link
  const hasLinkMark = baseMarks.some(m => m.type === 'link');
  if (hasLinkMark) {
    // Already a link, just return single text node
    return [createTextNode(text, baseMarks)];
  }

  // Split text by URLs
  const parts = text.split(URL_REGEX);

  for (const part of parts) {
    if (!part) continue;

    // Check if this part is a URL
    if (URL_REGEX.test(part)) {
      // Reset regex lastIndex since we're using 'g' flag
      URL_REGEX.lastIndex = 0;

      // Create text node with link mark
      const linkMark: NoteAtomMark = {
        type: 'link',
        attrs: { href: part }
      };
      result.push(createTextNode(part, [...baseMarks, linkMark]));
    } else {
      // Regular text
      result.push(createTextNode(part, baseMarks));
    }
  }

  return result.length > 0 ? result : [createTextNode(text, baseMarks)];
}

/**
 * Create a text node with optional marks
 */
function createTextNode(text: string, marks: NoteAtomMark[]): NoteAtom {
  const shouldPreserveOriginalText = shouldPreserveOriginalTypography(text, marks);
  const node: NoteAtom = {
    type: 'text',
    text: shouldPreserveOriginalText ? text : stabilizeLatinHanLineBreaks(text)
  };

  if (marks.length > 0) {
    node.marks = [...marks];
  }

  return node;
}



/**
 * Create image block from image data
 * Returns null if image cannot be properly displayed (no UUID)
 * 
 * 注意：imgData.alt 现在传递的是可见的图片说明（如 figcaption），
 * 而非不可见的 HTML alt 属性。只有用户在网页上能看到的说明才会被传递过来。
 */
function createImageBlock(imgData: ImageData): NoteAtom | null {
  if (imgData.uuid) {
    return {
      type: 'image',
      attrs: {
        uuid: imgData.uuid,
        align: 'center',
        // 使用可见的图片说明（如 figcaption）
        ...(imgData.alt ? { alt: imgData.alt } : {})
      }
    };
  }

  if (!isSafeHttpImageUrl(imgData.src)) {
    console.warn('[noteAtom] Skipping image without UUID');
    return null;
  }

  return {
    type: 'paragraph',
    content: [{
      type: 'text',
      text: buildImageFallbackLabel(imgData.alt),
      marks: [{
        type: 'link',
        attrs: { href: imgData.src }
      }]
    }]
  };
}

function buildImageFallbackLabel(alt?: string): string {
  const normalizedAlt = alt?.trim();
  return normalizedAlt ? `查看原图：${normalizedAlt}` : '查看原图';
}

function isSafeHttpImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extract image data from img tag
 */
function extractImageData(imgTag: string): ImageData | null {
  const srcMatch = imgTag.match(/src=["']([^"']*)["']/i);
  const altMatch = imgTag.match(/alt=["']([^"']*)["']/i);
  const dataIdMatch = imgTag.match(/data-mowen-id=["']([^"']*)["']/i);
  const dataUidMatch = imgTag.match(/data-mowen-uid=["']([^"']*)["']/i);

  // Debug: Log raw img tag to see what attributes are present
  // console.log('[noteAtom] extractImageData raw tag:', imgTag.substring(0, 200));
  // console.log('[noteAtom] extractImageData matches:', {
  //   src: srcMatch?.[1]?.substring(0, 50),
  //   dataId: dataIdMatch?.[1],
  //   dataUid: dataUidMatch?.[1],
  // });

  if (!srcMatch || !srcMatch[1]) {
    return null;
  }

  let uuid = '';
  const uuidRegex = /^[a-zA-Z0-9_-]+$/;

  if (dataUidMatch?.[1] && uuidRegex.test(dataUidMatch[1])) {
    uuid = dataUidMatch[1];
  } else if (dataIdMatch?.[1] && uuidRegex.test(dataIdMatch[1])) {
    uuid = dataIdMatch[1];
  } else {
    const mowenCdnMatch = srcMatch[1].match(/(?:mowen\.cn|mw-assets)\/([a-zA-Z0-9_-]{10,})/);
    if (mowenCdnMatch) {
      uuid = mowenCdnMatch[1];
    }
  }

  // 优先使用提取到的 Caption 作为 alt
  // 如果有 data-mowen-caption，说明是算法提取的可见注释，优先级高于原始 alt
  let finalAlt = altMatch?.[1] || '';
  const dataCaptionMatch = imgTag.match(/data-mowen-caption=["']([^"']*)["']/i);
  if (dataCaptionMatch?.[1]) {
    // Decode HTML entities just in case
    finalAlt = decodeHtmlEntities(dataCaptionMatch[1]);
  }

  // 过滤无意义的默认 alt 值
  const meaninglessAltWords = ['图片', 'image', 'picture', 'photo', 'img', '视频', 'video', '动图', 'gif'];
  if (meaninglessAltWords.includes(finalAlt.trim().toLowerCase()) || meaninglessAltWords.includes(finalAlt.trim())) {
    finalAlt = '';
  }

  return {
    src: srcMatch[1],
    alt: finalAlt,
    uuid: uuid || undefined
  };
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtmlAndDecode(html: string): string {
  // Remove all HTML tags
  let text = html.replace(/<[^>]+>/g, '');
  // Decode entities
  text = decodeHtmlEntities(text);
  // Normalize whitespace (but preserve single spaces)
  text = text.replace(/[\t\r\n]+/g, ' ').replace(/  +/g, ' ');
  return text;
}

function stripHtmlAndDecodePreserveLineBreaks(html: string): string {
  let text = html.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  text = text.split(INLINE_BREAK_SENTINEL).join('\n');
  text = text.replace(/\r/g, '').replace(/\t/g, ' ');
  text = text.replace(/[ ]{2,}/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
    '&copy;': '©', '&reg;': '®', '&euro;': '€',
    '&pound;': '£', '&yen;': '¥', '&cent;': '¢',
    '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201c', '&rdquo;': '\u201d',
    '&bull;': '•', '&middot;': '·'
  };
  return text.replace(/&[a-zA-Z0-9#]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Ensure content is wrapped in doc node
 */
export function ensureDocWrapper(atom: NoteAtom): NoteAtom {
  if (atom.type === 'doc') return atom;
  return { type: 'doc', content: [atom] };
}

// ============================================
// NoteAtom JSON → HTML 反向转换（用于 PDF 导出）
// ============================================

/**
 * 墨问图片 CDN 基础地址
 */
const MOWEN_IMAGE_CDN = 'https://image.mowen.cn/mowen';

/**
 * HTML 特殊字符转义（防 XSS）
 */
function escapeHtmlForAtom(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 安全校验 URL：仅允许 http / https 协议
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getDirectFigureCaption(figure: HTMLElement): string {
  for (const child of Array.from(figure.children)) {
    if (child.tagName === 'FIGCAPTION') {
      return child.textContent?.trim() || '';
    }
  }
  return '';
}

function syncFigureCaption(figure: HTMLElement, doc: Document, caption: string): void {
  const figureChildren = Array.from(figure.children);
  for (const child of figureChildren) {
    if (child.tagName === 'FIGCAPTION') {
      figure.removeChild(child);
    }
  }

  if (!caption) return;

  const figcaption = doc.createElement('figcaption');
  figcaption.textContent = caption;
  figure.appendChild(figcaption);
}

function getImageCaption(image: HTMLImageElement): string {
  const attributeCandidates = [
    'caption',
    'data-caption',
    'data-mowen-caption',
    'image-caption',
    'title',
  ];

  for (const attributeName of attributeCandidates) {
    const value = image.getAttribute(attributeName)?.trim();
    if (value) {
      return value;
    }
  }

  const parent = image.parentElement;
  if (parent?.tagName === 'FIGURE') {
    return getDirectFigureCaption(parent);
  }

  return '';
}

function getMowenImageUuid(image: HTMLImageElement): string {
  return (
    image.getAttribute('uuid') ||
    image.getAttribute('image-uuid') ||
    image.getAttribute('data-mowen-uid') ||
    image.getAttribute('data-mowen-id') ||
    image.getAttribute('data-uuid') ||
    image.getAttribute('data-file-uuid') ||
    ''
  ).trim();
}

function normalizeUuidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function resolveMowenImageUrl(uuid: string, noteFile?: MowenNoteFileLike): string {
  const normalizedUuid = uuid.trim();
  const directImageInfo = noteFile?.images?.[normalizedUuid];
  const imageInfo = directImageInfo || Object.values(noteFile?.images || {}).find((asset) => {
    if (!asset) return false;
    return asset.fileUuid?.trim() === normalizedUuid || asset.uuid?.trim() === normalizedUuid;
  });
  const preferredUrl = imageInfo?.scale?.w_1200 || imageInfo?.url;

  if (preferredUrl && isSafeUrl(preferredUrl)) {
    return preferredUrl;
  }

  return `${MOWEN_IMAGE_CDN}/${normalizedUuid}`;
}

function createExportFigure(
  doc: Document,
  uuid: string,
  noteFile?: MowenNoteFileLike,
  caption = '',
  alt = '',
  variant: 'default' | 'gallery' = 'default'
): HTMLElement {
  const figure = doc.createElement('figure');
  const image = doc.createElement('img');
  const resolvedAlt = alt.trim();
  const resolvedCaption = caption.trim();
  const isGallery = variant === 'gallery';

  if (isGallery) {
    figure.className = 'mowen-gallery-figure';
  }

  image.setAttribute('src', resolveMowenImageUrl(uuid, noteFile));
  image.setAttribute('alt', resolvedAlt);
  image.setAttribute('crossorigin', 'anonymous');
  image.setAttribute('style', isGallery
    ? 'display:block;width:100%;max-width:100%;height:auto;margin:0;'
    : 'max-width:100%;height:auto;');
  image.setAttribute('data-mowen-uuid', uuid);
  if (isGallery) {
    image.className = 'mowen-gallery-image';
  }

  figure.appendChild(image);
  syncFigureCaption(figure, doc, resolvedCaption);

  return figure;
}

function normalizeMowenImages(
  root: HTMLElement,
  doc: Document,
  noteFile?: MowenNoteFileLike
): Set<string> {
  const renderedUuids = new Set<string>();
  const images = Array.from(root.querySelectorAll<HTMLImageElement>(
    'img[uuid], img[image-uuid], img[data-mowen-uid], img[data-mowen-id], img[data-uuid], img[data-file-uuid]'
  ));

  for (const image of images) {
    const uuid = getMowenImageUuid(image);
    if (!uuid) continue;

    renderedUuids.add(uuid);

    const alt = (image.getAttribute('alt') || '').trim();
    const caption = getImageCaption(image);
    const figureParent = image.parentElement?.tagName === 'FIGURE'
      ? image.parentElement as HTMLElement
      : null;

    const normalizedImage = doc.createElement('img');
    normalizedImage.setAttribute('src', resolveMowenImageUrl(uuid, noteFile));
    normalizedImage.setAttribute('alt', alt);
    normalizedImage.setAttribute('crossorigin', 'anonymous');
    normalizedImage.setAttribute('style', 'max-width:100%;height:auto;');
    normalizedImage.setAttribute('data-mowen-uuid', uuid);

    if (figureParent) {
      figureParent.replaceChild(normalizedImage, image);
      syncFigureCaption(figureParent, doc, caption);
      continue;
    }

    const figure = doc.createElement('figure');
    figure.appendChild(normalizedImage);
    syncFigureCaption(figure, doc, caption);
    image.replaceWith(figure);
  }

  return renderedUuids;
}

function normalizeQuoteParagraphs(root: HTMLElement, doc: Document): void {
  const quoteParagraphs = Array.from(root.querySelectorAll('p[type="quote"]'));

  for (const paragraph of quoteParagraphs) {
    const blockquote = doc.createElement('blockquote');
    const quoteParagraph = doc.createElement('p');

    while (paragraph.firstChild) {
      quoteParagraph.appendChild(paragraph.firstChild);
    }

    if (!quoteParagraph.hasChildNodes()) {
      quoteParagraph.appendChild(doc.createElement('br'));
    }

    blockquote.appendChild(quoteParagraph);
    paragraph.replaceWith(blockquote);
  }
}

function expandAttachImages(
  root: HTMLElement,
  doc: Document,
  noteFile?: MowenNoteFileLike,
  noteFileTree?: MowenNoteFileTreeLike,
  renderedUuids?: Set<string>
): void {
  const rendered = renderedUuids || new Set<string>();
  const attachedUuids = new Set<string>();
  const placeholders = Array.from(root.querySelectorAll('attach-img'));

  for (const placeholder of placeholders) {
    const uuidList = (placeholder.getAttribute('uuid-list') || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    const fragment = doc.createDocumentFragment();

    for (const uuid of uuidList) {
      if (attachedUuids.has(uuid)) continue;
      fragment.appendChild(createExportFigure(doc, uuid, noteFile));
      attachedUuids.add(uuid);
      rendered.add(uuid);
    }

    placeholder.replaceWith(fragment);
  }

  const trailingAttachImages = normalizeUuidList(noteFileTree?.imageAttach).filter(
    (uuid) => !rendered.has(uuid) && !attachedUuids.has(uuid)
  );

  if (trailingAttachImages.length === 0) return;

  for (const uuid of trailingAttachImages) {
    root.appendChild(createExportFigure(doc, uuid, noteFile));
    rendered.add(uuid);
  }
}

/**
 * 将 <gallery uuid="..."> 自定义标签展开为平铺的图片列表
 *
 * 墨问的画廊在 API 返回的 HTML 中表现为 <gallery uuid="xxx"></gallery>，
 * 对应的图片 UUID 列表在 noteGallery.gallerys[uuid].fileUuids 中，
 * 图片 URL 在 noteFile.images[fileUuid] 中。
 */
function expandGalleryElements(
  root: HTMLElement,
  doc: Document,
  noteFile?: MowenNoteFileLike,
  noteGallery?: MowenNoteGalleryLike,
  renderedUuids?: Set<string>
): void {
  const rendered = renderedUuids || new Set<string>();
  const galleryElements = Array.from(root.querySelectorAll('gallery'));

  if (galleryElements.length === 0) return;

  for (const galleryEl of galleryElements) {
    const galleryUuid = galleryEl.getAttribute('uuid')?.trim();
    if (!galleryUuid) {
      // 无 uuid 的画廊标签，直接移除
      galleryEl.remove();
      continue;
    }

    // 从 noteGallery 中获取该画廊包含的图片 UUID 列表
    const galleryData = noteGallery?.gallerys?.[galleryUuid];
    const fileUuids = galleryData?.fileUuids || [];

    if (fileUuids.length === 0) {
      // 画廊无图片数据，移除空标签
      galleryEl.remove();
      continue;
    }

    // 创建平铺容器
    const galleryContainer = doc.createElement('div');
    galleryContainer.className = 'mowen-gallery-stack';

    for (const fileUuid of fileUuids) {
      if (!fileUuid?.trim()) continue;
      const uuid = fileUuid.trim();

      // 跳过已渲染的图片（避免重复）
      if (rendered.has(uuid)) continue;

      galleryContainer.appendChild(createExportFigure(doc, uuid, noteFile, '', '', 'gallery'));
      rendered.add(uuid);
    }

    // 用平铺图片列表替换 <gallery> 标签
    if (galleryContainer.childElementCount === 0) {
      galleryEl.remove();
      continue;
    }

    galleryEl.replaceWith(galleryContainer);
  }
}

const MIXED_LANGUAGE_SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE']);
const MIXED_LANGUAGE_HARD_BOUNDARY_TAGS = new Set([
  'BR',
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'FIGURE',
  'FIGCAPTION',
  'TR',
  'TD',
  'TH',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'HR',
]);

function normalizeMixedLanguageTextNodes(
  node: Node,
  state: { previousTextNode: Text | null } = { previousTextNode: null }
): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const textNode = child as Text;
      const currentValue = textNode.nodeValue || '';
      const normalizedValue = stabilizeLatinHanLineBreaks(currentValue);

      if (normalizedValue !== currentValue) {
        textNode.nodeValue = normalizedValue;
      }

      if (state.previousTextNode?.nodeValue && textNode.nodeValue) {
        const isCurrentLinkText = Boolean(textNode.parentElement?.closest('a[href]'));

        if (isCurrentLinkText && needsMetadataLabelWordJoiner(state.previousTextNode.nodeValue, textNode.nodeValue)) {
          state.previousTextNode.nodeValue = `${state.previousTextNode.nodeValue.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_WORD_JOINER}`;
        } else if (needsHanLatinSpace(state.previousTextNode.nodeValue, textNode.nodeValue)) {
          state.previousTextNode.nodeValue = `${state.previousTextNode.nodeValue.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_NONBREAKING_GAP}`;
        } else if (needsLatinHanWordJoiner(state.previousTextNode.nodeValue, textNode.nodeValue)) {
          state.previousTextNode.nodeValue = `${state.previousTextNode.nodeValue.replace(/[ \t\u00a0\u2060]+$/g, '')}${MIXED_LANGUAGE_NONBREAKING_GAP}`;
        }
      }

      state.previousTextNode = textNode;
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as HTMLElement;
    if (MIXED_LANGUAGE_SKIP_TAGS.has(element.tagName)) {
      state.previousTextNode = null;
      continue;
    }

    const isHardBoundary = MIXED_LANGUAGE_HARD_BOUNDARY_TAGS.has(element.tagName);
    if (isHardBoundary) {
      state.previousTextNode = null;
    }

    normalizeMixedLanguageTextNodes(element, state);

    if (isHardBoundary) {
      state.previousTextNode = null;
    }
  }
}

export function normalizeMowenHtmlForExport(
  html: string,
  options: NormalizeMowenHtmlOptions = {}
): string {
  if (!html || typeof DOMParser === 'undefined') {
    return html;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div data-mowen-export-root="true">${html}</div>`,
    'text/html'
  );
  const root = doc.body.firstElementChild as HTMLElement | null;

  if (!root) {
    return html;
  }

  normalizeQuoteParagraphs(root, doc);
  const renderedUuids = normalizeMowenImages(root, doc, options.noteFile);
  expandAttachImages(root, doc, options.noteFile, options.noteFileTree, renderedUuids);
  expandGalleryElements(root, doc, options.noteFile, options.noteGallery, renderedUuids);
  normalizeMixedLanguageTextNodes(root);

  return root.innerHTML;
}

/**
 * 将 marks 数组转换为 HTML 开标签 + 闭标签对
 * 返回 [openTags, closeTags]
 */
function marksToHtml(marks?: NoteAtomMark[]): [string, string] {
  if (!marks || marks.length === 0) return ['', ''];

  let open = '';
  let close = '';

  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        open += '<strong>';
        close = '</strong>' + close;
        break;
      case 'italic':
        open += '<em>';
        close = '</em>' + close;
        break;
      case 'highlight':
        open += '<mark>';
        close = '</mark>' + close;
        break;
      case 'code':
        open += '<code>';
        close = '</code>' + close;
        break;
      case 'link': {
        const href = mark.attrs?.href || '';
        if (href && isSafeUrl(href)) {
          open += `<a href="${escapeHtmlForAtom(href)}" target="_blank" rel="noopener noreferrer">`;
        } else {
          open += '<a>';
        }
        close = '</a>' + close;
        break;
      }
    }
  }

  return [open, close];
}

/**
 * 将单个 NoteAtom 节点转换为 HTML 字符串（递归）
 */
function atomNodeToHtml(node: NoteAtom, options: NoteAtomToHtmlOptions = {}): string {
  switch (node.type) {
    case 'doc':
      // 根节点：递归渲染所有子节点
      return (node.content || []).map(child => atomNodeToHtml(child, options)).join('\n');

    case 'paragraph': {
      // 段落节点
      if (!node.content || node.content.length === 0) {
        // 空段落 → 空行
        return '<p><br></p>';
      }
      const inner = node.content.map(child => atomNodeToHtml(child, options)).join('');
      return `<p>${inner}</p>`;
    }

    case 'text': {
      // 文本节点，处理 marks
      const text = escapeHtmlForAtom(node.text || '');
      // 保留换行符，转换为 <br>
      const htmlText = text.replace(/\n/g, '<br>');
      const [open, close] = marksToHtml(node.marks);
      return `${open}${htmlText}${close}`;
    }

    case 'quote': {
      // 引用块
      if (!node.content || node.content.length === 0) {
        return '<blockquote><p></p></blockquote>';
      }
      // 引用块的 content 可能直接是 text 节点（而非 paragraph 包裹）
      // 需要判断并适当包裹
      const hasBlockChildren = node.content.some(
        c => c.type === 'paragraph' || c.type === 'quote'
      );
      if (hasBlockChildren) {
        const inner = node.content.map(child => atomNodeToHtml(child, options)).join('\n');
        return `<blockquote>${inner}</blockquote>`;
      } else {
        // 直接是 text 节点，包裹在 <p> 中
        const inner = node.content.map(child => atomNodeToHtml(child, options)).join('');
        return `<blockquote><p>${inner}</p></blockquote>`;
      }
    }

    case 'codeblock': {
      // 代码块节点：渲染为 <pre><code> 并附带语言 class
      const lang = String(node.attrs?.language || 'text');
      const codeText = node.content
        ? node.content.map(c => escapeHtmlForAtom(c.text || '')).join('')
        : '';
      return `<pre><code class="language-${escapeHtmlForAtom(lang)}">${codeText}</code></pre>`;
    }

    case 'image': {
      // 图片节点：UUID → CDN URL
      const uuid = node.attrs?.uuid as string;
      if (!uuid) return '';
      const alt = escapeHtmlForAtom(String(node.attrs?.alt || ''));
      const src = options.resolveImageUrl?.(uuid) || resolveMowenImageUrl(uuid);
      // crossorigin="anonymous" 确保 html2canvas 能跨域渲染图片
      if (alt) {
        return `<figure><img src="${escapeHtmlForAtom(src)}" alt="${alt}" crossorigin="anonymous" style="max-width:100%;height:auto;" /><figcaption>${alt}</figcaption></figure>`;
      }
      return `<figure><img src="${escapeHtmlForAtom(src)}" alt="" crossorigin="anonymous" style="max-width:100%;height:auto;" /></figure>`;
    }

    case 'note': {
      // 内链笔记节点
      const noteUuid = node.attrs?.uuid as string;
      if (!noteUuid) return '';
      const noteTitle = node.content
        ? node.content.map(c => c.text || '').join('')
        : '查看笔记';
      return `<note uuid="${escapeHtmlForAtom(noteUuid)}">${escapeHtmlForAtom(noteTitle)}</note>`;
    }

    case 'audio':
    case 'pdf': {
      // 音频/PDF 节点：导出为占位提示
      const fileUuid = node.attrs?.uuid as string;
      const typeLabel = node.type === 'audio' ? '🎵 音频文件' : '📎 PDF 文件';
      return `<p>${typeLabel}${fileUuid ? ` (${escapeHtmlForAtom(String(fileUuid))})` : ''}</p>`;
    }

    default:
      // 未知节点类型：尝试递归子内容，或跳过
      if (node.content && node.content.length > 0) {
        return node.content.map(child => atomNodeToHtml(child, options)).join('');
      }
      return '';
  }
}

/**
 * 将 NoteAtom JSON 结构转换为标准 HTML
 *
 * 用于 PDF 导出场景：show API 返回的 content 可能是 NoteAtom JSON，
 * 需要先转换为浏览器可渲染的 HTML 再交给 html2pdf.js。
 *
 * @param atom NoteAtom 根节点（type: 'doc'）
 * @returns 标准 HTML 字符串
 */
export function noteAtomToHtml(atom: NoteAtom, options: NoteAtomToHtmlOptions = {}): string {
  return atomNodeToHtml(atom, options);
}

/**
 * 检测字符串是否为 NoteAtom JSON 格式
 *
 * 判断条件：
 * 1. 字符串能被 JSON.parse 解析
 * 2. 解析后的对象顶层 type === 'doc'
 * 3. 存在 content 数组
 *
 * @param content 原始内容字符串
 * @returns 如果是 NoteAtom JSON 返回解析后的对象，否则返回 null
 */
export function parseNoteAtomJson(content: string): NoteAtom | null {
  // 快速预检：NoteAtom JSON 必须以 { 开头
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'doc' &&
      Array.isArray(parsed.content)
    ) {
      return parsed as NoteAtom;
    }
  } catch {
    // JSON.parse 失败说明不是 JSON，是 HTML
  }

  return null;
}
