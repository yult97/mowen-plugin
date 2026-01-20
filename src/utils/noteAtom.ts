/**
 * HTML to NoteAtom Converter (Block-Aware)
 * 
 * Key improvements:
 * 1. Block-level first: Parse HTML by block boundaries (p, div, section, li, etc.)
 * 2. Preserve paragraph structure: Each block element = one paragraph node
 * 3. Support lists: ul/ol → paragraphs with bullet/number prefix
 * 4. Support code blocks: pre/code → paragraph with ``` wrapper
 * 5. Structure summary logging for debugging
 * 
 * NoteAtom supported types (per official API):
 * - doc (root)
 * - paragraph (main content)
 * - quote (blockquote)
 * - image (with uuid)
 * 
 * Marks: bold, italic, highlight, link, code
 */

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

// Block-level tags are handled inline in parseBlockContent

/**
 * Main conversion function
 */
export function htmlToNoteAtom(html: string): NoteAtom {
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
    console.log('[noteAtom] Starting block-aware conversion, input length:', html.length);

    // 检查输入 HTML 是否包含 blockquote
    const blockquoteCount = (html.match(/<blockquote/gi) || []).length;
    console.log(`[noteAtom] 🔍 输入 HTML 包含 ${blockquoteCount} 个 <blockquote> 标签`);
    if (blockquoteCount > 0) {
      const blockquoteMatch = html.match(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/i);
      if (blockquoteMatch) {
        console.log(`[noteAtom] 📋 第一个 blockquote 内容预览: "${blockquoteMatch[0].substring(0, 200)}..."`);
      }
    }

    // 1. Clean script/style/comments
    let processed = html
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
    const blocks = parseBlockContent(processed, images, stats);

    // 4. Log structure summary
    stats.total = blocks.length;
    const first10Types = blocks.slice(0, 10).map(b => b.type).join(', ');
    console.log(`[convert] source=${stats.source}`);
    console.log(`[convert] blocks_total=${stats.total}, paragraph=${stats.paragraph}, quote=${stats.quote}, image=${stats.image}, list=${stats.list}, code=${stats.code}`);
    console.log(`[convert] first10Types=${first10Types}`);

    // 5. Ensure at least one block
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
function parseBlockContent(html: string, images: ImageData[], stats: ConvertStats): NoteAtom[] {
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

  // 调试日志：打印识别到的 blockquote 数量
  if (quoteBlocks.length > 0) {
    console.log(`[noteAtom] 🔍 识别到 ${quoteBlocks.length} 个 blockquote 块`);
    quoteBlocks.forEach((q, i) => {
      console.log(`[noteAtom] 📋 blockquote #${i + 1} 内容预览: ${q.content.substring(0, 100)}...`);
    });
  }

  // 3. Handle code blocks (pre/code)
  const codeBlocks: Array<{ placeholder: string; content: string }> = [];
  normalized = normalized.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const placeholder = `<!--CODE:${codeBlocks.length}-->`;
    // Strip inner <code> tag if present
    const codeContent = content.replace(/<\/?code[^>]*>/gi, '');
    codeBlocks.push({ placeholder, content: codeContent });
    return `\n${placeholder}\n`;
  });

  // 4. Handle lists (convert to individual paragraphs with prefixes)
  normalized = normalized.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, content) => {
    return convertListItems(content, false);
  });
  normalized = normalized.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, content) => {
    return convertListItems(content, true);
  });

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
    .replace(/(<!--CODE:\d+-->)/g, '\n$1\n')
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

      // Check for quote placeholder
      const quoteMatch = trimmed.match(/^<!--QUOTE:(\d+)-->$/);
      if (quoteMatch) {
        const quoteIndex = parseInt(quoteMatch[1]);
        const quoteData = quoteBlocks[quoteIndex];
        if (quoteData) {
          // Preserve line breaks inside blockquote content
          // Split by <br>, <p>, and newlines to maintain structure
          let quoteContent = quoteData.content;

          console.log(`[noteAtom] 🔍 处理引用块原始内容: "${quoteContent.substring(0, 200)}..."`);

          // Normalize various line break patterns to a consistent marker
          quoteContent = quoteContent
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
            .replace(/<\/div>\s*<div[^>]*>/gi, '\n')
            .replace(/<\/?(?:p|div)[^>]*>/gi, '\n')
            .replace(/\n\s*\n/g, '\n'); // Collapse multiple newlines

          console.log(`[noteAtom] 🔍 引用块换行处理后: "${quoteContent.substring(0, 200)}..."`);

          // Split into lines and process each
          const lines = quoteContent.split('\n').filter(line => line.trim());

          console.log(`[noteAtom] 🔍 引用块分割后行数: ${lines.length}, 行内容: ${JSON.stringify(lines.slice(0, 3))}`);

          if (lines.length > 0) {
            // Build content array with text nodes and explicit newlines
            const quoteContentNodes: NoteAtom[] = [];

            for (let i = 0; i < lines.length; i++) {
              const lineContent = parseInlineContent(lines[i].trim());
              console.log(`[noteAtom] 🔍 引用块第 ${i + 1} 行 parseInlineContent 结果: ${JSON.stringify(lineContent).substring(0, 150)}`);
              if (lineContent.length > 0) {
                quoteContentNodes.push(...lineContent);
                // Add newline after each line except the last
                if (i < lines.length - 1) {
                  quoteContentNodes.push({ type: 'text', text: '\n' });
                }
              }
            }

            console.log(`[noteAtom] 🔍 引用块最终节点数: ${quoteContentNodes.length}`);

            if (quoteContentNodes.length > 0) {
              blocks.push({ type: 'quote', content: quoteContentNodes });
              stats.quote++;
            } else {
              console.log(`[noteAtom] ⚠️ 引用块内容为空，跳过创建 quote 节点`);
            }
          } else {
            console.log(`[noteAtom] ⚠️ 引用块分割后无有效行，跳过创建 quote 节点`);
          }
        }
        continue;
      }

      // Check for code placeholder
      const codeMatch = trimmed.match(/^<!--CODE:(\d+)-->$/);
      if (codeMatch) {
        const codeIndex = parseInt(codeMatch[1]);
        const codeData = codeBlocks[codeIndex];
        if (codeData) {
          // Create code block as quote for better visual presentation
          // Preserve line breaks by only decoding HTML entities, not stripping newlines
          let codeText = codeData.content;

          // Remove HTML tags but preserve newlines
          codeText = codeText
            .replace(/<br\s*\/?>/gi, '\n')  // Convert <br> to newline
            .replace(/<[^>]+>/g, '')         // Remove other HTML tags
            .replace(/&lt;/g, '<')           // Decode common entities
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .trim();

          if (codeText) {
            blocks.push({
              type: 'quote',
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
            const inline = parseInlineContent(partTrimmed);
            if (inline.length > 0 && hasRealContent(inline)) {
              blocks.push({ type: 'paragraph', content: inline });
              stats.paragraph++;
            }
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
          const inline = parseInlineContent(partTrimmed);
          if (inline.length > 0) {
            blocks.push({ type: 'paragraph', content: inline });
            stats.paragraph++;
          }
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

    // Remove empty paragraph if adjacent to IMAGE blocks
    // But preserve empty paragraphs between text paragraphs (normal spacing)
    if (isEmptyParagraph(block)) {
      // Check if previous block is an image
      const isAfterImage = lastBlock && lastBlock.type === 'image';

      // Check if next NON-EMPTY block is an image (look-ahead)
      // We need to find the next block that will actually be in the output
      let nextRealBlock: NoteAtom | undefined;
      for (let j = i + 1; j < blocks.length; j++) {
        if (!isEmptyParagraph(blocks[j])) {
          nextRealBlock = blocks[j];
          break;
        }
      }
      const isBeforeImage = nextRealBlock && nextRealBlock.type === 'image';

      if (isAfterImage || isBeforeImage) {
        continue; // Skip empty spacer adjacent to images
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
      /^——/.test(text) ||
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
  // "提示词：", "适用：", "——"
  // We use a regex to split the text content, keeping the delimiters.
  const splitKeywordsList = ['提示词：', '适用：', '——'];
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

/**
 * Parse inline content with marks (bold, italic, links, etc.)
 */
function parseInlineContent(html: string): NoteAtom[] {
  const result: NoteAtom[] = [];

  // Remove placeholders
  html = html.replace(/<!--(?:IMG|QUOTE|CODE):\d+-->/g, '');

  // Parse inline elements
  const inlineRegex = /<(strong|b|em|i|mark|a|code|span)(\s[^>]*)?>|<\/(strong|b|em|i|mark|a|code|span)>/gi;

  let lastIndex = 0;
  let currentMarks: NoteAtomMark[] = [];
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(html)) !== null) {
    // Add text before this tag
    if (match.index > lastIndex) {
      const text = stripHtmlAndDecode(html.slice(lastIndex, match.index));
      if (text) {
        result.push(...createTextNodesWithAutoLinks(text, currentMarks));
      }
    }

    const fullTag = match[0].toLowerCase();

    if (fullTag.startsWith('</')) {
      // Closing tag - remove mark
      const tagName = (match[3] || '').toLowerCase();
      const markType = getMarkType(tagName);
      if (markType) {
        currentMarks = currentMarks.filter(m => m.type !== markType);
      }
    } else {
      // Opening tag - add mark
      const tagName = (match[1] || '').toLowerCase();
      const attributes = match[2] || '';

      // Get semantic mark (from tag name)
      const semanticMarkType = getMarkType(tagName);
      if (semanticMarkType) {
        // Handle anchor tag special case
        if (tagName === 'a') {
          const hrefMatch = attributes.match(/href=["']([^"']*)["']/i);
          currentMarks = [...currentMarks, {
            type: 'link',
            attrs: hrefMatch ? { href: hrefMatch[1] } : undefined
          }];
        } else {
          currentMarks = [...currentMarks, { type: semanticMarkType }];
        }
      }

      // Get style marks (from style attribute)
      // This works for span, p, div, etc if they pass through the regex (currently mostly span)
      const styleMarks = getStyleMarks(attributes);
      if (styleMarks.length > 0) {
        currentMarks = [...currentMarks, ...styleMarks];
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < html.length) {
    const text = stripHtmlAndDecode(html.slice(lastIndex));
    if (text) {
      result.push(...createTextNodesWithAutoLinks(text, currentMarks));
    }
  }

  // Fallback: if no content extracted but there's text, do simple strip
  if (result.length === 0) {
    const plainText = stripHtmlAndDecode(html);
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
  const node: NoteAtom = {
    type: 'text',
    text: text
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
  } else {
    // No UUID means image upload failed - skip this image entirely
    // User preference: do not show images as links
    console.warn('[noteAtom] Skipping image without UUID:', imgData.src?.substring(0, 60));
    return null;
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
    console.log('[noteAtom] extractImageData using data-mowen-uid:', uuid);
  } else if (dataIdMatch?.[1] && uuidRegex.test(dataIdMatch[1])) {
    uuid = dataIdMatch[1];
    console.log('[noteAtom] extractImageData using data-mowen-id:', uuid);
  } else {
    const mowenCdnMatch = srcMatch[1].match(/(?:mowen\.cn|mw-assets)\/([a-zA-Z0-9_-]{10,})/);
    if (mowenCdnMatch) {
      uuid = mowenCdnMatch[1];
      console.log('[noteAtom] extractImageData using CDN UUID:', uuid);
    } else {
      console.log('[noteAtom] extractImageData NO UUID found for:', srcMatch[1].substring(0, 50));
    }
  }

  return {
    src: srcMatch[1],
    alt: altMatch?.[1] || '',
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
