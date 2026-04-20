import { MarkdownPreviewModel, MarkdownPreviewNode } from '../types';
import { stripHtml } from './helpers';

export interface MarkdownPreviewRenderableBlock {
  id: string;
  type: MarkdownPreviewNode['type'];
  html: string;
  text?: string;
  level?: number;
}

export interface CreateMarkdownPreviewModelInput {
  title: string;
  blocks: MarkdownPreviewRenderableBlock[];
}

export function createMarkdownPreviewModel(
  input: CreateMarkdownPreviewModelInput
): MarkdownPreviewModel {
  return {
    title: input.title.trim(),
    blocks: input.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      html: block.html,
      text: block.text || stripHtml(block.html),
      level: block.level,
    })),
  };
}

function renderPreviewBlock(block: MarkdownPreviewRenderableBlock): string {
  const className = `md-import-preview-block md-import-preview-block-${block.type}`;
  return `<section class="${className}" data-preview-block-id="${escapeHtml(block.id)}">${block.html}</section>`;
}

export function renderMarkdownPreviewBodyHtml(
  blocks: MarkdownPreviewRenderableBlock[]
): string {
  return blocks.length > 0
    ? blocks.map((block) => renderPreviewBlock(block)).join('')
    : '<div class="md-import-preview-empty">暂无可预览内容</div>';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;' :
      char === '<' ? '&lt;' :
        char === '>' ? '&gt;' :
          char === '"' ? '&quot;' : '&#39;'
  ));
}
