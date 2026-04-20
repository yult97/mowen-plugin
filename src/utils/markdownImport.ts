import DOMPurify from 'dompurify';
import matter from 'gray-matter';
import { Marked, Tokens, type Token } from 'marked';
import {
  ContentBlock,
  ContentBlockLayout,
  ExtractResult,
  ImageCandidate,
  MarkdownImportResult,
  MarkdownImportStats,
  MarkdownTableArtifact,
  MarkdownPreviewNode,
  MdImportWarning,
  MdImportWarningCode,
} from '../types';
import { generateId, stripHtml } from './helpers';
import {
  createMarkdownPreviewModel,
  MarkdownPreviewRenderableBlock,
} from './markdownPreview';
import {
  buildMarkdownTableFallbackText,
  renderMarkdownTableArtifact,
} from './markdownTableImage';
import { inferCodeLanguageFromText, resolveShikiLanguageId } from './shikiLanguages';

const marked = new Marked({
  gfm: true,
  breaks: false,
});

const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const PART_ESTIMATE_LIMIT = 19000;
const MARKDOWN_DOMAIN = 'markdown';
const SAFE_HTML_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'ol', 'p', 'pre',
  'mark', 'span', 'strong', 'sub', 'sup', 'ul',
];
const SAFE_HTML_ATTRS = ['alt', 'class', 'data-mowen-caption', 'data-mowen-id', 'href', 'rel', 'src', 'target', 'title'];
const SAFE_HTML_TAG_SET = new Set(SAFE_HTML_TAGS);
const HIGHLIGHT_ANNOTATION_PREFIX = /^\s*\[(?:(?:高亮|highlight)(?:[/／][^\]]+)?)\]\s*/i;
const TECHNICAL_COMMAND_PREFIX = /^(?:[$#]\s*)?(?:npm|pnpm|yarn|bun|npx|pnpx|git|docker|kubectl|helm|curl|wget|chmod|mkdir|rm|cp|mv|ls|cd|cat|grep|sed|awk|node|python(?:3)?|pip(?:3)?|pytest|go|java|javac|mvn|gradle|uv|cargo|rustc|make|cmake)\b/i;
const POSIX_PATH_LINE = /^(?:\.{1,2}\/|~\/|\/)[^\s]+$/;
const WINDOWS_PATH_LINE = /^(?:[A-Za-z]:\\|\\\\)[^\s]+$/;
const REPO_PATH_LINE = /^(?:[@A-Za-z0-9_.-]+\/)+[@A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?$/;
const FILE_NAME_LINE = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/;
const ASCII_CONFIG_LINE = /^[A-Za-z_][\w.-]*\s*[:=]\s*.+$/;
const JSONISH_LINE = /^(?:\{.*\}|\[.*\]|".*"\s*:\s*.+)$/;
const CJK_CHAR = /[\u3400-\u9fff]/;

export interface ConvertMarkdownToImportResultOptions {
  fileName?: string;
  includeImages?: boolean;
  sourceUrl?: string;
  domain?: string;
  largeFileThresholdBytes?: number;
  tableImageScale?: number;
  tableMaxWidth?: number;
  renderTableImage?: (input: {
    id: string;
    html: string;
    fallbackText: string;
    alt: string;
  }) => Promise<MarkdownTableArtifact>;
}

interface MarkdownFrontMatter {
  title?: string;
  tags?: unknown;
  date?: unknown;
  [key: string]: unknown;
}

interface WarningAccumulator {
  emptyContent: boolean;
  unsupportedSyntax: Set<string>;
  localImageDegraded: number;
  dataImageDegraded: number;
  tableRenderFailed: number;
  tableFallbackText: number;
  invalidLink: number;
  frontMatterIgnored: number;
  htmlSanitized: number;
  largeFile: boolean;
}

interface ConversionContext {
  includeImages: boolean;
  tableImageScale: number;
  tableMaxWidth: number;
  renderTableImage: (input: {
    id: string;
    html: string;
    fallbackText: string;
    alt: string;
  }) => Promise<MarkdownTableArtifact>;
  warnings: WarningAccumulator;
  images: ImageCandidate[];
  imageCandidateKeys: Set<string>;
  remoteImageCount: number;
  localImageCount: number;
  dataImageCount: number;
  tableCount: number;
  tableImageCount: number;
  tableFallbackCount: number;
}

interface InternalBlock {
  id: string;
  type: ContentBlock['type'];
  previewType: MarkdownPreviewNode['type'];
  html: string;
  text: string;
  layout?: ContentBlockLayout;
  level?: number;
}

interface ParsedMarkdown {
  body: string;
  frontMatter: MarkdownFrontMatter;
  frontMatterErrored: boolean;
}

export interface ConvertMarkdownImportParams extends ConvertMarkdownToImportResultOptions {
  markdown: string;
  maxImages?: number;
}

export async function convertMarkdownToImportResult(
  markdown: string,
  options: ConvertMarkdownToImportResultOptions = {}
): Promise<MarkdownImportResult> {
  const normalizedSource = normalizeMarkdownSource(markdown);
  const parsed = parseMarkdownFrontMatter(normalizedSource);
  const warnings = createWarningAccumulator();
  const ctx: ConversionContext = {
    includeImages: options.includeImages ?? true,
    tableImageScale: options.tableImageScale ?? 2,
    tableMaxWidth: options.tableMaxWidth ?? 960,
    renderTableImage: options.renderTableImage || (async ({ id, html, fallbackText, alt }) => {
      const tableHeaders = extractHeadersFromHtmlTable(html);
      const tableRows = extractRowsFromHtmlTable(html);
      const artifact = await renderMarkdownTableArtifact({
        id,
        headers: tableHeaders,
        rows: tableRows,
        alt,
        scale: options.tableImageScale ?? 2,
        maxWidth: options.tableMaxWidth ?? 960,
      });

      return {
        ...artifact,
        html,
        fallbackText,
      };
    }),
    warnings,
    images: [],
    imageCandidateKeys: new Set<string>(),
    remoteImageCount: 0,
    localImageCount: 0,
    dataImageCount: 0,
    tableCount: 0,
    tableImageCount: 0,
    tableFallbackCount: 0,
  };

  if (parsed.frontMatterErrored) {
    warnings.frontMatterIgnored += 1;
  }

  const byteLength = getByteLength(normalizedSource);
  if (byteLength > (options.largeFileThresholdBytes ?? LARGE_FILE_THRESHOLD_BYTES)) {
    warnings.largeFile = true;
  }

  const ignoredFrontMatterKeys = Object.keys(parsed.frontMatter).filter((key) => !['title', 'tags', 'date'].includes(key));
  if (ignoredFrontMatterKeys.length > 0) {
    warnings.frontMatterIgnored += ignoredFrontMatterKeys.length;
  }

  detectUnsupportedSyntax(parsed.body, warnings);

  const tokens = marked.lexer(parsed.body) as Token[];
  const derivedTitle = deriveMarkdownTitle(parsed.frontMatter, tokens, parsed.body);
  const hasFrontMatterTitle = typeof parsed.frontMatter.title === 'string' && parsed.frontMatter.title.trim().length > 0;
  const bodyTokens = hasFrontMatterTitle
    ? removeLeadingDuplicateTitleToken(tokens, derivedTitle)
    : tokens;
  const renderedBlocks = await renderTokenList(bodyTokens, ctx);
  const contentHtml = renderedBlocks.map((block) => block.html).join('\n');
  const wordCount = contentHtml ? stripMarkdownVisualFormatting(stripHtml(contentHtml)).length : 0;

  if (!parsed.body.trim() || wordCount === 0) {
    warnings.emptyContent = true;
  }

  const extractBlocks: ContentBlock[] = renderedBlocks.map((block) => ({
    id: block.id,
    type: block.type,
    html: block.html,
    text: block.text,
    layout: block.layout,
    level: block.level,
  }));

  const previewBlocks: MarkdownPreviewRenderableBlock[] = renderedBlocks.map((block) => ({
    id: block.id,
    type: block.previewType,
    html: block.html,
    text: block.text,
    level: block.level,
  }));

  const warningList = buildWarnings(warnings, ignoredFrontMatterKeys.length);
  const stats: MarkdownImportStats = {
    title: derivedTitle,
    wordCount,
    remoteImageCount: ctx.remoteImageCount,
    localImageCount: ctx.localImageCount,
    dataImageCount: ctx.dataImageCount,
    tableCount: ctx.tableCount,
    tableFallbackCount: ctx.tableFallbackCount,
    estimatedPartCount: Math.max(1, Math.ceil(wordCount / PART_ESTIMATE_LIMIT) || 1),
    warningCount: warningList.length,
  };

  const extractResult: ExtractResult = {
    title: derivedTitle,
    sourceUrl: options.sourceUrl || '',
    domain: options.domain || MARKDOWN_DOMAIN,
    sourceType: 'markdown_import',
    sourceMeta: {
      fileName: options.fileName,
      warnings: warningList,
      unsupportedSyntax: Array.from(warnings.unsupportedSyntax),
      hasLocalImages: ctx.localImageCount > 0,
      tableImageCount: ctx.tableImageCount,
      tableFallbackCount: ctx.tableFallbackCount,
    },
    contentHtml,
    blocks: extractBlocks,
    images: ctx.includeImages ? ctx.images : [],
    wordCount,
  };

  return {
    extractResult,
    previewModel: createMarkdownPreviewModel({
      title: derivedTitle,
      blocks: previewBlocks,
    }),
    stats,
    warnings: warningList,
    editableTitle: derivedTitle,
  };
}

export async function convertMarkdownImport(
  params: ConvertMarkdownImportParams
): Promise<MarkdownImportResult> {
  return convertMarkdownToImportResult(params.markdown, params);
}

function normalizeMarkdownSource(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trim();
}

function deriveMarkdownTitle(
  frontMatter: MarkdownFrontMatter,
  tokens: Token[],
  markdownBody: string
): string {
  const frontMatterTitle = typeof frontMatter.title === 'string' ? frontMatter.title.trim() : '';
  if (frontMatterTitle) {
    return frontMatterTitle;
  }

  const firstHeading = tokens.find((token): token is Tokens.Heading => (
    token.type === 'heading' && token.depth === 1 && token.text.trim().length > 0
  ));
  if (firstHeading) {
    return firstHeading.text.trim();
  }

  return extractMarkdownExcerptTitle(markdownBody) || '未命名 Markdown';
}

function parseMarkdownFrontMatter(markdown: string): ParsedMarkdown {
  try {
    const result = matter(markdown);
    return {
      body: result.content,
      frontMatter: (result.data || {}) as MarkdownFrontMatter,
      frontMatterErrored: false,
    };
  } catch {
    return {
      body: markdown,
      frontMatter: {},
      frontMatterErrored: true,
    };
  }
}

function detectUnsupportedSyntax(
  markdown: string,
  warnings: WarningAccumulator
): void {
  if (/```(?:\s*)mermaid\b/i.test(markdown)) {
    warnings.unsupportedSyntax.add('Mermaid');
  }
  if (/(^|\n)\$\$[\s\S]*?\$\$(\n|$)/.test(markdown) || /(^|[^$])\$(?!\$).+?\$(?!\$)/.test(markdown)) {
    warnings.unsupportedSyntax.add('LaTeX 公式');
  }
  if (/\[\^[^\]]+\]/.test(markdown)) {
    warnings.unsupportedSyntax.add('脚注');
  }
  if (/(^|\n)\[\[?toc\]?\](\n|$)/i.test(markdown)) {
    warnings.unsupportedSyntax.add('目录自动生成');
  }
}

function removeLeadingDuplicateTitleToken(tokens: Token[], title: string): Token[] {
  const cloned = [...tokens];
  while (cloned[0]?.type === 'space') {
    cloned.shift();
  }

  const firstToken = cloned[0];
  if (firstToken?.type === 'heading' && firstToken.depth === 1 && normalizeCompareText(firstToken.text) === normalizeCompareText(title)) {
    cloned.shift();
    while (cloned[0]?.type === 'space') {
      cloned.shift();
    }
  }

  return cloned;
}

async function renderTokenList(tokens: Token[], ctx: ConversionContext): Promise<InternalBlock[]> {
  const blocks: InternalBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'heading':
        blocks.push(renderHeadingBlock(token as Tokens.Heading, ctx));
        break;
      case 'paragraph':
        blocks.push(...await renderParagraphBlocks(token as Tokens.Paragraph, ctx));
        break;
      case 'text':
        blocks.push(...await renderTextBlocks(token as Tokens.Text, ctx));
        break;
      case 'blockquote':
        blocks.push(await renderBlockquoteBlock(token as Tokens.Blockquote, ctx));
        break;
      case 'code':
        blocks.push(renderCodeBlock(token as Tokens.Code));
        if ((token as Tokens.Code).lang?.toLowerCase() === 'mermaid') {
          ctx.warnings.unsupportedSyntax.add('Mermaid');
        }
        break;
      case 'list':
        blocks.push(await renderListBlock(token as Tokens.List, ctx));
        if ((token as Tokens.List).items.some((item: Tokens.ListItem) => item.task)) {
          ctx.warnings.unsupportedSyntax.add('任务列表');
        }
        break;
      case 'table':
        blocks.push(await renderTableBlock(token as Tokens.Table, ctx));
        break;
      case 'hr':
        break;
      case 'html':
        blocks.push(renderHtmlBlock(token as Tokens.HTML | Tokens.Tag, ctx));
        break;
      default:
        blocks.push(renderFallbackParagraph(token.raw || '', ctx));
        break;
    }
  }

  return blocks.filter((block) => block.html.trim().length > 0);
}

function renderHeadingBlock(token: Tokens.Heading, ctx: ConversionContext): InternalBlock {
  const level = clampHeadingLevel(token.depth);
  const innerHtml = renderInlineTokens(token.tokens || [], ctx);
  return buildBlock({
    type: 'heading',
    previewType: 'heading',
    html: sanitizeHtml(
      `<p class="md-import-heading md-import-heading-${level}"><strong>${innerHtml}</strong></p>`
    ),
    level,
  });
}

async function renderParagraphBlock(token: Tokens.Paragraph, ctx: ConversionContext): Promise<InternalBlock> {
  const primaryToken = getSingleMeaningfulInlineToken(token.tokens);
  if (primaryToken?.type === 'image') {
    return renderStandaloneImageBlock(primaryToken, ctx);
  }

  const paragraphHtml = applyHighlightAnnotation(renderInlineTokens(token.tokens || [], ctx));
  const layout = shouldPreserveInlineParagraphLayout(token)
    ? { preserveInlineParagraphs: true as const }
    : undefined;

  return buildBlock({
    type: 'paragraph',
    previewType: 'paragraph',
    html: sanitizeHtml(`<p>${paragraphHtml}</p>`),
    layout,
  });
}

async function renderParagraphBlocks(token: Tokens.Paragraph, ctx: ConversionContext): Promise<InternalBlock[]> {
  const multilineBlocks = await tryRenderLineSplitParagraphBlocks(token.raw, ctx);
  if (multilineBlocks) {
    return multilineBlocks;
  }

  return [await renderParagraphBlock(token, ctx)];
}

async function renderTextBlock(token: Tokens.Text, ctx: ConversionContext): Promise<InternalBlock> {
  if (token.tokens && token.tokens.length > 0) {
    return renderParagraphBlock({
      type: 'paragraph',
      raw: token.raw,
      text: token.text,
      tokens: token.tokens,
    }, ctx);
  }

  return buildBlock({
    type: 'paragraph',
    previewType: 'paragraph',
    html: sanitizeHtml(`<p>${applyHighlightAnnotation(escapeHtml(token.text))}</p>`),
  });
}

async function renderTextBlocks(token: Tokens.Text, ctx: ConversionContext): Promise<InternalBlock[]> {
  return [await renderTextBlock(token, ctx)];
}

async function renderBlockquoteBlock(token: Tokens.Blockquote, ctx: ConversionContext): Promise<InternalBlock> {
  const nestedBlocks = await renderTokenList(token.tokens || [], ctx);
  const html = nestedBlocks.map((block) => block.html).join('');
  return buildBlock({
    type: 'quote',
    previewType: 'quote',
    html: sanitizeHtml(`<blockquote>${html}</blockquote>`),
  });
}

function renderCodeBlock(token: Tokens.Code): InternalBlock {
  const language = resolveMarkdownCodeLanguage(token.lang, token.text);
  const classAttr = language ? ` class="language-${escapeHtmlAttribute(language)}"` : '';
  return buildBlock({
    type: 'code',
    previewType: 'code',
    html: sanitizeHtml(`<pre><code${classAttr}>${escapeHtml(token.text)}</code></pre>`),
  });
}

async function renderListBlock(token: Tokens.List, ctx: ConversionContext): Promise<InternalBlock> {
  const groupId = createId('mdlist');
  const itemDetails = token.items.map((item, index) => {
    const contentText = flattenInlineText(item.tokens || [], item.text || '');
    const contentHtml = renderListItemHtml(item, ctx, contentText);
    const prefix = shouldRenderHighlightListAsOrdered(token.items)
      ? `${index + 1}、`
      : token.ordered
        ? `${typeof token.start === 'number' ? token.start + index : index + 1}. `
        : '• ';

    return {
      prefix,
      contentText,
      contentHtml,
      quotedText: `${prefix}${stripHighlightAnnotationPrefix(contentText)}`.trim(),
    };
  }).filter((item) => item.contentText.trim().length > 0);

  if (shouldRenderListAsCodeBlock(itemDetails.map((item) => item.contentText))) {
    const codeText = itemDetails
      .map((item) => stripHighlightAnnotationPrefix(item.contentText))
      .join('\n')
      .trim();
    const language = resolveTechnicalListLanguage(itemDetails.map((item) => item.contentText));

    return buildBlock({
      type: 'code',
      previewType: 'code',
      html: sanitizeHtml(`<pre><code class="language-${escapeHtmlAttribute(language)}">${escapeHtml(codeText)}</code></pre>`),
      text: codeText,
    });
  }

  const listHtml = itemDetails
    .map((item) => `<p>${escapeHtml(item.prefix)}${item.contentHtml}</p>`)
    .join('');

  return buildBlock({
    type: 'list',
    previewType: 'list',
    html: sanitizeHtml(listHtml),
    layout: { groupId, preserveInlineParagraphs: true },
    text: itemDetails.map((item) => item.quotedText).join('\n'),
  });
}

async function renderTableBlock(token: Tokens.Table, ctx: ConversionContext): Promise<InternalBlock> {
  ctx.tableCount += 1;
  const headers = token.header.map((cell) => flattenInlineText(cell.tokens || [], cell.text));
  const rows = token.rows.map((row) => row.map((cell) => flattenInlineText(cell.tokens || [], cell.text)));
  const artifact = await ctx.renderTableImage({
    id: createId('mdtable'),
    html: buildSimpleTableHtml(headers, rows, token.align),
    fallbackText: buildMarkdownTableFallbackText(headers, rows),
    alt: `Markdown 表格 ${ctx.tableCount}`,
  });

  if (ctx.includeImages && artifact.success && artifact.dataUrl) {
    ctx.tableImageCount += 1;
    const imageCandidate = registerImageCandidate(ctx, artifact.dataUrl, 'data', artifact.alt);
    const html = sanitizeHtml(
      `<p>${buildManagedImageTag({
        src: artifact.dataUrl,
        alt: artifact.alt,
        imageId: imageCandidate.id,
      })}</p>`
    );

    return buildBlock({
      type: 'image',
      previewType: 'image',
      html,
      text: artifact.alt,
      id: imageCandidate.id,
    });
  }

  if (!artifact.success) {
    ctx.warnings.tableRenderFailed += 1;
  }
  ctx.warnings.tableFallbackText += 1;
  ctx.tableFallbackCount += 1;

  return buildBlock({
    type: 'code',
    previewType: 'code',
    html: sanitizeHtml(`<pre><code class="language-markdown">${escapeHtml(artifact.fallbackText)}</code></pre>`),
    text: artifact.fallbackText,
  });
}

function renderHtmlBlock(token: Tokens.HTML | Tokens.Tag, ctx: ConversionContext): InternalBlock {
  const sanitized = sanitizeUserProvidedHtml(token.raw, ctx);
  if (!sanitized.trim()) {
    return renderFallbackParagraph(stripHtml(token.raw), ctx);
  }

  return buildBlock({
    type: 'other',
    previewType: 'paragraph',
    html: sanitized,
  });
}

function buildSimpleTableHtml(
  headers: string[],
  rows: string[][],
  align: Array<'left' | 'center' | 'right' | null>
): string {
  const thead = `<thead><tr>${headers.map((header, index) => (
    `<th${buildAlignAttribute(align[index])}>${escapeHtml(header)}</th>`
  )).join('')}</tr></thead>`;

  const tbody = `<tbody>${rows.map((row) => (
    `<tr>${headers.map((_, index) => (
      `<td${buildAlignAttribute(align[index])}>${escapeHtml(row[index] || '')}</td>`
    )).join('')}</tr>`
  )).join('')}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

function buildAlignAttribute(align: 'left' | 'center' | 'right' | null | undefined): string {
  return align ? ` align="${align}"` : '';
}

function renderFallbackParagraph(text: string, _ctx: ConversionContext): InternalBlock {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return buildBlock({
      type: 'paragraph',
      previewType: 'paragraph',
      html: '',
      text: '',
    });
  }

  return buildBlock({
    type: 'paragraph',
    previewType: 'paragraph',
    html: sanitizeHtml(`<p>${applyHighlightAnnotation(escapeHtml(normalizedText))}</p>`),
    text: normalizedText,
  });
}

function renderInlineTokens(
  tokens: Token[],
  ctx: ConversionContext,
  options: { disableAutoLinks?: boolean } = {}
): string {
  return tokens.map((token) => renderInlineToken(token, ctx, options)).join('');
}

function renderInlineToken(
  token: Token,
  ctx: ConversionContext,
  options: { disableAutoLinks?: boolean } = {}
): string {
  switch (token.type) {
    case 'strong':
      return `<strong>${renderInlineTokens(token.tokens || [], ctx, options)}</strong>`;
    case 'em':
      return renderInlineTokens(token.tokens || [], ctx, options);
    case 'codespan':
      return `<code>${escapeHtml(token.text)}</code>`;
    case 'del':
      return renderInlineTokens(token.tokens || [], ctx, options);
    case 'br':
      return '<br>';
    case 'link':
      return renderInlineLink(token as Tokens.Link, ctx);
    case 'image':
      return renderInlineImage(token as Tokens.Image, ctx);
    case 'html':
      return sanitizeUserProvidedHtml(token.raw, ctx);
    case 'text':
      if (token.tokens && token.tokens.length > 0) {
        return renderInlineTokens(token.tokens, ctx, options);
      }
      return options.disableAutoLinks ? escapeHtml(token.text) : renderTextWithAutoLinks(token.text, ctx);
    case 'escape':
      return escapeHtml(token.text);
    default:
      return 'raw' in token ? escapeHtml(String(token.raw || '')) : '';
  }
}

function renderInlineLink(token: Tokens.Link, ctx: ConversionContext): string {
  const href = token.href?.trim() || '';
  const text = token.tokens && token.tokens.length > 0
    ? renderInlineTokens(token.tokens, ctx, { disableAutoLinks: true })
    : escapeHtml(token.text || href);

  if (!isSafeLinkUrl(href)) {
    ctx.warnings.invalidLink += 1;
    return text || escapeHtml(token.text || href);
  }

  return `<a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function renderInlineImage(token: Tokens.Image, ctx: ConversionContext): string {
  const src = token.href?.trim() || '';
  const alt = token.text?.trim() || '图片';

  if (!src) {
    return '';
  }

  if (isRemoteImageUrl(src)) {
    ctx.remoteImageCount += 1;
    if (!ctx.includeImages) {
      return buildRemoteImageLink(src, alt);
    }
    const imageCandidate = registerImageCandidate(ctx, src, 'img', alt);
    return buildManagedImageTag({
      src,
      alt,
      imageId: imageCandidate.id,
    });
  }

  if (isImageDataUrl(src)) {
    ctx.dataImageCount += 1;
    if (!ctx.includeImages) {
      return `<code>${escapeHtml(`data:image ${alt}`)}</code>`;
    }
    const imageCandidate = registerImageCandidate(ctx, src, 'data', alt);
    return buildManagedImageTag({
      src,
      alt,
      imageId: imageCandidate.id,
    });
  }

  ctx.localImageCount += 1;
  ctx.warnings.localImageDegraded += 1;
  return `<code>${escapeHtml(`本地图片未上传：${src}`)}</code>`;
}

function buildRemoteImageLink(href: string, alt: string): string {
  return `<a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || '查看原图')}</a>`;
}

function renderTextWithAutoLinks(text: string, ctx: ConversionContext): string {
  const parts = splitTextByUrls(text);
  return parts.map((part) => {
    if (part.type === 'url') {
      if (!isSafeLinkUrl(part.value)) {
        ctx.warnings.invalidLink += 1;
        return escapeHtml(part.value);
      }
      return `<a href="${escapeHtmlAttribute(part.value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part.value)}</a>`;
    }

    return escapeHtml(part.value);
  }).join('');
}

function registerImageCandidate(
  ctx: ConversionContext,
  url: string,
  kind: ImageCandidate['kind'],
  alt?: string
): ImageCandidate {
  const key = `${kind}:${url}`;
  const existing = ctx.images.find((image) => `${image.kind}:${image.normalizedUrl}` === key);
  if (existing) {
    return existing;
  }

  const candidate: ImageCandidate = {
    id: createId('mdimg'),
    url,
    normalizedUrl: url,
    kind,
    order: ctx.images.length,
    inMainContent: true,
    alt,
  };

  ctx.imageCandidateKeys.add(key);
  ctx.images.push(candidate);
  return candidate;
}

function sanitizeUserProvidedHtml(rawHtml: string, ctx: ConversionContext): string {
  const sanitized = sanitizeHtml(rawHtml);
  if (sanitized !== rawHtml) {
    ctx.warnings.htmlSanitized += 1;
  }
  return sanitized;
}

function sanitizeHtml(html: string): string {
  let sanitized = html;
  try {
    const purified = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: SAFE_HTML_TAGS,
      ALLOWED_ATTR: SAFE_HTML_ATTRS,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      KEEP_CONTENT: true,
    }) as string;

    if (typeof purified === 'string') {
      sanitized = purified;
    }
  } catch {
    sanitized = html;
  }

  return sanitizeHtmlFallback(sanitized);
}

function buildBlock(input: {
  type: ContentBlock['type'];
  previewType: MarkdownPreviewNode['type'];
  html: string;
  text?: string;
  layout?: ContentBlockLayout;
  id?: string;
  level?: number;
}): InternalBlock {
  const html = input.html.trim();
  return {
    id: input.id || createId('mdblock'),
    type: input.type,
    previewType: input.previewType,
    html,
    text: input.text ?? stripHtml(html),
    layout: input.layout,
    level: input.level,
  };
}

function createWarningAccumulator(): WarningAccumulator {
  return {
    emptyContent: false,
    unsupportedSyntax: new Set<string>(),
    localImageDegraded: 0,
    dataImageDegraded: 0,
    tableRenderFailed: 0,
    tableFallbackText: 0,
    invalidLink: 0,
    frontMatterIgnored: 0,
    htmlSanitized: 0,
    largeFile: false,
  };
}

function buildWarnings(
  warnings: WarningAccumulator,
  ignoredFrontMatterKeysCount: number
): MdImportWarning[] {
  const result: MdImportWarning[] = [];

  if (warnings.emptyContent) {
    result.push(createWarning('EMPTY_CONTENT', 'error', 'Markdown 内容为空，无法生成可保存内容'));
  }
  if (warnings.unsupportedSyntax.size > 0) {
    result.push(createWarning(
      'UNSUPPORTED_SYNTAX',
      'warning',
      `检测到以下语法将降级处理：${Array.from(warnings.unsupportedSyntax).join('、')}`,
      warnings.unsupportedSyntax.size
    ));
  }
  if (warnings.localImageDegraded > 0) {
    result.push(createWarning(
      'LOCAL_IMAGE_DEGRADED',
      'warning',
      `检测到 ${warnings.localImageDegraded} 张本地图片，本期不会上传，已降级为文本提示`,
      warnings.localImageDegraded
    ));
  }
  if (warnings.dataImageDegraded > 0) {
    result.push(createWarning(
      'DATA_IMAGE_DEGRADED',
      'warning',
      `检测到 ${warnings.dataImageDegraded} 张 data URL 图片无法处理，已降级为文本`,
      warnings.dataImageDegraded
    ));
  }
  if (warnings.tableRenderFailed > 0) {
    result.push(createWarning(
      'TABLE_RENDER_FAILED',
      'warning',
      `有 ${warnings.tableRenderFailed} 个表格图片生成失败，已回退为文本`,
      warnings.tableRenderFailed
    ));
  }
  if (warnings.tableFallbackText > 0) {
    result.push(createWarning(
      'TABLE_FALLBACK_TEXT',
      'info',
      `有 ${warnings.tableFallbackText} 个表格将以文本形式保存`,
      warnings.tableFallbackText
    ));
  }
  if (warnings.invalidLink > 0) {
    result.push(createWarning(
      'INVALID_LINK',
      'warning',
      `检测到 ${warnings.invalidLink} 个非法链接，已按纯文本保留`,
      warnings.invalidLink
    ));
  }
  if (warnings.frontMatterIgnored > 0 || ignoredFrontMatterKeysCount > 0) {
    result.push(createWarning(
      'FRONT_MATTER_IGNORED',
      'info',
      `检测到 ${warnings.frontMatterIgnored || ignoredFrontMatterKeysCount} 个 Front Matter 字段未参与导入`,
      warnings.frontMatterIgnored || ignoredFrontMatterKeysCount
    ));
  }
  if (warnings.htmlSanitized > 0) {
    result.push(createWarning(
      'HTML_SANITIZED',
      'info',
      `检测到 ${warnings.htmlSanitized} 处 HTML 已按安全子集清洗`,
      warnings.htmlSanitized
    ));
  }
  if (warnings.largeFile) {
    result.push(createWarning('LARGE_FILE', 'info', '文件较大，预览和转换可能较慢'));
  }

  return result;
}

function createWarning(
  code: MdImportWarningCode,
  level: MdImportWarning['level'],
  message: string,
  count?: number
): MdImportWarning {
  return { code, level, message, count };
}

function flattenInlineText(tokens: Token[], fallback: string): string {
  if (!tokens || tokens.length === 0) {
    return fallback.trim();
  }

  return tokens.map((token) => {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        return flattenInlineText(token.tokens || [], token.text || '');
      case 'codespan':
      case 'text':
      case 'escape':
        return token.text || '';
      case 'image':
        return token.text || token.href || '';
      case 'br':
        return '\n';
      case 'html':
        return stripHtml(token.raw || token.text || '');
      default:
        return 'raw' in token ? stripHtml(String(token.raw || '')) : '';
    }
  }).join('').trim();
}

function renderListItemHtml(item: Tokens.ListItem, ctx: ConversionContext, fallbackText: string): string {
  const tokens = (item.tokens || []).filter((token) => token.type !== 'space');
  if (tokens.length === 0) {
    return applyHighlightAnnotation(escapeHtml(fallbackText));
  }

  const rendered = tokens.map((token) => {
    switch (token.type) {
      case 'paragraph':
        return renderInlineTokens(token.tokens || [], ctx);
      case 'text':
        return renderInlineToken(token, ctx);
      case 'html':
        return sanitizeUserProvidedHtml(token.raw, ctx);
      case 'list':
        return flattenInlineText([token], token.raw || '')
          .split('\n')
          .map((line) => escapeHtml(line.trim()))
          .filter(Boolean)
          .join('<br>');
      default:
        return escapeHtml(
          flattenInlineText(
            'tokens' in token ? token.tokens || [] : [],
            'text' in token ? String(token.text || '') : String(token.raw || '')
          )
        );
    }
  }).join('<br>');

  return applyHighlightAnnotation(rendered);
}

function shouldPreserveInlineParagraphLayout(token: Tokens.Paragraph): boolean {
  const inlineTokens = token.tokens || [];
  if (inlineTokens.length === 0) {
    return false;
  }

  const hasLinkToken = inlineTokens.some((inlineToken) => inlineToken.type === 'link');
  if (!hasLinkToken) {
    return false;
  }

  const flattenedText = flattenInlineText(inlineTokens, token.text || '');
  return /^[A-Za-z0-9\u4e00-\u9fff_()[\]【】《》<>·•、/+\-.]{1,18}[：:]/.test(flattenedText.trim());
}

function shouldRenderHighlightListAsOrdered(items: Tokens.ListItem[]): boolean {
  const normalizedItems = items
    .map((item) => flattenInlineText(item.tokens || [], item.text || '').trim())
    .filter(Boolean);

  return normalizedItems.length > 0
    && normalizedItems.every((itemText) => HIGHLIGHT_ANNOTATION_PREFIX.test(itemText));
}

function applyHighlightAnnotation(html: string): string {
  const normalized = html.trim();
  if (!normalized) {
    return html;
  }

  const stripped = normalized.replace(HIGHLIGHT_ANNOTATION_PREFIX, '').trim();
  if (!stripped || stripped === normalized) {
    return html;
  }

  return `<mark>${stripped}</mark>`;
}

function stripMarkdownVisualFormatting(text: string): string {
  return text;
}

function stripHighlightAnnotationPrefix(text: string): string {
  return text.replace(HIGHLIGHT_ANNOTATION_PREFIX, '').trim();
}

function shouldRenderListAsCodeBlock(itemTexts: string[]): boolean {
  if (itemTexts.length === 0) {
    return false;
  }

  return itemTexts.every((itemText) => isLikelyTechnicalListLine(itemText));
}

function resolveTechnicalListLanguage(itemTexts: string[]): string {
  const codeText = itemTexts
    .map((itemText) => stripHighlightAnnotationPrefix(itemText))
    .join('\n')
    .trim();
  const directLanguage = resolveMarkdownCodeLanguage(undefined, codeText);
  if (directLanguage) {
    return directLanguage;
  }

  const inferredLanguages = itemTexts
    .map((itemText) => inferTechnicalListLineLanguage(itemText))
    .filter((language): language is string => Boolean(language));

  if (inferredLanguages.length === 0) {
    return 'text';
  }

  if (inferredLanguages.every((language) => language === inferredLanguages[0])) {
    return inferredLanguages[0];
  }

  if (inferredLanguages.includes('shellscript')) {
    return 'shellscript';
  }

  if (inferredLanguages.includes('powershell')) {
    return 'powershell';
  }

  const counts = new Map<string, number>();
  inferredLanguages.forEach((language) => {
    counts.set(language, (counts.get(language) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])[0]?.[0] || 'text';
}

function isLikelyTechnicalListLine(line: string): boolean {
  const trimmed = stripHighlightAnnotationPrefix(line);
  if (!trimmed) {
    return false;
  }

  if (TECHNICAL_COMMAND_PREFIX.test(trimmed)) {
    return true;
  }

  if (POSIX_PATH_LINE.test(trimmed) || WINDOWS_PATH_LINE.test(trimmed) || REPO_PATH_LINE.test(trimmed) || FILE_NAME_LINE.test(trimmed)) {
    return true;
  }

  if (ASCII_CONFIG_LINE.test(trimmed) || JSONISH_LINE.test(trimmed)) {
    return true;
  }

  const inferredLanguage = inferCodeLanguageFromText(trimmed);
  if (!inferredLanguage || inferredLanguage === 'text' || inferredLanguage === 'markdown') {
    return false;
  }

  if ((inferredLanguage === 'yaml' || inferredLanguage === 'ini' || inferredLanguage === 'toml') && CJK_CHAR.test(trimmed)) {
    return ASCII_CONFIG_LINE.test(trimmed);
  }

  if (CJK_CHAR.test(trimmed) && !TECHNICAL_COMMAND_PREFIX.test(trimmed)) {
    return false;
  }

  return true;
}

function inferTechnicalListLineLanguage(line: string): string | null {
  const trimmed = stripHighlightAnnotationPrefix(line);
  if (!trimmed) {
    return null;
  }

  if (WINDOWS_PATH_LINE.test(trimmed)) {
    return 'powershell';
  }

  if (TECHNICAL_COMMAND_PREFIX.test(trimmed) || POSIX_PATH_LINE.test(trimmed) || REPO_PATH_LINE.test(trimmed) || FILE_NAME_LINE.test(trimmed)) {
    return 'shellscript';
  }

  if (ASCII_CONFIG_LINE.test(trimmed)) {
    return inferCodeLanguageFromText(trimmed) || 'ini';
  }

  if (JSONISH_LINE.test(trimmed)) {
    return inferCodeLanguageFromText(trimmed) || 'json';
  }

  return inferCodeLanguageFromText(trimmed);
}

function getSingleMeaningfulInlineToken(tokens: Token[]): Tokens.Image | null {
  const meaningful = tokens.filter((token) => !(token.type === 'text' && !token.text.trim()));
  if (meaningful.length === 1 && meaningful[0]?.type === 'image') {
    return meaningful[0] as Tokens.Image;
  }

  return null;
}

function renderStandaloneImageBlock(token: Tokens.Image, ctx: ConversionContext): InternalBlock {
  const src = token.href?.trim() || '';
  const alt = token.text?.trim() || '图片';

  if (isRemoteImageUrl(src)) {
    ctx.remoteImageCount += 1;
    if (ctx.includeImages) {
      const imageCandidate = registerImageCandidate(ctx, src, 'img', alt);
      return buildBlock({
        id: imageCandidate.id,
        type: 'image',
        previewType: 'image',
        html: sanitizeHtml(`<p>${buildManagedImageTag({
          src,
          alt,
          imageId: imageCandidate.id,
        })}</p>`),
        text: alt,
      });
    }

    return buildBlock({
      type: 'paragraph',
      previewType: 'paragraph',
      html: sanitizeHtml(`<p>${buildRemoteImageLink(src, alt)}</p>`),
      text: alt,
    });
  }

  if (isImageDataUrl(src)) {
    ctx.dataImageCount += 1;
    if (ctx.includeImages) {
      const imageCandidate = registerImageCandidate(ctx, src, 'data', alt);
      return buildBlock({
        id: imageCandidate.id,
        type: 'image',
        previewType: 'image',
        html: sanitizeHtml(`<p>${buildManagedImageTag({
          src,
          alt,
          imageId: imageCandidate.id,
        })}</p>`),
        text: alt,
      });
    }

    return buildBlock({
      type: 'paragraph',
      previewType: 'paragraph',
      html: sanitizeHtml(`<p><code>${escapeHtml(`data:image ${alt}`)}</code></p>`),
      text: alt,
    });
  }

  ctx.localImageCount += 1;
  ctx.warnings.localImageDegraded += 1;
  return buildBlock({
    type: 'paragraph',
    previewType: 'paragraph',
    html: sanitizeHtml(`<p><code>${escapeHtml(`本地图片未上传：${src}`)}</code></p>`),
    text: src,
  });
}

function buildManagedImageTag(params: {
  src: string;
  alt: string;
  imageId: string;
}): string {
  const captionAttr = params.alt
    ? ` data-mowen-caption="${escapeHtmlAttribute(params.alt)}"`
    : '';

  return `<img src="${escapeHtmlAttribute(params.src)}" alt="${escapeHtmlAttribute(params.alt)}" data-mowen-id="${escapeHtmlAttribute(params.imageId)}"${captionAttr}>`;
}

function splitTextByUrls(text: string): Array<{ type: 'text' | 'url'; value: string }> {
  const result: Array<{ type: 'text' | 'url'; value: string }> = [];
  const regex = /https?:\/\/[^\s<>"')\]]+/gi;
  let lastIndex = 0;

  for (const match of text.matchAll(regex)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result.push({ type: 'text', value: text.slice(lastIndex, index) });
    }
    result.push({ type: 'url', value: matchText });
    lastIndex = index + matchText.length;
  }

  if (lastIndex < text.length) {
    result.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return result.length > 0 ? result : [{ type: 'text', value: text }];
}

function resolveMarkdownCodeLanguage(rawLanguage: string | undefined, codeText: string): string {
  const explicitLanguage = normalizeMarkdownFenceLanguage(rawLanguage);
  if (explicitLanguage) {
    return explicitLanguage;
  }

  return inferCodeLanguageFromText(codeText) || '';
}

function normalizeMarkdownFenceLanguage(rawLanguage: string | undefined): string | null {
  const candidate = rawLanguage?.trim().split(/\s+/, 1)[0] || '';
  if (!candidate) {
    return null;
  }

  return resolveShikiLanguageId(candidate) || candidate.toLowerCase();
}

async function tryRenderLineSplitParagraphBlocks(
  raw: string,
  ctx: ConversionContext
): Promise<InternalBlock[] | null> {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1 || !lines.some(isStandaloneImageMarkdownLine)) {
    return null;
  }

  const blocks: InternalBlock[] = [];
  for (const line of lines) {
    const lineTokens = marked.lexer(line) as Token[];
    const renderedBlocks = await renderTokenList(lineTokens, ctx);
    blocks.push(...renderedBlocks);
  }

  return blocks;
}

function isRemoteImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeLinkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value);
}

function isStandaloneImageMarkdownLine(line: string): boolean {
  return /^!\[[^\]]*\]\([^)]+\)$/.test(line.trim());
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${generateId()}`;
}

function normalizeCompareText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractMarkdownExcerptTitle(markdownBody: string): string {
  const normalized = markdownBody
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length <= 30) {
    return normalized;
  }

  const nextChar = normalized[30] || '';
  const excerpt = normalized.slice(0, 30);
  if (nextChar && !/\s/.test(nextChar)) {
    const lastSpace = excerpt.lastIndexOf(' ');
    if (lastSpace >= 0) {
      return excerpt.slice(0, lastSpace + 1);
    }
  }

  return excerpt;
}

function clampHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (level < 1) return 1;
  if (level > 6) return 6;
  return level as 1 | 2 | 3 | 4 | 5 | 6;
}

function extractHeadersFromHtmlTable(html: string): string[] {
  const headerMarkup = html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/i)?.[1];
  if (!headerMarkup) {
    return [];
  }

  return Array.from(headerMarkup.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((match) => stripHtml(match[1] || ''));
}

function extractRowsFromHtmlTable(html: string): string[][] {
  const tbodyMarkup = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!tbodyMarkup) {
    return [];
  }

  return Array.from(tbodyMarkup.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)).map((rowMatch) => (
    Array.from((rowMatch[1] || '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((cellMatch) => stripHtml(cellMatch[1] || ''))
  ));
}

function getByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;' :
      char === '<' ? '&lt;' :
        char === '>' ? '&gt;' :
          char === '"' ? '&quot;' : '&#39;'
  ));
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function sanitizeHtmlFallback(html: string): string {
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[\s\S]*?\2/gi, '');

  sanitized = sanitized.replace(/<\/?([a-z0-9-]+)(\s[^>]*)?>/gi, (full, rawTagName: string) => {
    const tagName = rawTagName.toLowerCase();
    if (!SAFE_HTML_TAG_SET.has(tagName)) {
      return '';
    }

    if (full.startsWith('</')) {
      return `</${tagName}>`;
    }

    return full.replace(/\s([a-z-:]+)\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, (attrMatch, rawAttrName: string) => {
      const attrName = rawAttrName.toLowerCase();
      return SAFE_HTML_ATTRS.includes(attrName) ? attrMatch : '';
    });
  });

  return sanitized;
}
