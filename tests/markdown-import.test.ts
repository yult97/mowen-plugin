import assert from 'node:assert/strict';
import test from 'node:test';

import type { MarkdownImportResult, MarkdownTableArtifact } from '../src/types';
import { convertMarkdownImport } from '../src/utils/markdownImport';
import { renderMarkdownPreviewBodyHtml } from '../src/utils/markdownPreview';
import { inferCodeLanguageFromText, resolveShikiLanguageId } from '../src/utils/shikiLanguages';

const OPTIONAL_SPACING_PATTERN = '(?:\\s|\\u00A0|\\u200B|\\u200C|\\u200D|\\u2060|\\uFEFF)*';

interface ConvertMarkdownImportParams {
  markdown: string;
  fileName?: string;
  includeImages?: boolean;
  maxImages?: number;
  renderTableImage?: (input: {
    id: string;
    html: string;
    fallbackText: string;
    alt: string;
  }) => Promise<MarkdownTableArtifact>;
}

function runMarkdownImport(params: ConvertMarkdownImportParams): Promise<MarkdownImportResult> {
  return convertMarkdownImport({
    includeImages: true,
    maxImages: 50,
    ...params,
  });
}

function warningCodes(result: MarkdownImportResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

test('markdown import prefers front matter title over heading and excerpt', async () => {
  const result = await runMarkdownImport({
    fileName: 'fallback-title.md',
    markdown: `---
title: Front Matter Title
tags:
  - ignored
date: 2026-04-15
---

# Heading Title

First paragraph content that should never win.
`,
  });

  assert.equal(result.editableTitle, 'Front Matter Title');
  assert.equal(result.extractResult.title, 'Front Matter Title');
  assert.equal(result.stats.title, 'Front Matter Title');
  assert.equal(result.extractResult.sourceType, 'markdown_import');
  assert.equal(result.extractResult.sourceUrl, '');
  assert.equal(result.extractResult.domain, 'markdown');
});

test('markdown import falls back from heading to excerpt instead of file name', async () => {
  const headingResult = await runMarkdownImport({
    fileName: 'from-file-name.md',
    markdown: `# Heading Wins

Paragraph body`,
  });

  assert.equal(headingResult.extractResult.title, 'Heading Wins');

  const excerptFromFileResult = await runMarkdownImport({
    fileName: 'fallback-file-name.md',
    markdown: `Plain body paragraph without heading`,
  });

  assert.equal(excerptFromFileResult.extractResult.title, 'Plain body paragraph without ');

  const excerptResult = await runMarkdownImport({
    markdown: `Plain body paragraph without heading or file name fallback, so the excerpt should win here.`,
  });

  assert.equal(excerptResult.extractResult.title, 'Plain body paragraph without ');
});

test('markdown import maps the supported markdown subset and reports warnings and stats', async () => {
  const result = await runMarkdownImport({
    fileName: 'mapping.md',
    markdown: `
# Mapping Sample

Paragraph with **bold**, *italic*, \`inline code\`, and <mark>highlight</mark>.

- bullet one
- bullet two

> quoted line

\`\`\`ts
const value = 1;
\`\`\`

[valid link](https://example.com)
![remote alt](https://cdn.example.com/image.png)
![local alt](./assets/local.png)
- [ ] task item becomes plain text

<script>alert('blocked')</script>
`,
  });

  assert.match(
    result.extractResult.contentHtml,
    /<p class="md-import-heading md-import-heading-1"><strong>Mapping Sample<\/strong><\/p>/
  );
  assert.match(result.extractResult.contentHtml, /<strong>bold<\/strong>/);
  assert.doesNotMatch(result.extractResult.contentHtml, /<em>italic<\/em>/);
  assert.match(result.extractResult.contentHtml, /<code>inline code<\/code>/);
  assert.match(result.extractResult.contentHtml, /<mark>highlight<\/mark>/);
  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• bullet one<\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}• bullet two<\\/p>`)
  );
  assert.match(result.extractResult.contentHtml, /<pre><code class="language-typescript">const value = 1;/);
  assert.match(result.extractResult.contentHtml, /<a[^>]+href="https:\/\/example\.com"/);
  assert.doesNotMatch(result.extractResult.contentHtml, /<script>/);

  assert.equal(result.stats.remoteImageCount, 1);
  assert.equal(result.stats.localImageCount, 1);
  assert.equal(result.stats.dataImageCount, 0);
  assert.equal(result.stats.tableCount, 0);
  assert.ok(result.stats.warningCount >= 2);

  assert.equal(result.extractResult.images.length, 1);
  assert.equal(result.extractResult.images[0]?.normalizedUrl, 'https://cdn.example.com/image.png');
  assert.equal(result.extractResult.sourceMeta?.hasLocalImages, true);

  const codes = warningCodes(result);
  assert.ok(codes.includes('LOCAL_IMAGE_DEGRADED'));
  assert.ok(codes.includes('HTML_SANITIZED'));
  assert.ok(codes.includes('UNSUPPORTED_SYNTAX'));

  const previewTypes = result.previewModel.blocks.map((block) => block.type);
  assert.ok(previewTypes.includes('heading'));
  assert.ok(previewTypes.includes('paragraph'));
  assert.ok(previewTypes.includes('quote'));
  assert.ok(previewTypes.includes('code'));
  assert.ok(previewTypes.includes('image'));
});

test('markdown import maps ordinary prose lists to paragraphized list paragraphs', async () => {
  const result = await runMarkdownImport({
    markdown: `
Paragraph before

- alpha
- beta

1. one
2. two

Paragraph after
`,
  });

  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• alpha<\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}• beta<\\/p>`)
  );
  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}1\\. one<\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}2\\. two<\\/p>`)
  );
  assert.doesNotMatch(result.extractResult.contentHtml, /<blockquote><p>• alpha/);
  assert.doesNotMatch(result.extractResult.contentHtml, /language-markdown/);
  assert.doesNotMatch(result.extractResult.contentHtml, /<ul>|<ol>|<li>/);
});

test('markdown import maps technical command lists to code blocks', async () => {
  const result = await runMarkdownImport({
    markdown: `
# 启动步骤

- pnpm install
- pnpm build
- pnpm test
`,
  });

  assert.match(result.extractResult.contentHtml, /<pre><code class="language-shellscript">pnpm install\npnpm build\npnpm test<\/code><\/pre>/);
  assert.doesNotMatch(result.extractResult.contentHtml, /<blockquote><p>• pnpm install/);
  assert.ok(result.previewModel.blocks.some((block) => block.type === 'code'));
});

test('markdown import maps path and config lists to code blocks', async () => {
  const result = await runMarkdownImport({
    markdown: `
# 相关文件

- src/background/index.ts
- src/utils/markdownImport.ts
- manifest.json
- content_scripts.matches= https://example.com/*
`,
  });

  assert.match(result.extractResult.contentHtml, /<pre><code class="language-shellscript">src\/background\/index\.ts\nsrc\/utils\/markdownImport\.ts\nmanifest\.json\ncontent_scripts\.matches= https:\/\/example\.com\/\*<\/code><\/pre>/);
  assert.doesNotMatch(result.extractResult.contentHtml, /<blockquote>/);
});

test('markdown import maps highlight annotations to mowen mark output', async () => {
  const result = await runMarkdownImport({
    markdown: `
# 标注样例

[高亮/黄] 这一句应该作为重点展示。

- [高亮/黄] 这一条也应该高亮
- 普普通通的列表项
`,
  });

  assert.match(result.extractResult.contentHtml, /<p><mark>这一句应该作为重点展示。<\/mark><\/p>/);
  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• <mark>这一条也应该高亮<\\/mark><\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}• 普普通通的列表项<\\/p>`)
  );
  assert.doesNotMatch(result.extractResult.contentHtml, /<blockquote><p>• <mark>这一条也应该高亮/);
});

test('markdown import maps fully highlighted annotation lists to ordered highlight paragraphs', async () => {
  const result = await runMarkdownImport({
    markdown: `
# 标注

- [高亮/黄] 消费不足的第二个堵点就在于资本市场没有发挥它应该发挥的作用。
- [高亮/黄] 这就是改革，在一些关键制度上的哪怕细微变革，就会释放制度红利。
`,
  });

  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}1、<mark>消费不足的第二个堵点就在于资本市场没有发挥它应该发挥的作用。<\\/mark><\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}2、<mark>这就是改革，在一些关键制度上的哪怕细微变革，就会释放制度红利。<\\/mark><\\/p>`)
  );
  assert.doesNotMatch(result.extractResult.contentHtml, /<p>• <mark>/);
});

test('markdown import preserves labeled link paragraphs as inline metadata paragraphs', async () => {
  const result = await runMarkdownImport({
    markdown: `
链接：[https://mp.weixin.qq.com/s/-1oehr-Ns-UWK_D9994voA](https://mp.weixin.qq.com/s/-1oehr-Ns-UWK_D9994voA)
`,
  });

  assert.match(
    result.extractResult.contentHtml,
    /<p>链接：<a href="https:\/\/mp\.weixin\.qq\.com\/s\/-1oehr-Ns-UWK_D9994voA" target="_blank" rel="noopener noreferrer">https:\/\/mp\.weixin\.qq\.com\/s\/-1oehr-Ns-UWK_D9994voA<\/a><\/p>/
  );
  const linkParagraphBlock = result.extractResult.blocks.find((block) => /链接：/.test(block.html));
  assert.equal(linkParagraphBlock?.layout?.preserveInlineParagraphs, true);
});

test('markdown import keeps explicitly fenced inline technical fragments as code inside prose lists', async () => {
  const result = await runMarkdownImport({
    markdown: [
      '# 文件样例',
      '',
      '- 新增扩展内部页面 `mdImport.html`',
      '- 支持用户上传 `.md/.markdown/.txt` 文件',
    ].join('\n'),
  });

  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• 新增扩展内部页面 <code>mdImport\\.html<\\/code><\\/p>`)
  );
  assert.match(
    result.extractResult.contentHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• 支持用户上传 <code>\\.md\\/\\.markdown\\/\\.txt<\\/code> 文件<\\/p>`)
  );
});

test('markdown import falls back when table rendering fails and records warning and stats', async () => {
  const result = await runMarkdownImport({
    fileName: 'table.md',
    markdown: `
# Table Sample

| name | score |
| ---- | ----- |
| Ada  | 100   |
| Lin  | 98    |
`,
    renderTableImage: async ({ id, html, alt, fallbackText }) => ({
      id,
      html,
      alt,
      fallbackText,
      success: false,
    }),
  });

  assert.equal(result.stats.tableCount, 1);
  assert.equal(result.stats.tableFallbackCount, 1);
  assert.equal(result.extractResult.images.length, 0);

  const codes = warningCodes(result);
  assert.ok(codes.includes('TABLE_RENDER_FAILED') || codes.includes('TABLE_FALLBACK_TEXT'));

  assert.match(result.extractResult.contentHtml, /name/i);
  assert.match(result.extractResult.contentHtml, /score/i);
  const previewHtml = renderMarkdownPreviewBodyHtml(result.previewModel.blocks);
  assert.match(previewHtml, /Ada/i);
  assert.match(previewHtml, /Lin/i);
});

test('markdown import keeps paragraph separation as a single blank line in preview/save output', async () => {
  const result = await runMarkdownImport({
    markdown: `
# Spacing Sample

First paragraph.



Second paragraph after extra blank lines.
`,
  });

  const paragraphBlocks = result.previewModel.blocks.filter((block) => block.type === 'paragraph');
  const previewHtml = renderMarkdownPreviewBodyHtml(result.previewModel.blocks);

  assert.equal(paragraphBlocks.length, 2);
  assert.match(previewHtml, /First paragraph\./);
  assert.match(previewHtml, /Second paragraph after extra blank lines\./);
  assert.equal((previewHtml.match(/Second paragraph after extra blank lines\./g) || []).length, 1);
});

test('markdown import drops thematic separators from mowen preview and saved content', async () => {
  const result = await runMarkdownImport({
    markdown: `
# 第一章

---

## 第二章
`,
  });

  assert.doesNotMatch(result.extractResult.contentHtml, /────────|---|<hr/i);
  assert.doesNotMatch(renderMarkdownPreviewBodyHtml(result.previewModel.blocks), /────────|---|<hr/i);
  assert.match(result.extractResult.contentHtml, /第一章/);
  assert.match(result.extractResult.contentHtml, /第二章/);
});

test('markdown import keeps explicit fence languages and infers common code languages', async () => {
  const result = await runMarkdownImport({
    markdown: [
      '```python',
      'def hello(name: str) -> None:',
      '    print(name)',
      '```',
      '',
      '```',
      'package main',
      '',
      'import "fmt"',
      '',
      'func main() {',
      '    fmt.Println("hello")',
      '}',
      '```',
      '',
      '```',
      './image.png',
      '../assets/a.jpg',
      '/Users/example/demo.png',
      '```',
    ].join('\n'),
  });

  assert.match(result.extractResult.contentHtml, /<pre><code class="language-python">def hello/);
  assert.match(result.extractResult.contentHtml, /<pre><code class="language-go">package main/);
  assert.match(result.extractResult.contentHtml, /<pre><code class="language-shellscript">\.\//);
});

test('shiki language helpers cover common fence aliases and unlabeled snippets', () => {
  assert.equal(resolveShikiLanguageId('python3'), 'python');
  assert.equal(resolveShikiLanguageId('terminal'), 'shellsession');
  assert.equal(resolveShikiLanguageId('postgresql'), 'sql');
  assert.equal(resolveShikiLanguageId('obj-c'), 'objective-c');

  assert.equal(inferCodeLanguageFromText('FROM node:20\nWORKDIR /app\nRUN npm ci\nCMD ["npm", "start"]'), 'docker');
  assert.equal(inferCodeLanguageFromText('resource "aws_s3_bucket" "assets" {\n  bucket = "demo"\n}'), 'terraform');
  assert.equal(inferCodeLanguageFromText('[tool.ruff]\nline-length = 100'), 'toml');
  assert.equal(inferCodeLanguageFromText('using System;\nConsole.WriteLine("hi");'), 'csharp');
  assert.equal(inferCodeLanguageFromText('./image.png\n../assets/a.jpg\n/Users/example/demo.png'), 'shellscript');
  assert.equal(inferCodeLanguageFromText('C:\\\\Users\\\\demo\\\\a.jpg'), 'powershell');
});
