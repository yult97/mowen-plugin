/**
 * PDF 导出工具模块
 *
 * 使用 html2pdf.js 将 HTML 内容转换为 PDF 并触发下载。
 * 支持单篇导出和批量导出，内置打印友好的 CSS 样式。
 */

// html2pdf.js 没有官方的 TypeScript 类型声明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let html2pdfModule: any = null;

const PDF_PAGE_WIDTH_MM = 210;
const PDF_MARGIN_MM = 15;
const CSS_PX_PER_MM = 96 / 25.4;
const PDF_RENDER_WIDTH_PX = Math.floor((PDF_PAGE_WIDTH_MM - PDF_MARGIN_MM * 2) * CSS_PX_PER_MM);
const INTERNAL_NOTE_LINK_REGEX = /^(?:https?:\/\/(?:note|d-note|dev-note)\.mowen\.cn)?\/detail\/([^/?#]+)/i;
const INLINE_NOTE_REFERENCE_REGEX = /(?:<note\b[^>]*uuid=|data-note-uuid=|data-mowen-note-uuid=|<q\b[^>]*(?:uuid=|cite=)|<a\b[^>]*href="(?:https?:\/\/(?:note|d-note|dev-note)\.mowen\.cn)?\/detail\/[^"]+)/i;

type PdfChildNote = {
  uuid: string;
  title: string;
  digest?: string;
};

/**
 * 延迟加载 html2pdf 模块
 */
async function getHtml2Pdf() {
  if (!html2pdfModule) {
    // 动态导入，减小初始 bundle 体积
    const module = await import('html2pdf.js');
    html2pdfModule = module.default || module;
  }
  return html2pdfModule;
}

/**
 * 打印友好的 CSS 样式
 * 确保 PDF 中的文章排版清晰可读
 */
const PDF_STYLES = `
  <style>
    * {
      box-sizing: border-box;
    }
    body, .pdf-content {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
      font-size: 14px;
      line-height: 1.9;
      color: #1F2937;
      max-width: 100%;
      padding: 0;
      margin: 0;
      word-wrap: break-word;
      overflow-wrap: break-word;
      text-rendering: optimizeLegibility;
    }
    .pdf-content, .pdf-body {
      width: 100%;
      max-width: 100%;
      overflow: visible;
    }
    .pdf-title {
      font-size: 22px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .pdf-meta {
      font-size: 12px;
      color: #9CA3AF;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #E5E7EB;
    }
    .pdf-content.pdf-page-break {
      break-before: page;
      page-break-before: always;
    }
    /* 标题 */
    .pdf-body h1, .pdf-body h2, .pdf-body h3, .pdf-body h4, .pdf-body h5, .pdf-body h6 {
      margin-top: 1.2em;
      margin-bottom: 0.6em;
      font-weight: 600;
      color: #111827;
      line-height: 1.4;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .pdf-body h1 { font-size: 20px; }
    .pdf-body h2 { font-size: 18px; }
    .pdf-body h3 { font-size: 16px; }
    .pdf-body h4 { font-size: 15px; }
    .pdf-body h5 { font-size: 14px; }
    .pdf-body h6 { font-size: 13px; color: #4B5563; }
    /* 段落 */
    .pdf-body p {
      margin: 0.6em 0;
      line-height: 1.9;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    /* 图片 */
    .pdf-body img,
    .pdf-body svg,
    .pdf-body canvas,
    .pdf-body video,
    .pdf-body iframe {
      max-width: 100% !important;
      height: auto !important;
      margin: 8px 0;
      border-radius: 4px;
      display: block;
    }
    .pdf-body figure {
      margin: 12px 0;
      padding: 0;
      max-width: 100% !important;
    }
    .pdf-body figcaption {
      font-size: 12px;
      color: #9CA3AF;
      text-align: center;
      margin-top: 6px;
    }
    .pdf-body figure,
    .pdf-body table,
    .pdf-body blockquote,
    .pdf-body pre,
    .pdf-body img {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    /* 引用块 - 增强样式确保可见 */
    .pdf-body blockquote {
      margin: 12px 0 !important;
      padding: 10px 16px !important;
      border-left: 4px solid #BF4045 !important;
      background: #FBF5EF !important;
      color: #4B5563 !important;
      border-radius: 0 6px 6px 0;
      font-style: italic;
    }
    .pdf-body blockquote p {
      margin: 4px 0;
    }
    .pdf-body blockquote blockquote {
      margin-left: 8px !important;
      border-left-color: #D1D5DB !important;
    }
    /* 代码块 */
    .pdf-body pre {
      margin: 12px 0 !important;
      padding: 14px !important;
      background: #1F2937 !important;
      color: #E5E7EB !important;
      border-radius: 8px !important;
      overflow-x: auto;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace !important;
      font-size: 13px !important;
      line-height: 1.5 !important;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .pdf-body pre code {
      background: transparent !important;
      padding: 0 !important;
      color: inherit !important;
      font-size: inherit !important;
    }
    .pdf-body code {
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 13px;
      background: #F3F4F6;
      color: #BF4045;
      padding: 2px 6px;
      border-radius: 4px;
    }
    /* 链接 */
    .pdf-body a {
      color: #BF4045;
      text-decoration: underline;
    }
    /* 列表 */
    .pdf-body ul, .pdf-body ol {
      padding-left: 24px;
      margin: 8px 0;
    }
    .pdf-body li {
      margin: 4px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .pdf-body li > p {
      margin: 2px 0;
    }
    /* 表格 */
    .pdf-body table {
      width: 100% !important;
      max-width: 100% !important;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 13px;
    }
    .pdf-body th, .pdf-body td {
      border: 1px solid #E5E7EB;
      padding: 8px 10px;
      text-align: left;
      white-space: normal !important;
      word-break: break-word;
      overflow-wrap: anywhere;
      vertical-align: top;
    }
    .pdf-body th {
      background: #F9FAFB;
      font-weight: 600;
    }
    .pdf-body tr:nth-child(even) {
      background: #FAFAFA;
    }
    /* 分割线 */
    .pdf-body hr {
      border: none;
      border-top: 1px solid #E5E7EB;
      margin: 20px 0;
    }
    /* 高亮/标记 */
    .pdf-body mark {
      background: #FEF3C7;
      color: #92400E;
      padding: 1px 4px;
      border-radius: 2px;
    }
    /* 删除线 */
    .pdf-body del, .pdf-body s {
      text-decoration: line-through;
      color: #9CA3AF;
    }
    /* 粗体/斜体 */
    .pdf-body strong, .pdf-body b {
      font-weight: 600;
      color: #111827;
    }
    .pdf-body em, .pdf-body i {
      font-style: italic;
    }
    /* 上下标 */
    .pdf-body sup { font-size: 0.75em; vertical-align: super; }
    .pdf-body sub { font-size: 0.75em; vertical-align: sub; }
    /* 折叠块 */
    .pdf-body details {
      margin: 8px 0;
      padding: 8px 12px;
      border: 1px solid #E5E7EB;
      border-radius: 6px;
      max-width: 100% !important;
    }
    .pdf-body summary {
      font-weight: 600;
      cursor: pointer;
    }
    /* 视频/嵌入 占位 */
    .pdf-body video, .pdf-body iframe, .pdf-body embed {
      max-width: 100%;
      background: #F3F4F6;
    }
    /* 引用笔记 */
    .pdf-body .mowen-note-ref,
    .pdf-body [data-note-uuid].mowen-note-ref,
    .pdf-body blockquote.mowen-note-ref {
      display: block;
      margin: 10px 0 !important;
      padding: 0 !important;
      background: transparent !important;
      border: none !important;
      border-left: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      color: #BF4045 !important;
      font-style: normal !important;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .pdf-body .mowen-note-ref-link,
    .pdf-body .mowen-note-ref-link *,
    .pdf-body a.mowen-note-ref-link {
      color: #BF4045 !important;
      text-decoration: none !important;
      border-bottom: none !important;
      box-shadow: none !important;
      font-style: normal !important;
      background: transparent !important;
    }
    .pdf-body .mowen-note-ref-link {
      display: inline;
      font-size: 15px;
      line-height: 1.8;
      font-weight: 500;
      word-break: break-word;
    }
    .pdf-body .child-notes-section {
      margin-top: 16px;
    }
  </style>
`;

function parseCssPixelValue(value: string): number | null {
  const normalized = value.trim();
  if (!normalized.endsWith('px')) return null;

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWideContentForPdf(container: HTMLElement): void {
  const pdfBodies = Array.from(container.querySelectorAll<HTMLElement>('.pdf-body'));
  if (pdfBodies.length === 0) return;

  for (const pdfBody of pdfBodies) {
    const contentWidth = Math.floor(pdfBody.clientWidth || container.clientWidth);
    if (!contentWidth) continue;

    const allElements = Array.from(pdfBody.querySelectorAll<HTMLElement>('*'));

    for (const element of allElements) {
      const computed = getComputedStyle(element);
      const minWidth = parseCssPixelValue(computed.minWidth);
      const width = parseCssPixelValue(computed.width);

      if (minWidth !== null && minWidth > contentWidth) {
        element.style.minWidth = '0';
      }

      if (
        width !== null &&
        width > contentWidth &&
        !['IMG', 'TABLE', 'TD', 'TH'].includes(element.tagName)
      ) {
        element.style.width = '100%';
      }

      if (element instanceof HTMLImageElement) {
        element.style.maxWidth = '100%';
        element.style.height = 'auto';
        if (element.naturalWidth > contentWidth) {
          element.style.width = '100%';
        }
        continue;
      }

      if (element instanceof HTMLTableElement) {
        if (element.scrollWidth > contentWidth + 2) {
          element.style.width = '100%';
          element.style.maxWidth = '100%';
          element.style.tableLayout = 'fixed';
        }
        continue;
      }

      if (element.tagName === 'TD' || element.tagName === 'TH') {
        element.style.whiteSpace = 'normal';
        element.style.wordBreak = 'break-word';
        element.style.overflowWrap = 'anywhere';
        continue;
      }

      if (
        element.scrollWidth > contentWidth + 2 &&
        ['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'FIGURE', 'BLOCKQUOTE', 'DETAILS'].includes(element.tagName)
      ) {
        element.style.maxWidth = '100%';
        if (computed.overflowX !== 'visible') {
          element.style.overflowX = 'visible';
        }
      }
    }
  }
}

/**
 * 清理文件名，移除非法字符
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')  // 移除文件名非法字符
    .replace(/\s+/g, ' ')           // 合并空白
    .trim()
    .substring(0, 100);             // 限制长度
}

function extractInternalNoteUuid(href: string): string | null {
  const normalized = href.trim();
  if (!normalized) return null;

  const match = normalized.match(INTERNAL_NOTE_LINK_REGEX);
  return match?.[1] || null;
}

function hasInlineNoteReferenceMarkers(html: string): boolean {
  return INLINE_NOTE_REFERENCE_REGEX.test(html);
}

function encodeNoteRefsAttributeValue(noteRefs?: PdfChildNote[]): string {
  if (!noteRefs || noteRefs.length === 0) {
    return '';
  }

  const normalized = noteRefs
    .filter((note) => note.uuid && note.title)
    .map((note) => ({
      uuid: note.uuid.trim(),
      title: note.title.trim(),
      digest: note.digest?.trim() || '',
    }))
    .filter((note) => note.uuid && note.title);

  if (normalized.length === 0) {
    return '';
  }

  return escapeHtml(encodeURIComponent(JSON.stringify(normalized)));
}

function parseNoteRefsAttributeValue(encoded: string | undefined): PdfChildNote[] {
  if (!encoded) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is PdfChildNote => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Partial<PdfChildNote>;
        return typeof candidate.uuid === 'string' && typeof candidate.title === 'string';
      })
      .map((item) => ({
        uuid: item.uuid.trim(),
        title: item.title.trim(),
        digest: item.digest?.trim() || '',
      }))
      .filter((item) => item.uuid && item.title);
  } catch {
    return [];
  }
}

function normalizeReferenceText(text: string): string {
  return text
    .replace(/📄/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNoteReferenceUuidFromElement(element: Element): string | null {
  const directUuid = element.getAttribute('data-note-uuid')
    || element.getAttribute('data-mowen-note-uuid')
    || element.getAttribute('uuid');
  if (directUuid?.trim()) {
    return directUuid.trim();
  }

  const cite = element.getAttribute('cite');
  if (cite) {
    const citeUuid = extractInternalNoteUuid(cite);
    if (citeUuid) {
      return citeUuid;
    }
  }

  if (element instanceof HTMLAnchorElement) {
    const anchorUuid = extractInternalNoteUuid(element.getAttribute('href') || '');
    if (anchorUuid) {
      return anchorUuid;
    }
  }

  const internalAnchor = element.querySelector<HTMLAnchorElement>('a[href]');
  if (internalAnchor) {
    return extractInternalNoteUuid(internalAnchor.getAttribute('href') || '');
  }

  return null;
}

function extractNoteReferenceTitleFromElement(element: HTMLElement): string {
  const explicitTitle = element.getAttribute('data-note-title')?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const anchor = element.querySelector<HTMLAnchorElement>('a[href]');
  const anchorText = normalizeReferenceText(anchor?.textContent || '');
  if (anchorText) {
    return anchorText;
  }

  return normalizeReferenceText(element.textContent || '') || '查看笔记';
}

function isLikelyNoteReferenceElement(element: HTMLElement): boolean {
  if (element.classList.contains('mowen-note-ref')) {
    return true;
  }

  if (
    element.dataset.noteUuid
    || element.getAttribute('data-note-uuid')
    || element.getAttribute('data-mowen-note-uuid')
    || element.getAttribute('uuid')
  ) {
    return true;
  }

  const internalLinks = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => extractInternalNoteUuid(anchor.getAttribute('href') || ''));

  if (internalLinks.length !== 1) {
    return false;
  }

  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  const linkText = (internalLinks[0].textContent || '').replace(/\s+/g, ' ').trim();
  if (!text || !linkText) {
    return false;
  }

  const extraText = text
    .replace(linkText, '')
    .replace(/📄/gu, '')
    .replace(/\s+/g, '');
  return extraText.length <= 8;
}

function normalizeNoteReferenceElements(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const pdfBodies = Array.from(container.querySelectorAll<HTMLElement>('.pdf-body'));
  if (pdfBodies.length === 0) return;

  for (const pdfBody of pdfBodies) {
    const internalAnchors = Array.from(pdfBody.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter((anchor) => extractInternalNoteUuid(anchor.getAttribute('href') || ''));

    for (const anchor of internalAnchors) {
      const uuid = extractInternalNoteUuid(anchor.getAttribute('href') || '');
      if (!uuid) continue;

      anchor.setAttribute('href', `https://note.mowen.cn/detail/${uuid}`);
      anchor.classList.add('mowen-note-ref-link');
      anchor.style.textDecoration = 'none';
      anchor.style.borderBottom = 'none';

      const containerBlock = anchor.closest<HTMLElement>('blockquote, p, div');
      if (!containerBlock || !pdfBody.contains(containerBlock)) {
        continue;
      }

      if (!isLikelyNoteReferenceElement(containerBlock)) {
        continue;
      }

      if (containerBlock.tagName === 'BLOCKQUOTE') {
        const paragraph = doc.createElement('p');
        paragraph.className = 'mowen-note-ref';
        const source = containerBlock.children.length === 1 && containerBlock.firstElementChild?.tagName === 'P'
          ? containerBlock.firstElementChild as HTMLElement
          : containerBlock;

        while (source.firstChild) {
          paragraph.appendChild(source.firstChild);
        }

        containerBlock.replaceWith(paragraph);
        continue;
      }

      containerBlock.classList.add('mowen-note-ref');
      containerBlock.removeAttribute('type');
    }

    const attributeCandidates = Array.from(pdfBody.querySelectorAll<HTMLElement>(
      '[data-note-uuid], [data-mowen-note-uuid], note[uuid], q[uuid], q[cite]'
    ));

    for (const candidate of attributeCandidates) {
      const uuid = extractNoteReferenceUuidFromElement(candidate);
      if (!uuid) continue;

      candidate.classList.add('mowen-note-ref');
      candidate.setAttribute('data-note-uuid', uuid);
    }
  }
}

function resolveNoteReferenceRenderBlock(element: HTMLElement, pdfBody: HTMLElement): HTMLElement | null {
  const directBlock = element.closest<HTMLElement>('blockquote, p, div, li, section, article, note, q');
  const baseBlock = directBlock && pdfBody.contains(directBlock) ? directBlock : element;

  const parent = baseBlock.parentElement;
  if (!parent || !pdfBody.contains(parent)) {
    return baseBlock;
  }

  if (!['P', 'DIV', 'BLOCKQUOTE', 'LI', 'SECTION', 'ARTICLE'].includes(parent.tagName)) {
    return baseBlock;
  }

  const parentText = normalizeReferenceText(parent.textContent || '');
  const blockText = normalizeReferenceText(baseBlock.textContent || '');
  if (!parentText || !blockText) {
    return baseBlock;
  }

  if (parentText === blockText && parent.children.length === 1) {
    return parent;
  }

  return baseBlock;
}

function createNoteReferenceCard(
  doc: Document,
  note: PdfChildNote
): HTMLElement {
  const wrapper = doc.createElement('p');
  wrapper.className = 'mowen-note-ref';
  wrapper.setAttribute('data-note-uuid', note.uuid);
  wrapper.setAttribute('data-note-title', note.title);

  const link = doc.createElement('a');
  link.className = 'mowen-note-ref-link';
  link.href = `https://note.mowen.cn/detail/${note.uuid}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = note.title;
  wrapper.appendChild(link);
  return wrapper;
}

function renderNoteReferenceCards(container: HTMLElement): void {
  const pdfBodies = Array.from(container.querySelectorAll<HTMLElement>('.pdf-body'));

  for (const pdfBody of pdfBodies) {
    const noteRefs = parseNoteRefsAttributeValue(pdfBody.dataset.noteRefs);
    const allowFallbackAppend = pdfBody.dataset.noteRefsFallback === 'append';
    const hasInlineMarkers = hasInlineNoteReferenceMarkers(pdfBody.innerHTML);
    const noteRefMap = new Map(noteRefs.map((note) => [note.uuid, note]));
    const renderedUuids = new Set<string>();
    const blocks = new Set<HTMLElement>();

    const directCandidates = Array.from(pdfBody.querySelectorAll<HTMLElement>(
      '.mowen-note-ref, [data-note-uuid], [data-mowen-note-uuid], note[uuid], q[uuid], q[cite]'
    ));
    const anchorCandidates = Array.from(pdfBody.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter((anchor) => extractInternalNoteUuid(anchor.getAttribute('href') || ''));

    for (const candidate of [...directCandidates, ...anchorCandidates]) {
      const block = resolveNoteReferenceRenderBlock(candidate, pdfBody);
      if (!block || !pdfBody.contains(block)) {
        continue;
      }

      const uuid = extractNoteReferenceUuidFromElement(block) || extractNoteReferenceUuidFromElement(candidate);
      if (!uuid) {
        continue;
      }

      if (!block.classList.contains('mowen-note-ref') && !isLikelyNoteReferenceElement(block)) {
        continue;
      }

      blocks.add(block);
    }

    for (const block of blocks) {
      const uuid = extractNoteReferenceUuidFromElement(block);
      if (!uuid) continue;

      const note = noteRefMap.get(uuid) || {
        uuid,
        title: extractNoteReferenceTitleFromElement(block),
      };

      const card = createNoteReferenceCard(container.ownerDocument, note);
      block.replaceWith(card);
      renderedUuids.add(uuid);
    }

    const missingRefs = noteRefs.filter((note) => !renderedUuids.has(note.uuid));
    const shouldAppendMissingRefs = allowFallbackAppend || hasInlineMarkers;
    if (missingRefs.length > 0 && shouldAppendMissingRefs) {
      const fallbackSection = container.ownerDocument.createElement('div');
      fallbackSection.className = 'child-notes-section';

      for (const note of missingRefs) {
        fallbackSection.appendChild(createNoteReferenceCard(container.ownerDocument, note));
      }

      pdfBody.appendChild(fallbackSection);
    }

    pdfBody.removeAttribute('data-note-refs');
    pdfBody.removeAttribute('data-note-refs-fallback');
  }
}

/**
 * 从 HTML 中移除所有 img 标签（用于"不保留图片"导出模式）
 */
function stripImagesFromHtml(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<figure[^>]*>\s*<\/figure>/gi, '')
    .replace(/<picture[^>]*>[\s\S]*?<\/picture>/gi, '');
}

/**
 * 构建 PDF 渲染用的 HTML 内容
 */
function buildPdfHtml(
  title: string,
  htmlContent: string,
  options?: {
    sourceUrl?: string;
    childNotes?: PdfChildNote[];
    skipImages?: boolean;
  }
): string {
  const sourceInfo = options?.sourceUrl
    ? `<div class="pdf-meta">来源：${escapeHtml(options.sourceUrl)}</div>`
    : '';
  const noteRefsAttributeValue = encodeNoteRefsAttributeValue(options?.childNotes);
  const noteRefsAttribute = noteRefsAttributeValue
    ? ` data-note-refs="${noteRefsAttributeValue}"`
    : '';
  const noteRefsFallbackAttribute = noteRefsAttributeValue && !hasInlineNoteReferenceMarkers(htmlContent)
    ? ' data-note-refs-fallback="append"'
    : '';

  // 不保留图片模式：从 HTML 中移除所有 img 标签
  const processedContent = options?.skipImages
    ? stripImagesFromHtml(htmlContent)
    : htmlContent;

  return `
    ${PDF_STYLES}
    <div class="pdf-content">
      <div class="pdf-title">${escapeHtml(title)}</div>
      ${sourceInfo}
      <div class="pdf-body"${noteRefsAttribute}${noteRefsFallbackAttribute}>
        ${processedContent}
      </div>
    </div>
  `;
}

function createPdfRenderContainer(fullHtml: string): {
  host: HTMLDivElement;
  container: HTMLDivElement;
} {
  // 使用离屏宿主容器，避免导出时把当前页面布局撑动或触发滚动抖动。
  // 真正参与渲染的内容仍保持普通文档流，降低 html2canvas 克隆时的异常概率。
  const host = document.createElement('div');
  host.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: -100000px',
    `width: ${PDF_RENDER_WIDTH_PX}px`,
    'opacity: 0',
    'pointer-events: none',
    'z-index: -1',
    'overflow: hidden',
  ].join('; ');

  const container = document.createElement('div');
  container.style.cssText = `width: ${PDF_RENDER_WIDTH_PX}px; background: white;`;
  container.innerHTML = fullHtml;

  host.appendChild(container);
  document.body.appendChild(host);

  return { host, container };
}

/**
 * HTML 特殊字符转义
 */
function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => entities[char]);
}

/**
 * 通过 Background SW 代理预下载所有图片，将 src 替换为 base64 data URL
 *
 * 扩展页面（chrome-extension://）受 CORS 限制，html2canvas 无法
 * 将跨域图片绘制到 Canvas。通过 Background SW 代理下载并转为
 * data URL 后，图片变为内联数据，完全绕过 CORS。
 *
 * @param container 已插入 DOM 的 HTML 容器
 */
async function preloadImagesViaBackground(container: HTMLElement): Promise<void> {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return;

  // 并发控制：最多同时下载 3 张
  const CONCURRENCY = 3;
  const queue = Array.from(images);

  async function downloadOne(img: HTMLImageElement): Promise<void> {
    const originalSrc = img.getAttribute('src')?.trim() || '';

    // 跳过已经是 data URL 的图片
    if (originalSrc.startsWith('data:')) {
      return;
    }

    // 跳过空 src
    if (!originalSrc || originalSrc === 'about:blank') {
      console.warn('[pdfExporter] 跳过无效图片 src，无法预下载');
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_AS_DATA_URL',
        payload: { url: originalSrc },
      });

      if (response?.success && response.dataUrl) {
        img.src = response.dataUrl;
      } else {
        // 下载失败，保留原 src（html2canvas 会尝试加载）
        console.warn('[pdfExporter] 图片下载失败');
      }
    } catch (error) {
      console.warn('[pdfExporter] 图片下载异常', error);
    }
  }

  // 分批并发下载
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(img => downloadOne(img)));
  }
}

/**
 * 等待容器内所有图片加载完成
 * @param container DOM 容器
 * @param timeout 最大等待时间（ms）
 */
async function waitForImages(container: HTMLElement, timeout = 8000): Promise<void> {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return;

  const promises = Array.from(images).map((img) => {
    if (img.complete && img.naturalHeight > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve(); // 加载失败也继续，不阻塞导出
    });
  });

  // 附加总超时，避免图片永远无法加载时无限等待
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => setTimeout(resolve, timeout)),
  ]);
}

/**
 * 等待两个渲染帧，确保浏览器完成 style 标签解析和样式计算
 */
function waitForRender(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function prepareContainerForPdf(
  container: HTMLElement,
  options?: { skipImages?: boolean }
): Promise<void> {
  await waitForRender();
  normalizeNoteReferenceElements(container);
  renderNoteReferenceCards(container);
  normalizeWideContentForPdf(container);
  await waitForRender();

  if (!options?.skipImages) {
    await preloadImagesViaBackground(container);
    await waitForImages(container);
  }
}

/**
 * 导出单篇文章为 PDF
 *
 * @param title 文章标题
 * @param htmlContent HTML 正文内容
 * @param options 可选参数（来源 URL、合集子笔记等）
 */
export async function exportSinglePdf(
  title: string,
  htmlContent: string,
  options?: {
    sourceUrl?: string;
    childNotes?: PdfChildNote[];
    skipImages?: boolean;
  }
): Promise<void> {
  const html2pdf = await getHtml2Pdf();

  const fileName = sanitizeFileName(title) || '导出笔记';
  const fullHtml = buildPdfHtml(title, htmlContent, options);

  // 创建离屏渲染容器，避免导出时影响当前页面滚动和布局。
  const { host, container } = createPdfRenderContainer(fullHtml);

  try {
    await prepareContainerForPdf(container, options);

    await html2pdf()
      .set({
        margin: [PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM],
        filename: `${fileName}.pdf`,
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: {
          scale: 2,            // 提高清晰度
          useCORS: true,       // 尝试以 CORS 方式加载跨域图片
          allowTaint: true,    // 允许跨域图片污染 canvas（确保图片可见）
          logging: false,
          windowWidth: PDF_RENDER_WIDTH_PX,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: ['img', 'figure', 'table', 'blockquote', 'pre', 'p', 'li', '.mowen-note-ref', '.mowen-note-ref-link'],
        },
      })
      .from(container)
      .save();
  } finally {
    // 无论成功还是失败，都清理 DOM 容器
    if (host.parentNode) {
      document.body.removeChild(host);
    }
  }
}

/**
 * 生成单篇笔记的 PDF Blob（不触发下载）
 * 与 exportSinglePdf 共享相同渲染管线，但返回 Blob 供 zip 打包使用
 */
export async function generatePdfBlob(
  title: string,
  htmlContent: string,
  options?: {
    sourceUrl?: string;
    childNotes?: PdfChildNote[];
    skipImages?: boolean;
  }
): Promise<Blob> {
  const html2pdf = await getHtml2Pdf();

  const fullHtml = buildPdfHtml(title, htmlContent, options);

  const { host, container } = createPdfRenderContainer(fullHtml);

  try {
    await prepareContainerForPdf(container, options);

    // 使用 outputPdf('blob') 获取 Blob 而非直接下载
    const blob: Blob = await html2pdf()
      .set({
        margin: [PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM],
        filename: 'temp.pdf',
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          windowWidth: PDF_RENDER_WIDTH_PX,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: ['img', 'figure', 'table', 'blockquote', 'pre', 'p', 'li', '.mowen-note-ref', '.mowen-note-ref-link'],
        },
      })
      .from(container)
      .outputPdf('blob');

    return blob;
  } finally {
    if (host.parentNode) {
      document.body.removeChild(host);
    }
  }
}

/**
 * 批量导出多篇笔记为 PDF
 * 逐个生成并下载，每个之间间隔 500ms 避免内存溢出
 *
 * @param notes 笔记列表（需包含标题和 HTML 内容）
 * @param onProgress 进度回调
 */
export async function exportBatchPdf(
  notes: Array<{ title: string; htmlContent: string; sourceUrl?: string }>,
  onProgress?: (current: number, total: number, title: string) => void
): Promise<{ success: number; failed: number; errors: string[] }> {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    onProgress?.(i + 1, notes.length, note.title);

    try {
      await exportSinglePdf(note.title, note.htmlContent, {
        sourceUrl: note.sourceUrl,
      });
      success++;
    } catch (error) {
      failed++;
      const errMsg = error instanceof Error ? error.message : '未知错误';
      errors.push(`${note.title}: ${errMsg}`);
      console.error('[pdfExporter] exportBatchPdf error:', error);
    }

    // 间隔 500ms，避免浏览器内存压力
    if (i < notes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return { success, failed, errors };
}

/**
 * 合并导出多篇笔记为单个 PDF
 * 将所有笔记内容拼接在一起，每篇之间用分页符分隔
 *
 * @param notes 笔记列表
 * @param options 导出选项
 */
export async function exportMergedPdf(
  notes: Array<{
    title: string;
    htmlContent: string;
    sourceUrl?: string;
    childNotes?: PdfChildNote[];
  }>,
  options?: {
    fileName?: string;
    skipImages?: boolean;
  }
): Promise<void> {
  const html2pdf = await getHtml2Pdf();

  // 构建合并后的 HTML：每篇之间用分页符分隔
  const mergedSections = notes.map((note, index) => {
    const processedContent = options?.skipImages
      ? stripImagesFromHtml(note.htmlContent)
      : note.htmlContent;
    const noteRefsAttributeValue = encodeNoteRefsAttributeValue(note.childNotes);
    const noteRefsAttribute = noteRefsAttributeValue
      ? ` data-note-refs="${noteRefsAttributeValue}"`
      : '';
    const noteRefsFallbackAttribute = noteRefsAttributeValue && !hasInlineNoteReferenceMarkers(note.htmlContent)
      ? ' data-note-refs-fallback="append"'
      : '';

    // 第一篇不加分页符，后续篇前加分页符
    const sectionClass = index > 0 ? 'pdf-content pdf-page-break' : 'pdf-content';

    return `
      <div class="${sectionClass}">
        <div class="pdf-title">${escapeHtml(note.title)}</div>
        <div class="pdf-body"${noteRefsAttribute}${noteRefsFallbackAttribute}>
          ${processedContent}
        </div>
      </div>
    `;
  });

  const fullHtml = `
    ${PDF_STYLES}
    ${mergedSections.join('')}
  `;

  // 文件名：使用自定义名称或默认名称
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const fileName = options?.fileName
    ? sanitizeFileName(options.fileName)
    : `笔记导出_${dateStr}`;

  // 创建 DOM 容器
  const { host, container } = createPdfRenderContainer(fullHtml);

  try {
    await prepareContainerForPdf(container, options);

    await html2pdf()
      .set({
        margin: [PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM, PDF_MARGIN_MM],
        filename: `${fileName}.pdf`,
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          windowWidth: PDF_RENDER_WIDTH_PX,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          before: '.pdf-page-break',
          avoid: ['img', 'figure', 'table', 'blockquote', 'pre', 'p', 'li', '.mowen-note-ref', '.mowen-note-ref-link'],
        },
      })
      .from(container)
      .save();
  } finally {
    if (host.parentNode) {
      document.body.removeChild(host);
    }
  }
}

/**
 * 批量导出多篇笔记为 ZIP 压缩包
 * 逐个生成 PDF Blob → 用 JSZip 打包 → 下载为 zip 文件
 *
 * @param notes 笔记列表
 * @param options 导出选项
 * @param onProgress 进度回调
 */
export async function exportBatchAsZip(
  notes: Array<{
    uuid?: string;
    title: string;
    htmlContent: string;
    sourceUrl?: string;
    childNotes?: PdfChildNote[];
  }>,
  options?: {
    zipFileName?: string;
    skipImages?: boolean;
  },
  onProgress?: (current: number, total: number, title: string) => void
): Promise<{
  success: number;
  failed: number;
  errors: string[];
  failedNotes: Array<{ uuid?: string; title: string; error: string }>;
}> {
  if (notes.length === 0) {
    return { success: 0, failed: 0, errors: [], failedNotes: [] };
  }

  if (notes.length === 1) {
    const [note] = notes;
    onProgress?.(1, 1, note.title);

    try {
      await exportSinglePdf(note.title, note.htmlContent, {
        sourceUrl: note.sourceUrl,
        childNotes: note.childNotes,
        skipImages: options?.skipImages,
      });
      return { success: 1, failed: 0, errors: [], failedNotes: [] };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      console.error('[pdfExporter] exportBatchAsZip single export error:', error);
      return {
        success: 0,
        failed: 1,
        errors: [`${note.title}: ${errMsg}`],
        failedNotes: [{ uuid: note.uuid, title: note.title, error: errMsg }],
      };
    }
  }

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  const failedNotes: Array<{ uuid?: string; title: string; error: string }> = [];

  // 用于处理重名文件
  const usedNames = new Map<string, number>();

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    onProgress?.(i + 1, notes.length, note.title);

    try {
      const blob = await generatePdfBlob(note.title, note.htmlContent, {
        sourceUrl: note.sourceUrl,
        childNotes: note.childNotes,
        skipImages: options?.skipImages,
      });

      // 生成不重名的文件名
      const baseName = sanitizeFileName(note.title) || '导出笔记';
      const count = usedNames.get(baseName) || 0;
      usedNames.set(baseName, count + 1);
      const fileName = count > 0 ? `${baseName} (${count}).pdf` : `${baseName}.pdf`;

      zip.file(fileName, blob);
      success++;
    } catch (error) {
      failed++;
      const errMsg = error instanceof Error ? error.message : '未知错误';
      errors.push(`${note.title}: ${errMsg}`);
      failedNotes.push({ uuid: note.uuid, title: note.title, error: errMsg });
      console.error('[pdfExporter] exportBatchAsZip error:', error);
    }

    // 间隔 300ms，避免浏览器内存压力
    if (i < notes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  // 生成 zip 文件并触发下载
  if (success > 0) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const zipFileName = options?.zipFileName
      ? sanitizeFileName(options.zipFileName)
      : `笔记导出_${dateStr}`;

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${zipFileName}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return { success, failed, errors, failedNotes };
}
