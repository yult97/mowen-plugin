/**
 * HTML to NoteAtom Converter for Node.js (MCP Server)
 * Converts HTML content to Mowen's NoteAtom format (ProseMirror-compatible)
 */

interface NoteAtom {
  type?: string;
  text?: string;
  content?: NoteAtom[];
  marks?: NoteAtom[];
  attrs?: Record<string, string | number | boolean>;
}

/**
 * Convert HTML to NoteAtom format (Node.js version)
 * This is a simplified version that handles basic HTML structure
 */
export function htmlToNoteAtom(html: string): NoteAtom {
  // Remove script tags and other unsafe content
  const safeHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  const cleanHtml = safeHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Parse HTML using regex (simplified approach for Node.js)
  const content = parseHtmlToBlocks(cleanHtml);

  return {
    type: 'doc',
    content,
  };
}

/**
 * Parse HTML string into NoteAtom blocks
 */
function parseHtmlToBlocks(html: string): NoteAtom[] {
  const blocks: NoteAtom[] = [];

  // Remove wrapper tags and get content
  let content = html
    .replace(/^<body[^>]*>/i, '')
    .replace(/<\/body>$/i, '')
    .replace(/^<html[^>]*>/i, '')
    .replace(/<\/html>$/i, '')
    .trim();

  // Split by block-level elements
  const blockRegex = /<(h[1-6]|p|div|blockquote|pre|ul|ol|li|img|h1|h2|h3|h4|h5|h6)([^>]*)>([\s\S]*?)<\/\1>|<(br|hr)\s*\/?>|<img([^>]*)>/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    // Add any text before this block
    const beforeText = content.substring(lastIndex, match.index).trim();
    if (beforeText) {
      blocks.push(createTextNode(beforeText));
    }

    const tag = match[1] || match[2];
    const attributes = match[2] || match[4] || '';
    const innerContent = match[3] || '';

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        blocks.push(createHeadingNode(innerContent));
        break;
      case 'p':
      case 'div':
        blocks.push(...parseInlineToBlock(innerContent));
        break;
      case 'blockquote':
        blocks.push(createBlockquoteNode(innerContent));
        break;
      case 'pre':
        blocks.push(createCodeBlockNode(innerContent));
        break;
      case 'ul':
      case 'ol':
        blocks.push(...createListNode(innerContent, tag === 'ol'));
        break;
      case 'li':
        blocks.push(createListItemNode(innerContent));
        break;
      case 'img':
        blocks.push(createImageNode(attributes));
        break;
      case 'br':
        // Skip, handled by block separation
        break;
      case 'hr':
        blocks.push(createTextNode('---'));
        break;
    }

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining text
  const remainingText = content.substring(lastIndex).trim();
  if (remainingText) {
    blocks.push(createTextNode(remainingText));
  }

  // If no blocks were created, create a single paragraph with the content
  if (blocks.length === 0 && html.trim()) {
    blocks.push(createTextNode(html.trim()));
  }

  return blocks;
}

/**
 * Parse inline HTML and create block nodes
 */
function parseInlineToBlock(html: string): NoteAtom[] {
  const blocks: NoteAtom[] = [];

  // Remove block-level tags and process content
  const innerContent = html
    .replace(/<(h[1-6]|p|div|blockquote|pre|ul|ol|li)[^>]*>/gi, '')
    .replace(/<\/(h[1-6]|p|div|blockquote|pre|ul|ol|li)>/gi, '')
    .trim();

  if (innerContent) {
    const inlineContent = parseInlineContent(innerContent);
    blocks.push({
      type: 'paragraph',
      content: inlineContent,
    });
  }

  return blocks;
}

/**
 * Parse inline content (links, bold, italic, etc.)
 */
function parseInlineContent(html: string): NoteAtom[] {
  const content: NoteAtom[] = [];

  // Match inline elements
  const inlineRegex = /<(a|strong|b|em|i|u|mark|code|span)([^>]*)>([\s\S]*?)<\/\1>|([^<>]+)/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(html)) !== null) {
    // Add any text before this element
    const beforeText = match[4] || html.substring(lastIndex, match.index);
    if (beforeText && beforeText.trim()) {
      content.push({ type: 'text', text: beforeText });
    }

    if (match[1]) {
      const tag = match[1];
      const attrs = match[2];
      const innerText = match[3];

      switch (tag) {
        case 'a':
          content.push(createLinkNode(innerText, attrs));
          break;
        case 'strong':
        case 'b':
          content.push(...createMarkedNodes(innerText, 'bold'));
          break;
        case 'em':
        case 'i':
          content.push(...createMarkedNodes(innerText, 'italic'));
          break;
        case 'u':
          content.push(...createMarkedNodes(innerText, 'underline'));
          break;
        case 'mark':
        case 'span':
          if (attrs.includes('highlight')) {
            content.push(...createMarkedNodes(innerText, 'highlight'));
          } else {
            content.push(...parseInlineContent(innerText));
          }
          break;
        case 'code':
          content.push(...createMarkedNodes(innerText, 'code'));
          break;
      }
    }

    lastIndex = match.index + match[0].length;
  }

  return content;
}

/**
 * Create a text node
 */
function createTextNode(text: string): NoteAtom {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text: text.trim() }],
  };
}

/**
 * Create a heading node (paragraph with bold text)
 */
function createHeadingNode(content: string): NoteAtom {
  const inlineContent = parseInlineContent(content);

  return {
    type: 'paragraph',
    content: inlineContent.map((node) => ({
      ...node,
      marks: [...(node.marks || []), { type: 'bold' }],
    })),
  };
}

/**
 * Create a blockquote node
 */
function createBlockquoteNode(content: string): NoteAtom {
  const inlineContent = parseInlineContent(content);

  return {
    type: 'quote',
    content: inlineContent,
  };
}

/**
 * Create a code block node
 */
function createCodeBlockNode(content: string): NoteAtom {
  // Extract code from inner code tag if present
  const codeMatch = content.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
  const text = codeMatch ? codeMatch[1] : stripHtmlTags(content);

  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: text.trim(),
        marks: [{ type: 'code' }],
      },
    ],
  };
}

/**
 * Create list item nodes
 */
function createListNode(content: string, isOrdered: boolean): NoteAtom[] {
  const items = content.split(/<li[^>]*>([\s\S]*?)<\/li>/gi).filter(Boolean);

  return items.map((item) => {
    const inlineContent = parseInlineContent(item);
    const prefix = isOrdered ? '1. ' : '• ';

    return {
      type: 'paragraph',
      content: [
        { type: 'text', text: prefix },
        ...inlineContent,
      ],
    };
  });
}

/**
 * Create a list item node
 */
function createListItemNode(content: string): NoteAtom {
  const inlineContent = parseInlineContent(content);

  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: '• ' },
      ...inlineContent,
    ],
  };
}

/**
 * Create an image node
 */
function createImageNode(attrs: string): NoteAtom {
  const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
  const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
  const alignMatch = attrs.match(/align=["']([^"']+)["']/i);

  const src = srcMatch ? srcMatch[1] : '';
  const alt = altMatch ? altMatch[1] : '';
  const align = alignMatch ? alignMatch[1] : 'center';

  // Extract UUID from mowen asset URLs
  const uuidMatch = src.match(/\/([a-zA-Z0-9_-]{20,})/);
  const uuid = uuidMatch ? uuidMatch[1] : '';

  if (uuid) {
    const attrs: Record<string, string> = {
      uuid,
      align,
    };
    if (alt) {
      attrs.alt = alt;
    }
    return {
      type: 'image',
      attrs,
    };
  }

  // If not a mowen image, create a link node
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: alt || src,
        marks: [
          {
            type: 'link',
            attrs: { href: src },
          },
        ],
      },
    ],
  };
}

/**
 * Create a link node
 */
function createLinkNode(text: string, attrs: string): NoteAtom {
  const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
  const href = hrefMatch ? hrefMatch[1] : '';

  return {
    type: 'text',
    text: text.trim(),
    marks: [
      {
        type: 'link',
        attrs: { href },
      },
    ],
  };
}

/**
 * Create nodes with a mark (bold, italic, etc.)
 */
function createMarkedNodes(content: string, markType: string): NoteAtom[] {
  const innerContent = parseInlineContent(content);

  return innerContent.map((node) => ({
    ...node,
    marks: [...(node.marks || []), { type: markType }],
  }));
}

/**
 * Strip HTML tags from string
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
