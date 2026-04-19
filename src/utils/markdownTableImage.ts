import { MarkdownTableArtifact } from '../types';

const DEFAULT_SCALE = 2;
const DEFAULT_MAX_WIDTH = 960;
const TABLE_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const HEADER_FONT = `600 14px ${TABLE_FONT_FAMILY}`;
const BODY_FONT = `14px ${TABLE_FONT_FAMILY}`;
const HEADER_BG = '#FBF5EF';
const BORDER_COLOR = '#E8E0DA';
const TEXT_COLOR = '#2B2521';
const MUTED_TEXT_COLOR = '#6B5F57';
const CELL_PADDING_X = 14;
const CELL_PADDING_Y = 10;
const LINE_HEIGHT = 20;
const MIN_COLUMN_WIDTH = 120;
const MAX_COLUMN_WIDTH = 320;

export interface RenderMarkdownTableArtifactOptions {
  id?: string;
  headers: string[];
  rows: string[][];
  align?: Array<'left' | 'center' | 'right' | null>;
  alt?: string;
  scale?: number;
  maxWidth?: number;
}

interface TableLayout {
  columnWidths: number[];
  rowHeights: number[];
  totalWidth: number;
  totalHeight: number;
  wrappedHeaderLines: string[][];
  wrappedBodyLines: string[][][];
}

export function buildMarkdownTableFallbackText(headers: string[], rows: string[][]): string {
  if (headers.length === 0) {
    return rows.map((row) => row.join(' | ')).join('\n');
  }

  const normalizedRows = rows.map((row) => headers.map((_, index) => normalizeCellText(row[index] || '')));
  const normalizedHeaders = headers.map((header) => normalizeCellText(header));
  const separator = normalizedHeaders.map(() => '---');

  return [
    `| ${normalizedHeaders.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...normalizedRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export async function renderMarkdownTableArtifact(
  options: RenderMarkdownTableArtifactOptions
): Promise<MarkdownTableArtifact> {
  const {
    headers,
    rows,
    align = [],
    alt = 'Markdown 表格',
    scale = DEFAULT_SCALE,
    maxWidth = DEFAULT_MAX_WIDTH,
  } = options;

  const artifactId = options.id || `md-table-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fallbackText = buildMarkdownTableFallbackText(headers, rows);
  const html = buildTableHtml(headers, rows, align);

  if (headers.length === 0) {
    return {
      id: artifactId,
      alt,
      html,
      fallbackText,
      success: false,
    };
  }

  const canvas = createCanvasElement();
  const context = canvas?.getContext('2d');
  if (!canvas || !context) {
    return {
      id: artifactId,
      alt,
      html,
      fallbackText,
      success: false,
    };
  }

  try {
    const layout = computeTableLayout(context, headers, rows, Math.max(maxWidth, MIN_COLUMN_WIDTH));
    canvas.width = Math.ceil(layout.totalWidth * scale);
    canvas.height = Math.ceil(layout.totalHeight * scale);

    const paintContext = canvas.getContext('2d');
    if (!paintContext) {
      throw new Error('CANVAS_CONTEXT_UNAVAILABLE');
    }

    paintContext.scale(scale, scale);
    paintContext.fillStyle = '#FFFFFF';
    paintContext.fillRect(0, 0, layout.totalWidth, layout.totalHeight);

    drawHeaderRow(paintContext, headers, align, layout);
    drawBodyRows(paintContext, rows, align, layout);
    drawOuterBorder(paintContext, layout.totalWidth, layout.totalHeight);

    return {
      id: artifactId,
      alt,
      dataUrl: canvas.toDataURL('image/png'),
      html,
      fallbackText,
      success: true,
      width: layout.totalWidth,
      height: layout.totalHeight,
    };
  } catch (error) {
    console.warn('[markdownTableImage] Failed to render table image:', error);
    return {
      id: artifactId,
      alt,
      html,
      fallbackText,
      success: false,
    };
  }
}

function buildTableHtml(
  headers: string[],
  rows: string[][],
  align: Array<'left' | 'center' | 'right' | null>
): string {
  const thead = `<thead><tr>${headers.map((header, index) => (
    `<th${buildAlignAttribute(align[index])}>${escapeHtml(normalizeCellText(header))}</th>`
  )).join('')}</tr></thead>`;

  const tbody = `<tbody>${rows.map((row) => (
    `<tr>${headers.map((_, index) => (
      `<td${buildAlignAttribute(align[index])}>${escapeHtml(normalizeCellText(row[index] || ''))}</td>`
    )).join('')}</tr>`
  )).join('')}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

function buildAlignAttribute(align: 'left' | 'center' | 'right' | null | undefined): string {
  return align ? ` align="${align}"` : '';
}

function createCanvasElement(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.createElement('canvas');
}

function computeTableLayout(
  context: CanvasRenderingContext2D,
  headers: string[],
  rows: string[][],
  maxWidth: number
): TableLayout {
  const columnCount = headers.length;
  const normalizedRows = rows.map((row) => headers.map((_, index) => normalizeCellText(row[index] || '')));
  const normalizedHeaders = headers.map((header) => normalizeCellText(header));

  context.font = BODY_FONT;
  const preferredWidths = headers.map((_header, index) => {
    const headerWidth = context.measureText(normalizedHeaders[index]).width + CELL_PADDING_X * 2;
    const rowWidth = normalizedRows.reduce((max, row) => {
      return Math.max(max, context.measureText(row[index]).width + CELL_PADDING_X * 2);
    }, 0);

    return clamp(Math.max(headerWidth, rowWidth), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
  });

  const targetInnerWidth = Math.max(maxWidth, columnCount * MIN_COLUMN_WIDTH);
  const currentWidth = preferredWidths.reduce((sum, width) => sum + width, 0);
  const scaleFactor = currentWidth > targetInnerWidth ? targetInnerWidth / currentWidth : 1;
  const columnWidths = preferredWidths.map((width) => clamp(Math.floor(width * scaleFactor), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH));

  let totalWidth = columnWidths.reduce((sum, width) => sum + width, 0);
  if (totalWidth > targetInnerWidth) {
    const overflow = totalWidth - targetInnerWidth;
    for (let index = columnWidths.length - 1; index >= 0 && totalWidth > targetInnerWidth; index--) {
      const reducible = columnWidths[index] - MIN_COLUMN_WIDTH;
      if (reducible <= 0) continue;
      const reduction = Math.min(reducible, overflow);
      columnWidths[index] -= reduction;
      totalWidth -= reduction;
    }
  }

  const wrappedHeaderLines = normalizedHeaders.map((header, index) => {
    context.font = HEADER_FONT;
    return wrapText(context, header, columnWidths[index] - CELL_PADDING_X * 2);
  });
  const headerHeight = wrappedHeaderLines.reduce((max, lines) => (
    Math.max(max, lines.length * LINE_HEIGHT + CELL_PADDING_Y * 2)
  ), LINE_HEIGHT + CELL_PADDING_Y * 2);

  const wrappedBodyLines = normalizedRows.map((row) => (
    row.map((cell, index) => {
      context.font = BODY_FONT;
      return wrapText(context, cell, columnWidths[index] - CELL_PADDING_X * 2);
    })
  ));

  const rowHeights = [
    headerHeight,
    ...wrappedBodyLines.map((rowLines) => rowLines.reduce((max, lines) => (
      Math.max(max, lines.length * LINE_HEIGHT + CELL_PADDING_Y * 2)
    ), LINE_HEIGHT + CELL_PADDING_Y * 2)),
  ];
  const totalHeight = rowHeights.reduce((sum, height) => sum + height, 0);

  return {
    columnWidths,
    rowHeights,
    totalWidth,
    totalHeight,
    wrappedHeaderLines,
    wrappedBodyLines,
  };
}

function drawHeaderRow(
  context: CanvasRenderingContext2D,
  headers: string[],
  align: Array<'left' | 'center' | 'right' | null>,
  layout: TableLayout
): void {
  let currentX = 0;
  const rowHeight = layout.rowHeights[0];

  headers.forEach((_header, index) => {
    const width = layout.columnWidths[index];
    context.fillStyle = HEADER_BG;
    context.fillRect(currentX, 0, width, rowHeight);
    context.strokeStyle = BORDER_COLOR;
    context.strokeRect(currentX, 0, width, rowHeight);
    context.font = HEADER_FONT;
    context.fillStyle = TEXT_COLOR;
    drawWrappedLines(
      context,
      layout.wrappedHeaderLines[index],
      currentX,
      0,
      width,
      rowHeight,
      align[index] || 'left'
    );
    currentX += width;
  });
}

function drawBodyRows(
  context: CanvasRenderingContext2D,
  rows: string[][],
  align: Array<'left' | 'center' | 'right' | null>,
  layout: TableLayout
): void {
  let currentY = layout.rowHeights[0];

  rows.forEach((_row, rowIndex) => {
    const rowHeight = layout.rowHeights[rowIndex + 1];
    let currentX = 0;

    layout.wrappedBodyLines[rowIndex].forEach((lines, columnIndex) => {
      const columnWidth = layout.columnWidths[columnIndex];
      context.fillStyle = '#FFFFFF';
      context.fillRect(currentX, currentY, columnWidth, rowHeight);
      context.strokeStyle = BORDER_COLOR;
      context.strokeRect(currentX, currentY, columnWidth, rowHeight);
      context.font = BODY_FONT;
      context.fillStyle = lines.length === 0 ? MUTED_TEXT_COLOR : TEXT_COLOR;
      drawWrappedLines(
        context,
        lines.length === 0 ? ['-'] : lines,
        currentX,
        currentY,
        columnWidth,
        rowHeight,
        align[columnIndex] || 'left'
      );
      currentX += columnWidth;
    });

    currentY += rowHeight;
  });
}

function drawWrappedLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  width: number,
  height: number,
  align: 'left' | 'center' | 'right'
): void {
  const contentHeight = lines.length * LINE_HEIGHT;
  const startY = y + Math.max(CELL_PADDING_Y + 12, (height - contentHeight) / 2 + 12);

  lines.forEach((line, lineIndex) => {
    const textY = startY + lineIndex * LINE_HEIGHT;
    if (align === 'center') {
      context.textAlign = 'center';
      context.fillText(line, x + width / 2, textY);
      return;
    }

    if (align === 'right') {
      context.textAlign = 'right';
      context.fillText(line, x + width - CELL_PADDING_X, textY);
      return;
    }

    context.textAlign = 'left';
    context.fillText(line, x + CELL_PADDING_X, textY);
  });
}

function drawOuterBorder(
  context: CanvasRenderingContext2D,
  totalWidth: number,
  totalHeight: number
): void {
  context.strokeStyle = BORDER_COLOR;
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, totalWidth - 1, totalHeight - 1);
}

function wrapText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number
): string[] {
  const normalized = normalizeCellText(value);
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split('\n').map((line) => line.trimEnd());
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      result.push('');
      continue;
    }

    const parts = paragraph.includes(' ')
      ? paragraph.split(/(\s+)/).filter(Boolean)
      : Array.from(paragraph);

    let currentLine = '';
    for (const part of parts) {
      const candidate = currentLine ? `${currentLine}${part}` : part.trimStart();
      if (context.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine) {
        result.push(currentLine.trimEnd());
        currentLine = part.trimStart();
        continue;
      }

      const splitLines = splitOversizedToken(context, part.trim(), maxWidth);
      result.push(...splitLines.slice(0, -1));
      currentLine = splitLines[splitLines.length - 1] || '';
    }

    if (currentLine) {
      result.push(currentLine.trimEnd());
    }
  }

  return result.length > 0 ? result : [''];
}

function splitOversizedToken(
  context: CanvasRenderingContext2D,
  token: string,
  maxWidth: number
): string[] {
  if (!token) {
    return [''];
  }

  const lines: string[] = [];
  let current = '';
  for (const char of Array.from(token)) {
    const candidate = current + char;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = char;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function normalizeCellText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;' :
      char === '<' ? '&lt;' :
        char === '>' ? '&gt;' :
          char === '"' ? '&quot;' : '&#39;'
  ));
}
