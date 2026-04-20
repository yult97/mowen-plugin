import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareContentForSave } from '../src/background/saveNoteFlow';
import { convertMarkdownImport } from '../src/utils/markdownImport';
import { renderMarkdownPreviewBodyHtml } from '../src/utils/markdownPreview';
import { restoreMdImportTask, subscribeMdImportTask } from '../src/utils/mdImportSaveClient';
import { buildEditedPreviewExtractResult, buildMowenPreviewBodyHtml } from '../src/utils/mdImportPreviewEdit';
import {
  createInitialSaveProgress,
  getSaveProgressVisualState,
  normalizeSaveProgress,
} from '../src/utils/saveProgressView';
import { htmlToNoteAtom, noteAtomToHtml } from '../src/utils/noteAtom';
import { TaskStore } from '../src/utils/taskStore';
import {
  removeAllImageTags as stripAllImageTags,
  replaceImageUrls as replaceMarkdownImageUrls,
} from '../src/background/imageHtml';
import type { ExtractResult, ImageCandidate, ImageProcessResult, SaveProgress } from '../src/types';

type SessionStoreShape = Record<string, unknown>;

function createChromeStub() {
  const sessionStore: SessionStoreShape = {};
  const messageListeners = new Set<(message: unknown) => void>();

  const chromeStub = {
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {
          return undefined;
        },
      },
      session: {
        async get(key: string) {
          return key in sessionStore ? { [key]: sessionStore[key] } : {};
        },
        async set(value: SessionStoreShape) {
          Object.assign(sessionStore, value);
        },
        async remove(key: string) {
          delete sessionStore[key];
        },
      },
    },
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test/${path}`;
      },
      lastError: undefined,
      sendMessage: async () => undefined,
      onMessage: {
        addListener(listener: (message: unknown) => void) {
          messageListeners.add(listener);
        },
        removeListener(listener: (message: unknown) => void) {
          messageListeners.delete(listener);
        },
      },
      onInstalled: {
        addListener() {},
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      async setOptions() {},
      async open() {},
    },
    action: {
      onClicked: {
        addListener() {},
      },
    },
    tabs: {
      onActivated: {
        addListener() {},
      },
      onRemoved: {
        addListener() {},
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return undefined;
      },
    },
    contextMenus: {
      create(_options: unknown, callback?: () => void) {
        callback?.();
      },
      onClicked: {
        addListener() {},
      },
    },
  };

  function emitRuntimeMessage(message: unknown) {
    for (const listener of messageListeners) {
      listener(message);
    }
  }

  return { chromeStub, emitRuntimeMessage };
}

const { chromeStub, emitRuntimeMessage } = createChromeStub();
(globalThis as typeof globalThis & { chrome: typeof chromeStub }).chrome = chromeStub;
const OPTIONAL_SPACING_PATTERN = '(?:\\s|\\u200B|\\u200C|\\u200D|\\u2060|\\uFEFF)*';
const LIST_PARAGRAPH_OPEN_PATTERN = '<p(?: class="[^"]*md-import-list-paragraph[^"]*")?>';
const BODY_SPACER_HTML_PATTERN = '<p>(?:<br>|\\u00A0|&nbsp;)<\\/p>';

function createImage(id: string, url: string): ImageCandidate {
  return {
    id,
    url,
    normalizedUrl: url,
    kind: url.startsWith('data:') ? 'data' : 'img',
    order: 0,
    inMainContent: true,
    alt: id,
  };
}

function createExtractResult(overrides: Partial<ExtractResult> = {}): ExtractResult {
  return {
    title: 'Markdown title',
    sourceUrl: '',
    domain: 'markdown',
    sourceType: 'markdown_import',
    contentHtml: '<p>body</p>',
    blocks: [
      {
        id: 'block-1',
        type: 'paragraph',
        html: '<p>body</p>',
        text: 'body',
      },
    ],
    images: [],
    wordCount: 1,
    ...overrides,
  };
}

function removeInlineImageTags(content: string): string {
  return content.replace(/<img[^>]*>/g, '');
}

test('prepareContentForSave removes image tags and skips processing when includeImages=false', async () => {
  let processCalled = false;

  const extractResult = createExtractResult({
    contentHtml: '<p>before</p><img src="https://cdn.example.com/1.png"><p>after</p>',
    blocks: [
      {
        id: 'block-1',
        type: 'paragraph',
        html: '<p>before</p><img src="https://cdn.example.com/1.png"><p>after</p>',
        text: 'before after',
      },
    ],
    images: [createImage('img-1', 'https://cdn.example.com/1.png')],
  });

  const result = await prepareContentForSave({
    extractResult,
    includeImages: false,
    maxImages: 10,
    apiKey: 'test-key',
    tabId: 1,
    taskId: 'task-1',
    signal: new AbortController().signal,
    processImages: async () => {
      processCalled = true;
      return [];
    },
    replaceImageUrls: (content) => content,
    removeAllImageTags: removeInlineImageTags,
    logToContentScript: () => undefined,
  });

  assert.equal(processCalled, false);
  assert.equal(result.imageResults.length, 0);
  assert.equal(result.processedContent, '<p>before</p><p>after</p>');
  assert.equal(result.processedBlocks[0]?.html, '<p>before</p><p>after</p>');
});

test('prepareContentForSave preserves body flow when some image uploads fail', async () => {
  const extractResult = createExtractResult({
    contentHtml: [
      '<p>start</p>',
      '<img src="https://cdn.example.com/success.png">',
      '<img src="https://cdn.example.com/fail.png">',
      '<p>end</p>',
    ].join(''),
    blocks: [
      {
        id: 'block-1',
        type: 'paragraph',
        html: [
          '<p>start</p>',
          '<img src="https://cdn.example.com/success.png">',
          '<img src="https://cdn.example.com/fail.png">',
          '<p>end</p>',
        ].join(''),
        text: 'start end',
      },
    ],
    images: [
      createImage('img-success', 'https://cdn.example.com/success.png'),
      createImage('img-fail', 'https://cdn.example.com/fail.png'),
    ],
  });

  const imageResults: ImageProcessResult[] = [
    {
      id: 'img-success',
      originalUrl: 'https://cdn.example.com/success.png',
      success: true,
      assetUrl: 'https://assets.example.com/success.png',
      uid: 'uid-success',
    },
    {
      id: 'img-fail',
      originalUrl: 'https://cdn.example.com/fail.png',
      success: false,
      failureReason: 'TIMEOUT_OR_NET',
    },
  ];

  const result = await prepareContentForSave({
    extractResult,
    includeImages: true,
    maxImages: 10,
    apiKey: 'test-key',
    tabId: 1,
    taskId: 'task-1',
    signal: new AbortController().signal,
    processImages: async () => imageResults,
    replaceImageUrls: (content, results) => results.reduce((current, item) => {
      if (item.success) {
        return current.replace(
          `<img src="${item.originalUrl}">`,
          `<img src="${item.assetUrl || item.originalUrl}" data-mowen-uid="${item.uid}">`
        );
      }

      return current.replace(
        `<img src="${item.originalUrl}">`,
        `<a href="${item.originalUrl}">${item.originalUrl}</a>`
      );
    }, content),
    removeAllImageTags: removeInlineImageTags,
    logToContentScript: () => undefined,
  });

  assert.equal(result.imageResults.length, 2);
  assert.match(result.processedContent, /data-mowen-uid="uid-success"/);
  assert.match(result.processedContent, /<a href="https:\/\/cdn\.example\.com\/fail\.png">/);
  assert.match(result.processedContent, /<p>end<\/p>/);
  assert.match(result.processedBlocks[0]?.html || '', /data-mowen-uid="uid-success"/);
  assert.match(result.processedBlocks[0]?.html || '', /<a href="https:\/\/cdn\.example\.com\/fail\.png">/);
});

test('mdImportSaveClient ignores stale taskId messages and restore respects taskId filtering', async () => {
  const tabId = 88;
  const currentTaskId = 'current-task';
  const staleTaskId = 'stale-task';
  const seenProgress: SaveProgress[] = [];
  const seenResults: Array<{ success: boolean }> = [];

  await TaskStore.clear(tabId);
  await TaskStore.init(tabId, currentTaskId);

  const unsubscribe = subscribeMdImportTask(tabId, currentTaskId, {
    onProgress: (progress) => seenProgress.push(progress),
    onComplete: (result) => seenResults.push({ success: result.success }),
  });

  emitRuntimeMessage({
    type: 'SAVE_NOTE_PROGRESS',
    tabId,
    taskId: staleTaskId,
    progress: {
      type: 'uploading_images',
      uploadedImages: 3,
      totalImages: 5,
    },
  });

  emitRuntimeMessage({
    type: 'SAVE_NOTE_COMPLETE',
    tabId,
    taskId: staleTaskId,
    result: {
      success: false,
      error: 'stale should be ignored',
    },
  });

  emitRuntimeMessage({
    type: 'SAVE_NOTE_PROGRESS',
    tabId,
    taskId: currentTaskId,
    progress: {
      type: 'creating_note',
      currentPart: 1,
      totalParts: 2,
    },
  });

  unsubscribe();

  assert.equal(seenProgress.length, 1);
  assert.equal(seenProgress[0]?.status, 'creating_note');
  assert.equal(seenResults.length, 0);

  const restoredCurrent = await restoreMdImportTask(tabId, currentTaskId);
  const restoredStale = await restoreMdImportTask(tabId, staleTaskId);

  assert.equal(restoredCurrent?.taskId, currentTaskId);
  assert.equal(restoredStale, null);
});

test('createInitialSaveProgress seeds markdown imports with image and note totals', () => {
  const extractResult = createExtractResult({
    wordCount: 38050,
    images: [
      createImage('img-1', 'https://cdn.example.com/1.png'),
      createImage('img-2', 'https://cdn.example.com/2.png'),
      createImage('img-3', 'https://cdn.example.com/3.png'),
    ],
  });

  const progress = createInitialSaveProgress(extractResult, {
    includeImages: true,
    maxImages: 2,
  });

  assert.deepEqual(progress, {
    status: 'uploading_images',
    uploadedImages: 0,
    totalImages: 2,
    currentPart: 0,
    totalParts: 3,
  });
});

test('save progress view maps image and note phases into one progress bar', () => {
  const uploadPhase = getSaveProgressVisualState({
    status: 'uploading_images',
    uploadedImages: 2,
    totalImages: 4,
    currentPart: 0,
    totalParts: 3,
  });

  assert.equal(uploadPhase.overallProgress, 25);
  assert.equal(uploadPhase.phaseLabel, '正在上传图片');
  assert.equal(uploadPhase.phaseDetail, '2/4');
  assert.equal(uploadPhase.imagePhaseActive, true);
  assert.equal(uploadPhase.notePhaseActive, false);

  const notePhase = getSaveProgressVisualState({
    status: 'creating_note',
    uploadedImages: 4,
    totalImages: 4,
    currentPart: 2,
    totalParts: 4,
  });

  assert.equal(notePhase.overallProgress, 75);
  assert.equal(notePhase.phaseLabel, '正在创建笔记');
  assert.equal(notePhase.phaseDetail, '2/4');
  assert.equal(notePhase.imagePhaseActive, false);
  assert.equal(notePhase.notePhaseActive, true);
});

test('normalizeSaveProgress upgrades legacy task store statuses for md import restore', () => {
  const normalized = normalizeSaveProgress({
    status: 'creating',
    uploadedImages: 1,
    totalImages: 3,
    currentPart: 0,
    totalParts: 2,
  });

  assert.equal(normalized.status, 'creating_note');
});

test('buildMowenPreviewBodyHtml uses the same paragraph semantics as the save chain', () => {
  const previewHtml = buildMowenPreviewBodyHtml(
    '<p class="md-import-heading md-import-heading-1"><strong>Heading</strong></p><p>Body</p><p><em>Italic</em> <code>`code`</code></p>'
  );

  assert.match(previewHtml, /<p><strong>Heading<\/strong><\/p>/);
  assert.match(previewHtml, /<p><strong>Heading<\/strong><\/p>\s*<p><br><\/p>\s*<p>Body<\/p>/);
  assert.match(previewHtml, /<p>Body<\/p>\s*<p><br><\/p>\s*<p><em>Italic<\/em> <code>`code`<\/code><\/p>/);
  assert.match(previewHtml, /<p>Body<\/p>/);
  assert.doesNotMatch(previewHtml, /md-import-heading/);
  assert.match(previewHtml, /<em>Italic<\/em>/);
  assert.match(previewHtml, /<code>`code`<\/code>/);
});

test('buildMowenPreviewBodyHtml keeps ordinary prose lists as paragraphized list paragraphs without extra spacer paragraphs', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 列表空行样例',
      '',
      '前置说明',
      '',
      '- 第一项',
      '- 第二项',
      '- 第三项',
    ].join('\n'),
  });

  const previewSourceHtml = renderMarkdownPreviewBodyHtml(result.previewModel.blocks);
  const previewHtml = buildMowenPreviewBodyHtml(previewSourceHtml);

  assert.match(previewHtml, /<p>前置说明<\/p>/);
  assert.match(
    previewHtml,
    new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 第一项<\\/p>\\s*${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 第二项<\\/p>\\s*${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 第三项<\\/p>`)
  );
  assert.match(previewHtml, new RegExp(`前置说明<\\/p>\\s*<p><br><\\/p>\\s*${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 第一项<\\/p>`));
  assert.doesNotMatch(previewHtml, /第一项<\/p>\s*<p><br><\/p>\s*<p(?: class="[^"]*md-import-list-paragraph[^"]*")?>.*第二项/);
});

test('buildMowenPreviewBodyHtml keeps technical lists as code blocks without extra spacer paragraphs', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 命令样例',
      '',
      '执行以下命令',
      '',
      '- pnpm install',
      '- pnpm build',
      '- pnpm test',
    ].join('\n'),
  });

  const previewSourceHtml = renderMarkdownPreviewBodyHtml(result.previewModel.blocks);
  const previewHtml = buildMowenPreviewBodyHtml(previewSourceHtml);

  assert.match(previewHtml, /<pre><code class="language-shellscript">pnpm install\npnpm build\npnpm test<\/code><\/pre>/);
  assert.match(previewHtml, /执行以下命令<\/p>\s*<pre><code class="language-shellscript">pnpm install/);
  assert.doesNotMatch(previewHtml, /执行以下命令<\/p>\s*<p><br><\/p>\s*<pre>/);
});

test('buildMowenPreviewBodyHtml keeps front-matter style metadata compact while separating real sections', () => {
  const previewHtml = buildMowenPreviewBodyHtml(
    [
      '<p><strong>PRD｜Markdown 文件导入并保存至墨问笔记</strong></p>',
      '<p>版本：V0.1（评审稿）</p>',
      '<p>作者：Codex</p>',
      '<p>日期：2026-04-15</p>',
      '<p>状态：待评审</p>',
      '<p><strong>2.1 本期目标</strong></p>',
      '<p>本期要实现的核心目标：</p>',
      '<ul><li>支持上传 .md/.markdown/.txt 文件</li><li>支持粘贴 Markdown 内容</li></ul>',
    ].join('')
  );

  assert.match(
    previewHtml,
    new RegExp(`<p><strong>PRD｜Markdown${OPTIONAL_SPACING_PATTERN}文件导入并保存至墨问笔记<\\/strong><\\/p>\\s*<p><br><\\/p>\\s*<p>版本：V0\\.1（评审稿）<\\/p>`)
  );
  assert.doesNotMatch(previewHtml, /版本：V0\.1（评审稿）<\/p>\s*<p><br><\/p>\s*<p>作者：Codex<\/p>/);
  assert.doesNotMatch(previewHtml, /作者：Codex<\/p>\s*<p><br><\/p>\s*<p>日期：2026-04-15<\/p>/);
  assert.match(previewHtml, new RegExp(`状态：待评审<\\/p>\\s*<p><br><\\/p>\\s*<p><strong>2\\.1${OPTIONAL_SPACING_PATTERN}本期目标<\\/strong><\\/p>`));
  assert.match(previewHtml, new RegExp(`本期要实现的核心目标：<\\/p>\\s*<p><br><\\/p>\\s*${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 支持上传 \\.md\\/\\.markdown\\/\\.txt${OPTIONAL_SPACING_PATTERN}文件<\\/p>`));
  assert.doesNotMatch(previewHtml, /支持上传 \.md\/\.markdown\/\.txt 文件<\/p>\s*<p><br><\/p>\s*<p(?: class="[^"]*md-import-list-paragraph[^"]*")?>• 支持粘贴 Markdown 内容<\/p>/);
});

test('buildMowenPreviewBodyHtml keeps inline code and mixed-language text in the same paragraph', () => {
  const previewHtml = buildMowenPreviewBodyHtml(
    '<p>• 文件选择：选择 <code>.md/.markdown/.txt</code></p><p>• 相对路径：<code>./image.png</code>、<code>../assets/a.jpg</code></p>'
  );

  assert.match(previewHtml, new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 文件选择：选择 <code>\\.md\\/\\.markdown\\/\\.txt<\\/code><\\/p>`));
  assert.match(previewHtml, new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 相对路径：<code>\\.\\/image\\.png<\\/code>、<code>\\.\\.\\/assets\\/a\\.jpg<\\/code><\\/p>`));
  assert.doesNotMatch(previewHtml, /文件选择：<\/p>\s*<p><br><\/p>\s*<p>选择/);
  assert.doesNotMatch(previewHtml, /相对路径：<\/p>\s*<p><br><\/p>\s*<p><code>\.\/image\.png/);
});

test('markdown import keeps explicitly fenced inline technical fragments as code through preview and body save', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 文件样例',
      '',
      '- 新增扩展内部页面 `mdImport.html`',
      '- 支持用户上传 `.md/.markdown/.txt` 文件',
    ].join('\n'),
  });

  const previewHtml = buildMowenPreviewBodyHtml(renderMarkdownPreviewBodyHtml(result.previewModel.blocks));
  assert.match(
    previewHtml,
    new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 新增扩展内部页面 <code>mdImport\\.html<\\/code><\\/p>`)
  );
  assert.match(
    previewHtml,
    new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 支持用户上传 <code>\\.md\\/\\.markdown\\/\\.txt<\\/code> 文件<\\/p>`)
  );

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);
  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  const bodyDoc = body as {
    content?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
        marks?: Array<{ type: string }>;
        content?: Array<unknown>;
      }>;
    }>;
  };

  const hasCodeMarkedText = (needle: string): boolean => {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') {
        return false;
      }

      const candidate = node as {
        text?: string;
        marks?: Array<{ type: string }>;
        content?: Array<unknown>;
      };

      if (
        typeof candidate.text === 'string'
        && candidate.text.includes(needle)
        && candidate.marks?.some((mark) => mark.type === 'code')
      ) {
        return true;
      }

      return Array.isArray(candidate.content) && candidate.content.some((child) => visit(child));
    };

    return Array.isArray(bodyDoc.content) && bodyDoc.content.some((node) => visit(node));
  };

  assert.match(
    bodyHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• 新增扩展内部页面 <code>mdImport\\.html<\\/code><\\/p>`)
  );
  assert.match(
    bodyHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}• 支持用户上传 <code>\\.md\\/\\.markdown\\/\\.txt<\\/code> 文件<\\/p>`)
  );
  assert.equal(hasCodeMarkedText('mdImport.html'), true);
  assert.equal(hasCodeMarkedText('.md/.markdown/.txt'), true);

  const hasParagraphWithInlineCodeShape = (needle: string): boolean => (
    Array.isArray(bodyDoc.content) && bodyDoc.content.some((node) => {
      const paragraph = node as {
        type?: string;
        content?: Array<{ type?: string; text?: string; marks?: Array<{ type: string }> }>;
      };

      if (paragraph.type !== 'paragraph' || !Array.isArray(paragraph.content)) {
        return false;
      }

      const codeIndex = paragraph.content.findIndex((child) => (
        child.type === 'text'
        && child.text?.includes(needle)
        && child.marks?.some((mark) => mark.type === 'code')
      ));

      return codeIndex > 0 && codeIndex < paragraph.content.length - 1;
    })
  );

  assert.equal(hasParagraphWithInlineCodeShape('.md/.markdown/.txt'), true);
});

test('buildMowenPreviewBodyHtml preserves markdown highlight annotations through preview normalization', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 高亮样例',
      '',
      '[高亮/黄] 重点句子',
      '',
      '- [高亮/黄] 高亮列表项',
      '- 普通列表项',
    ].join('\n'),
  });

  const previewSourceHtml = renderMarkdownPreviewBodyHtml(result.previewModel.blocks);
  const previewHtml = buildMowenPreviewBodyHtml(previewSourceHtml);
  const atom = htmlToNoteAtom(previewHtml, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  }) as { content?: Array<{ type: string; content?: Array<{ type: string; marks?: Array<{ type: string }> }> }> };

  assert.match(previewHtml, /<p><mark>重点句子<\/mark><\/p>/);
  assert.match(
    previewHtml,
    new RegExp(`${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• <mark>高亮列表项<\\/mark><\\/p>\\s*${LIST_PARAGRAPH_OPEN_PATTERN}${OPTIONAL_SPACING_PATTERN}• 普通列表项<\\/p>`)
  );
  assert.doesNotMatch(previewHtml, /<blockquote><p>• <mark>高亮列表项<\/mark>/);

  const highlightParagraph = atom.content?.find((node) => node.type === 'paragraph' && node.content?.some((child) => child.marks?.some((mark) => mark.type === 'highlight')));
  assert.ok(highlightParagraph);
});

test('markdown highlight list items stay as text-level highlight marks through body save', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 标注',
      '',
      '- [高亮/黄] 消费不足的第二个堵点就在于资本市场没有发挥它应该发挥的作用。',
      '- [高亮/黄] 这就是改革，在一些关键制度上的哪怕细微变革，就会释放制度红利。',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);

  const bodyDoc = body as {
    content?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; marks?: Array<{ type: string }> }>;
    }>;
  };

  const highlightedListParagraph = bodyDoc.content?.find((node) => (
    node.type === 'paragraph'
    && Array.isArray(node.content)
    && node.content.some((child) => child.text?.includes('1、'))
    && node.content.some((child) => (
      child.text?.includes('消费不足的第二个堵点')
      && child.marks?.some((mark) => mark.type === 'highlight')
    ))
  ));

  assert.ok(highlightedListParagraph);
  assert.equal(
    highlightedListParagraph?.content?.some((child) => child.text?.includes('1、') && !child.marks?.length),
    true
  );
});

test('fully highlighted annotation lists save as ordered highlight paragraphs in body mode', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 标注',
      '',
      '- [高亮/黄] 消费不足的第二个堵点就在于资本市场没有发挥它应该发挥的作用。',
      '- [高亮/黄] 这就是改革，在一些关键制度上的哪怕细微变革，就会释放制度红利。',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);
  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(bodyHtml, /<p>1、<mark>消费不足的第二个堵点就在于资本市场没有发挥它应该发挥的作用。<\/mark><\/p>/);
  assert.match(bodyHtml, /<p>2、<mark>这就是改革，在一些关键制度上的哪怕细微变革，就会释放制度红利。<\/mark><\/p>/);
  assert.doesNotMatch(bodyHtml, /<p>• <mark>/);
});

test('metadata label link paragraphs stay in one paragraph through body-mode save', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 链接样例',
      '',
      '链接：[https://mp.weixin.qq.com/s/-1oehr-Ns-UWK_D9994voA](https://mp.weixin.qq.com/s/-1oehr-Ns-UWK_D9994voA)',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);
  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(
    bodyHtml,
    /<p>链接：<a href="https:\/\/mp\.weixin\.qq\.com\/s\/-1oehr-Ns-UWK_D9994voA" target="_blank" rel="noopener noreferrer">https:\/\/mp\.weixin\.qq\.com\/s\/-1oehr-Ns-UWK_D9994voA<\/a><\/p>/
  );
  assert.doesNotMatch(bodyHtml, /链接：<\/p>\s*<p><a href=/);
});

test('buildMowenPreviewBodyHtml removes markdown divider paragraphs from the preview body', () => {
  const previewHtml = buildMowenPreviewBodyHtml(
    '<p><strong>第一章</strong></p><p>---</p><p><strong>第二章</strong></p>'
  );

  assert.match(previewHtml, /<p><strong>第一章<\/strong><\/p>/);
  assert.match(previewHtml, /<p><strong>第二章<\/strong><\/p>/);
  assert.doesNotMatch(previewHtml, /<p>---<\/p>/);
});

test('markdown code fence languages survive the save conversion chain', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '```java',
      'public class HelloWorld {',
      '  public static void main(String[] args) {',
      '    System.out.println("hello");',
      '  }',
      '}',
      '```',
    ].join('\n'),
  });

  const atom = htmlToNoteAtom(result.extractResult.contentHtml, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  }) as { content?: Array<{ type: string; attrs?: { language?: string } }> };

  const codeblock = atom.content?.find((node) => node.type === 'codeblock');
  assert.ok(codeblock);
  assert.equal(codeblock?.attrs?.language, 'java');
});

test('prepareContentForSave keeps uploaded markdown table images as mowen image nodes', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 表格图片',
      '',
      '| name | score |',
      '| ---- | ----- |',
      '| Ada  | 100   |',
    ].join('\n'),
    renderTableImage: async ({ id, html, fallbackText, alt }) => ({
      id,
      html,
      fallbackText,
      alt,
      success: true,
      dataUrl: 'data:image/png;base64,ZmFrZS10YWJsZS1pbWFnZQ==',
    }),
  });

  assert.equal(result.extractResult.images.length, 1);

  const prepared = await prepareContentForSave({
    extractResult: result.extractResult,
    includeImages: true,
    maxImages: 50,
    apiKey: 'test',
    tabId: 1,
    taskId: 'task-table',
    signal: new AbortController().signal,
    processImages: async (_apiKey, images) => images.map((image) => ({
      id: image.id,
      originalUrl: image.url,
      success: true,
      uid: 'table-image-uid',
      fileId: 'table-image-uid',
      assetUrl: 'https://image.mowen.cn/mowen/table-image-uid',
    }) satisfies ImageProcessResult),
    replaceImageUrls: replaceMarkdownImageUrls,
    removeAllImageTags: stripAllImageTags,
    logToContentScript: () => {},
  });

  assert.match(prepared.processedContent, /data-mowen-uid="table-image-uid"/);

  const atom = htmlToNoteAtom(prepared.processedContent, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  }) as { content?: Array<{ type: string; attrs?: { uuid?: string } }> };

  const imageNode = atom.content?.find((node) => node.type === 'image');
  assert.ok(imageNode);
  assert.equal(imageNode?.attrs?.uuid, 'table-image-uid');
  assert.doesNotMatch(prepared.processedContent, /查看原图：Markdown 表格 1/);
});

test('edited markdown preview table images survive body round-trip without leaking caption paragraphs', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 表格图片',
      '',
      '| name | score |',
      '| ---- | ----- |',
      '| Ada  | 100   |',
    ].join('\n'),
    renderTableImage: async ({ id, html, fallbackText, alt }) => ({
      id,
      html,
      fallbackText,
      alt,
      success: true,
      dataUrl: 'data:image/png;base64,ZmFrZS10YWJsZS1pbWFnZQ==',
    }),
  });

  const previewHtml = buildMowenPreviewBodyHtml(result.extractResult.contentHtml);
  const edited = buildEditedPreviewExtractResult({
    extractResult: result.extractResult,
    title: result.extractResult.title,
    html: previewHtml,
  });

  const prepared = await prepareContentForSave({
    extractResult: edited,
    includeImages: true,
    maxImages: 50,
    apiKey: 'test',
    tabId: 1,
    taskId: 'task-table-edited',
    signal: new AbortController().signal,
    processImages: async (_apiKey, images) => images.map((image) => ({
      id: image.id,
      originalUrl: image.url,
      success: true,
      uid: 'table-image-uid',
      fileId: 'table-image-uid',
      assetUrl: 'https://image.mowen.cn/mowen/table-image-uid',
    }) satisfies ImageProcessResult),
    replaceImageUrls: replaceMarkdownImageUrls,
    removeAllImageTags: stripAllImageTags,
    logToContentScript: () => {},
  });

  const normalizedHtml = noteAtomToHtml(htmlToNoteAtom(prepared.processedContent, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  }) as Parameters<typeof noteAtomToHtml>[0]);

  const finalAtom = htmlToNoteAtom(normalizedHtml, {
    preserveInlineParagraphs: true,
    enforceSingleTextBlockSpacing: true,
  }) as { content?: Array<{ type: string; attrs?: { uuid?: string }; content?: Array<{ text?: string }> }> };

  const imageNodes = finalAtom.content?.filter((node) => node.type === 'image') || [];
  const leakedCaptionParagraphs = (finalAtom.content || []).filter((node) => (
    node.type === 'paragraph'
    && (node.content || []).map((child) => child.text || '').join('').includes('Markdown 表格 1')
  ));

  assert.equal(imageNodes.length, 1);
  assert.equal(imageNodes[0]?.attrs?.uuid, 'table-image-uid');
  assert.equal(leakedCaptionParagraphs.length, 0);
  assert.doesNotMatch(normalizedHtml, /查看原图：Markdown 表格 1/);
});

test('markdown body-mode saves keep one spacer paragraph around real section headings', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# PRD｜Markdown 文件导入并保存至墨问笔记',
      '',
      '版本：V0.1（评审稿）',
      '作者：Codex',
      '日期：2026-04-15',
      '状态：待评审',
      '',
      '## 2.1 本期目标',
      '',
      '本期要实现的核心目标：',
      '',
      '- 在当前插件中提供明确的 Markdown 导入入口',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.createMode, 'body');

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);

  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(bodyHtml, new RegExp(`<p><strong>PRD｜Markdown ⁠文件导入并保存至墨问笔记<\\/strong><\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p>版本：V0.1（评审稿）<\\/p>`));
  assert.match(bodyHtml, new RegExp(`状态：待评审<\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p><strong>2\\.1 ⁠本期目标<\\/strong><\\/p>`));
  assert.match(bodyHtml, new RegExp(`<p><strong>2\\.1 ⁠本期目标<\\/strong><\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p>本期要实现的核心目标：<\\/p>`));
  assert.match(
    bodyHtml,
    new RegExp(`本期要实现的核心目标：<\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p>${OPTIONAL_SPACING_PATTERN}• 在当前插件中提供明确的${OPTIONAL_SPACING_PATTERN}Markdown${OPTIONAL_SPACING_PATTERN}导入入口<\\/p>`)
  );
  assert.doesNotMatch(bodyHtml, /<blockquote><p>.*在当前插件中提供明确的 Markdown 导入入口/);
});

test('standalone bold title paragraphs keep a spacer before following body content', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '**加粗标题**',
      '',
      '标题后的正文说明',
    ].join('\n'),
  });

  const previewHtml = buildMowenPreviewBodyHtml(renderMarkdownPreviewBodyHtml(result.previewModel.blocks));
  assert.match(previewHtml, /<p><strong>加粗标题<\/strong><\/p>\s*<p><br><\/p>\s*<p>标题后的正文说明<\/p>/);

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);
  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(bodyHtml, new RegExp(`<p><strong>加粗标题<\\/strong><\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p>标题后的正文说明<\\/p>`));
});

test('markdown body-mode inserts a spacer between a prose list group and the next numbered heading block', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 标题',
      '',
      '- 复用现有保存、拆分、图片处理、结果回显能力',
      '',
      '## 2. 产品目标',
      '',
      '本期目标说明',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);

  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(
    bodyHtml,
    new RegExp(`复用现有保存、拆分、图片处理、结果回显能力<\\/p>\\s*${BODY_SPACER_HTML_PATTERN}\\s*<p><strong>2\\.${OPTIONAL_SPACING_PATTERN}产品目标<\\/strong><\\/p>`)
  );
});

test('mixed-language prose list items stay in a single paragraph through body-mode save', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 标题',
      '',
      '- Popup / SidePanel 中新增“导入 MD”入口',
    ].join('\n'),
  });

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);

  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(bodyHtml, /Popup \/ SidePanel/);
  assert.match(bodyHtml, /中新增“/);
  assert.doesNotMatch(bodyHtml, /Popup \/ SidePanel<\/p>\s*<p>(?:<br>|&nbsp;|\u00A0)<\/p>\s*<p>中新增/);
});

test('ordered ordinary lists survive preview normalization and body-mode save without heading-like bolding', async () => {
  const result = await convertMarkdownImport({
    markdown: [
      '# 步骤',
      '',
      '1. 第一步',
      '2. 第二步',
      '3. 第三步',
    ].join('\n'),
  });

  const previewHtml = buildMowenPreviewBodyHtml(renderMarkdownPreviewBodyHtml(result.previewModel.blocks));
  assert.match(
    previewHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}1\\.${OPTIONAL_SPACING_PATTERN}第一步<\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}2\\.${OPTIONAL_SPACING_PATTERN}第二步<\\/p>`)
  );
  assert.doesNotMatch(previewHtml, /<strong>1\.\s*第一步<\/strong>/);

  const { splitContent } = await import('../src/background/index');
  const requests = splitContent(
    result.extractResult.title,
    result.extractResult.sourceUrl,
    result.extractResult.contentHtml,
    19000,
    result.extractResult.blocks,
    {
      preserveBodyMode: true,
      normalizeMarkdownBodySpacing: true,
      htmlToNoteAtomOptions: {
        preserveInlineParagraphs: true,
        enforceSingleTextBlockSpacing: true,
      },
    }
  );

  assert.equal(requests[0]?.createMode, 'body');
  const body = (requests[0] && requests[0].createMode === 'body') ? requests[0].body : null;
  assert.ok(body);

  const bodyHtml = noteAtomToHtml(body as Parameters<typeof noteAtomToHtml>[0]);
  assert.match(
    bodyHtml,
    new RegExp(`<p>${OPTIONAL_SPACING_PATTERN}1\\.${OPTIONAL_SPACING_PATTERN}第一步<\\/p>\\s*<p>${OPTIONAL_SPACING_PATTERN}2\\.${OPTIONAL_SPACING_PATTERN}第二步<\\/p>`)
  );
  assert.doesNotMatch(bodyHtml, /<strong>1\.\s*第一步<\/strong>/);
});

test('buildEditedPreviewExtractResult keeps only images still present in edited preview html', () => {
  const extractResult = createExtractResult({
    contentHtml: '<p>before</p><img src="https://cdn.example.com/1.png"><img src="https://cdn.example.com/2.png">',
    images: [
      createImage('img-1', 'https://cdn.example.com/1.png'),
      createImage('img-2', 'https://cdn.example.com/2.png'),
    ],
  });

  const edited = buildEditedPreviewExtractResult({
    extractResult,
    title: 'Edited title',
    html: '<p>after</p><img src="https://cdn.example.com/2.png" alt="keep">',
  });

  assert.equal(edited.title, 'Edited title');
  assert.match(edited.contentHtml, /<p>after<\/p>/);
  assert.equal(edited.images.length, 1);
  assert.equal(edited.images[0]?.normalizedUrl, 'https://cdn.example.com/2.png');
  assert.equal(edited.images[0]?.alt, 'keep');
});

test('buildEditedPreviewExtractResult preserves original structured blocks when preview html matches baseline', () => {
  const extractResult = createExtractResult({
    contentHtml: '<p><strong>标题</strong></p><p>正文 <code>mdImport.html</code></p>',
    blocks: [
      {
        id: 'block-heading',
        type: 'heading',
        html: '<p class="md-import-heading md-import-heading-2"><strong>标题</strong></p>',
        text: '标题',
        level: 2,
      },
      {
        id: 'block-body',
        type: 'paragraph',
        html: '<p>正文 <code>mdImport.html</code></p>',
        text: '正文 mdImport.html',
      },
    ],
  });

  const edited = buildEditedPreviewExtractResult({
    extractResult,
    title: '新标题',
    html: '<p><strong>标题</strong></p><p><br></p><p>正文 <code>mdImport.html</code></p>',
    baselineHtml: '<p><strong>标题</strong></p><p><br></p><p>正文 <code>mdImport.html</code></p>',
  });

  assert.equal(edited.title, '新标题');
  assert.equal(edited.blocks.length, 2);
  assert.equal(edited.blocks[0]?.id, 'block-heading');
  assert.equal(edited.blocks[1]?.id, 'block-body');
  assert.equal(edited.contentHtml, extractResult.contentHtml);
});
