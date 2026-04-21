import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignBilingualSegmentRuns,
  createTweetParagraphSpacerSegment,
  normalizeStructuredSequence,
  TWEET_PARAGRAPH_SPACER_HTML,
} from '../src/content/twitter/bilingual';
import { normalizeStructuredTwitterBlocks } from '../src/content/twitter/blockLayout';
import { buildTwitterCardSegments, isTwitterCardMetadataText } from '../src/content/twitter/card';
import { classifyTwitterContentShape } from '../src/content/twitter/classify';
import { shouldReuseTwitterCachedResult } from '../src/content/twitter/runtime';
import {
  appendQuoteTweetContentBlocks,
  buildMainTweetGenericFallbackSegmentsFromText,
  buildQuoteBlocksFromSegments,
  getQuoteLinkLabelFromBlocks,
  normalizeQuoteTweetUrl,
  shouldInsertSpacerBetweenTweetTextBatches,
  splitTextIntoTwitterInlineBreakTokens,
  shouldAppendGenericQuoteFallback,
} from '../src/content/twitterExtractor';
import { deriveTwitterTitle, truncateTwitterTitle } from '../src/content/twitter/title';
import type { TwitterTextSegment } from '../src/content/twitter/types';
import { planTwitterSaveRequests, planTwitterSaveRequestsFromEntries } from '../src/background/twitterSavePlan';
import { htmlToNoteAtom } from '../src/utils/noteAtom';
import {
  normalizeTwitterHtmlContent,
  normalizeTwitterNoteEntries,
  prepareTwitterLongformNotePlan,
  resolveTwitterSaveTitle,
} from '../src/twitterClip/notePlan';

function createParagraphEntry(text: string, groupId?: string) {
  return {
    node: {
      type: 'paragraph',
      content: [{ type: 'text', text }],
    },
    groupId,
  };
}

function getNodeText(node: { text?: string; content?: Array<{ text?: string; content?: Array<unknown> }> }): string {
  if (typeof node.text === 'string') {
    return node.text.replace(/[\u2060\u200b\u00a0]/g, '');
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content
    .map((child) => getNodeText(child as { text?: string; content?: Array<{ text?: string; content?: Array<unknown> }> }))
    .join('');
}

function summarizeTopLevelBodyNodes(body: {
  content?: Array<{ type: string; text?: string; content?: Array<{ text?: string; content?: Array<unknown> }> }>;
}) {
  return (body.content || []).map((node) => ({
    type: node.type,
    text: getNodeText(node),
  }));
}

const twitterSegmentAdapter = {
  clone: (item: TwitterTextSegment, groupId?: string): TwitterTextSegment => ({
    ...item,
    ...(groupId ? { groupId } : {}),
  }),
  createSpacer: createTweetParagraphSpacerSegment,
  getGroupId: (item: TwitterTextSegment) => item.groupId,
  getRole: (item: TwitterTextSegment) => item.role,
  hasText: (item: TwitterTextSegment) => Boolean(item.text.trim()),
  isSpacer: (item: TwitterTextSegment) => item.role === 'spacer',
};

test('classifyTwitterContentShape marks Draft.js content as x-article', () => {
  const result = classifyTwitterContentShape({
    hasDraftArticle: true,
    fullText: 'irrelevant',
    segments: [],
  });

  assert.deepEqual(result, {
    isXArticle: true,
    looksLikeLongformTweet: false,
    kind: 'x-article',
  });
});

test('classifyTwitterContentShape detects bilingual tweetText longform clips', () => {
  const segments: TwitterTextSegment[] = [
    {
      html: 'EN-1',
      text: 'Claude Code is not AGI, but it is the single biggest advance in AI since the LLM.',
      role: 'original',
      groupId: 'g1',
    },
    {
      html: 'ZH-1',
      text: 'Claude 代码不是通用人工智能，但它是自大型语言模型以来人工智能领域最大的进步。',
      role: 'translation',
      groupId: 'g1',
    },
    createTweetParagraphSpacerSegment('g1'),
    {
      html: 'EN-2',
      text: 'But the thing is, Claude Code is NOT a pure LLM. And it is not pure deep learning either.',
      role: 'original',
      groupId: 'g2',
    },
    {
      html: 'ZH-2',
      text: '但问题是，Claude Code 并不是纯粹的 LLM，而且它也不是纯粹的深度学习。',
      role: 'translation',
      groupId: 'g2',
    },
    createTweetParagraphSpacerSegment('g2'),
    {
      html: 'EN-3',
      text: 'The source code leak proves it, because the hidden core is a large deterministic pattern engine.',
      role: 'original',
      groupId: 'g3',
    },
    {
      html: 'ZH-3',
      text: '源代码泄露证明了这一点，因为其隐藏的核心是一个大型的确定性模式引擎。',
      role: 'translation',
      groupId: 'g3',
    },
    createTweetParagraphSpacerSegment('g3'),
    {
      html: 'EN-4',
      text: 'That architecture change is why the resulting system feels different from a plain chat model.',
      role: 'original',
      groupId: 'g4',
    },
    {
      html: 'ZH-4',
      text: '这种架构变化正是为什么最终系统给人的感觉与普通聊天模型不同。',
      role: 'translation',
      groupId: 'g4',
    },
  ];

  const fullText = [
    segments[0].text,
    segments[1].text,
    '',
    segments[3].text,
    segments[4].text,
    '',
    segments[6].text,
    segments[7].text,
    '',
    segments[9].text,
    segments[10].text,
  ].join('\n');

  const result = classifyTwitterContentShape({
    hasDraftArticle: false,
    fullText,
    segments,
  });

  assert.equal(result.kind, 'tweet-longform');
  assert.equal(result.looksLikeLongformTweet, true);
  assert.equal(result.isXArticle, false);
});

test('shouldReuseTwitterCachedResult rejects image-only cache when hydrated tweet text is present', () => {
  const cachedResult = {
    title: '如果你每周时间有限，但又想获得前沿',
    sourceUrl: 'https://x.com/vista8/status/2046394569848455371',
    domain: 'x.com',
    contentHtml: '<img src="https://pbs.twimg.com/media/example.jpg" />',
    blocks: [{
      id: 'img-1',
      type: 'image',
      html: '<img src="https://pbs.twimg.com/media/example.jpg" />',
      text: '',
    }],
    images: [],
    wordCount: 0,
  } as const;

  assert.equal(
    shouldReuseTwitterCachedResult(cachedResult, {
      articleCount: 1,
      hasHydratedTweetText: true,
      tweetTextCount: 1,
      tweetTextLength: 429,
    }),
    false
  );
});

test('shouldReuseTwitterCachedResult keeps cache with meaningful extracted text', () => {
  const cachedResult = {
    title: '如果你每周时间有限，但又想获得前沿',
    sourceUrl: 'https://x.com/vista8/status/2046394569848455371',
    domain: 'x.com',
    contentHtml: '<p>如果你每周时间有限，但又想获得前沿AI信息？</p>',
    blocks: [{
      id: 'p-1',
      type: 'paragraph',
      html: '<p>如果你每周时间有限，但又想获得前沿AI信息？</p>',
      text: '如果你每周时间有限，但又想获得前沿AI信息？',
    }],
    images: [],
    wordCount: 22,
  } as const;

  assert.equal(
    shouldReuseTwitterCachedResult(cachedResult, {
      articleCount: 1,
      hasHydratedTweetText: true,
      tweetTextCount: 1,
      tweetTextLength: 120,
    }),
    true
  );
});

test('truncateTwitterTitle keeps English word boundaries and Chinese hard limits', () => {
  assert.equal(
    truncateTwitterTitle('Alpha beta gamma delta epsilon zeta eta theta', 30),
    'Alpha beta gamma delta...'
  );

  const chineseTitle = '这是一个用于验证中文标题裁剪逻辑是否按三十字截断的长标题示例内容';
  assert.equal(
    truncateTwitterTitle(chineseTitle, 30),
    `${chineseTitle.slice(0, 27).trim()}...`
  );
});

test('main tweet generic fallback preserves meaningful paragraphs when tweetText is missing', () => {
  const text = [
    '如果你每周时间有限，但又想获得前沿AI信息？ 除了刷推特，分享三个精选信息源，读完基本不落伍。',
    '',
    '1. 老牌 AI Newsletter',
    '',
    'wise.readwise.io/issues/wisereads',
  ].join('\n');

  const segments = buildMainTweetGenericFallbackSegmentsFromText(text);

  assert.deepEqual(
    segments.map((segment) => segment.text),
    [
      '如果你每周时间有限，但又想获得前沿AI信息？ 除了刷推特，分享三个精选信息源，读完基本不落伍。',
      '1. 老牌 AI Newsletter',
    ]
  );
});

test('deriveTwitterTitle prefers longform primary content and skips contentStart dedup', () => {
  const result = deriveTwitterTitle({
    clipKind: 'tweet-longform',
    documentTitle: 'ignored on X',
    primaryTweetText: 'Alpha beta gamma delta epsilon zeta eta theta\n阿尔法贝塔伽马德尔塔',
    primarySegments: [
      { html: 'en', text: 'Alpha beta gamma delta epsilon zeta eta theta', role: 'original', groupId: 'g1' },
      { html: 'zh', text: '阿尔法贝塔伽马德尔塔', role: 'translation', groupId: 'g1' },
    ],
  });

  assert.equal(result.title, 'Alpha beta gamma delta...');
  assert.equal(result.contentStart, undefined);
});

test('deriveTwitterTitle keeps contentStart undefined for normal tweets so body stays complete', () => {
  const result = deriveTwitterTitle({
    clipKind: 'tweet',
    documentTitle: 'ignored on X',
    primaryTweetText: '如果你每周时间有限，但又想获得前沿AI信息？\n\n除了刷推特，分享三个精选信息源，读完基本不落伍。',
    primarySegments: [
      { html: 'p1', text: '如果你每周时间有限，但又想获得前沿AI信息？', role: 'normal' },
      { html: 'p2', text: '除了刷推特，分享三个精选信息源，读完基本不落伍。', role: 'normal' },
    ],
  });

  assert.equal(result.title, '如果你每周时间有限，但又想获得前沿');
  assert.equal(result.contentStart, undefined);
});

test('normalizeStructuredSequence enforces EN -> ZH -> spacer ordering', () => {
  const normalized = normalizeStructuredSequence<TwitterTextSegment>([
    { html: 'EN-1', text: 'English 1', role: 'original', groupId: 'g1' },
    createTweetParagraphSpacerSegment('g1'),
    { html: 'ZH-1', text: '中文 1', role: 'translation', groupId: 'g1' },
    { html: 'EN-2', text: 'English 2', role: 'original', groupId: 'g2' },
    createTweetParagraphSpacerSegment('g2'),
    { html: 'ZH-2', text: '中文 2', role: 'translation', groupId: 'g2' },
  ], twitterSegmentAdapter);

  assert.deepEqual(
    normalized.map((segment) => ({ text: segment.text, role: segment.role })),
    [
      { text: 'English 1', role: 'original' },
      { text: '中文 1', role: 'translation' },
      { text: '', role: 'spacer' },
      { text: 'English 2', role: 'original' },
      { text: '中文 2', role: 'translation' },
    ]
  );
});

test('alignBilingualSegmentRuns splits a single translation run on explicit paragraph breaks', () => {
  const originalSegments = [
    { html: 'how autoreason works', text: 'how autoreason works' },
    {
      html: 'Karpathy first paragraph',
      text: "Karpathy's AutoResearch but for tasks where there's no test to pass, content, strategy, positioning, copy",
    },
    {
      html: 'paper + code by SHL0MS',
      text: 'paper + code by SHL0MS, co-written with Hermes Agent by NousResearch x.com/82948227531848…',
    },
  ];
  const translationText = [
    '自动推理工作原理',
    'Karpathy 的 AutoResearch，但适用于那些不需要通过测试的任务，内容、策略、定位、复制',
    'paper + 代码由 SHL0MS 编写，与 Hermes 代理由 NousResearch x.com/82948227531848 共同编写……',
  ].join('\n\n');

  const aligned = alignBilingualSegmentRuns(originalSegments, [
    { html: translationText, text: translationText },
  ]);

  assert.equal(aligned.originalSegments.length, 3);
  assert.equal(aligned.translationSegments.length, 3);
  assert.deepEqual(
    aligned.translationSegments.map((segment) => segment.text),
    [
      '自动推理工作原理',
      'Karpathy 的 AutoResearch，但适用于那些不需要通过测试的任务，内容、策略、定位、复制',
      'paper + 代码由 SHL0MS 编写，与 Hermes 代理由 NousResearch x.com/82948227531848 共同编写……',
    ]
  );
});

test('alignBilingualSegmentRuns does not heuristically split quoted translation runs without explicit breaks', () => {
  const originalSegments = [
    { html: 'how autoreason works', text: 'how autoreason works' },
    {
      html: 'Karpathy first paragraph',
      text: "Karpathy's AutoResearch but for tasks where there's no test to pass, content, strategy, positioning, copy",
    },
    {
      html: 'paper + code by SHL0MS',
      text: 'paper + code by SHL0MS, co-written with Hermes Agent by NousResearch x.com/82948227531848…',
    },
  ];
  const translationText = '自动推理工作原理 Karpathy 的 AutoResearch，但适用于那些不需要通过测试的任务，内容、策略、定位、复制 paper + 代码由 SHL0MS 编写，与 Hermes 代理由 NousResearch x.com/82948227531848 共同编写……';

  const aligned = alignBilingualSegmentRuns(
    originalSegments,
    [{ html: translationText, text: translationText }],
    { allowReferenceDrivenSplit: false }
  );

  assert.equal(aligned.originalSegments.length, 1);
  assert.equal(aligned.translationSegments.length, 1);
  assert.equal(aligned.translationSegments[0]?.text, translationText);
});

test('normalizeStructuredTwitterBlocks keeps a single spacer between quote bilingual groups', () => {
  const normalized = normalizeStructuredTwitterBlocks([
    {
      id: 'q1-en',
      type: 'quote',
      html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">English 1</p></blockquote>',
      text: 'English 1',
      layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'g1' },
    },
    {
      id: 'q1-zh',
      type: 'quote',
      html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">中文 1</p></blockquote>',
      text: '中文 1',
      layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'g1' },
    },
    {
      id: 'g1-spacer',
      type: 'paragraph',
      html: TWEET_PARAGRAPH_SPACER_HTML,
      text: '',
      layout: { preserveInlineParagraphs: true, role: 'spacer', groupId: 'g1' },
    },
    {
      id: 'q2-en',
      type: 'quote',
      html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">English 2</p></blockquote>',
      text: 'English 2',
      layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'g2' },
    },
    {
      id: 'q2-zh',
      type: 'quote',
      html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">中文 2</p></blockquote>',
      text: '中文 2',
      layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'g2' },
    },
  ]);

  assert.deepEqual(
    normalized.map((block) => ({
      type: block.type,
      role: block.layout?.role,
      text: block.text,
    })),
    [
      { type: 'quote', role: 'original', text: 'English 1' },
      { type: 'quote', role: 'translation', text: '中文 1' },
      { type: 'paragraph', role: 'spacer', text: '' },
      { type: 'quote', role: 'original', text: 'English 2' },
      { type: 'quote', role: 'translation', text: '中文 2' },
    ]
  );
});

test('normalizeQuoteTweetUrl strips media suffixes from quoted status links', () => {
  assert.equal(
    normalizeQuoteTweetUrl('https://x.com/example/status/123/photo/1'),
    'https://x.com/example/status/123'
  );
  assert.equal(
    normalizeQuoteTweetUrl('https://x.com/example/status/123/video/1?foo=bar'),
    'https://x.com/example/status/123'
  );
});

test('isTwitterCardMetadataText detects bare domains and urls', () => {
  assert.equal(isTwitterCardMetadataText('openai.com'), true);
  assert.equal(isTwitterCardMetadataText('https://openai.com/blog/test'), true);
  assert.equal(isTwitterCardMetadataText('Trusted access for the next era of cyber defense'), false);
});

test('buildTwitterCardSegments drops metadata rows and preserves title-summary spacing', () => {
  const segments = buildTwitterCardSegments([
    [{ html: 'openai.com', text: 'openai.com', role: 'normal' }],
    [
      { html: 'Trusted access for the next era of cyber defense', text: 'Trusted access for the next era of cyber defense', role: 'original', groupId: 'g1' },
      { html: '为下一代网络防御提供可信访问', text: '为下一代网络防御提供可信访问', role: 'translation', groupId: 'g1' },
    ],
    [
      { html: 'OpenAI expands its Trusted Access for Cyber program.', text: 'OpenAI expands its Trusted Access for Cyber program.', role: 'original', groupId: 'g2' },
      { html: 'OpenAI 扩展其网络可信访问项目。', text: 'OpenAI 扩展其网络可信访问项目。', role: 'translation', groupId: 'g2' },
    ],
  ], () => 'spacer-group');

  assert.deepEqual(
    segments.map((segment) => ({ text: segment.text, role: segment.role })),
    [
      { text: 'Trusted access for the next era of cyber defense', role: 'original' },
      { text: '为下一代网络防御提供可信访问', role: 'translation' },
      { text: '', role: 'spacer' },
      { text: 'OpenAI expands its Trusted Access for Cyber program.', role: 'original' },
      { text: 'OpenAI 扩展其网络可信访问项目。', role: 'translation' },
    ]
  );
});

test('buildTwitterCardSegments pairs adjacent bilingual rows before inserting summary spacers', () => {
  const segments = buildTwitterCardSegments([
    [{ html: 'The Top AI Papers of the Week', text: 'The Top AI Papers of the Week', role: 'normal' }],
    [{ html: '本周人工智能论文', text: '本周人工智能论文', role: 'normal' }],
    [{ html: '- Memento', text: '- Memento', role: 'normal' }],
    [{ html: '- 纪念品', text: '- 纪念品', role: 'normal' }],
  ], () => 'g-card');

  assert.deepEqual(
    segments.map((segment) => ({ text: segment.text, role: segment.role })),
    [
      { text: 'The Top AI Papers of the Week', role: 'original' },
      { text: '本周人工智能论文', role: 'translation' },
      { text: '', role: 'spacer' },
      { text: '- Memento', role: 'original' },
      { text: '- 纪念品', role: 'translation' },
    ]
  );
});

test('buildTwitterCardSegments splits mixed-language single rows into alternating bilingual groups', () => {
  const segments = buildTwitterCardSegments([
    [{
      html: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      text: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      role: 'normal',
    }],
    [{
      html: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      text: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      role: 'normal',
    }],
  ], () => 'g-mixed-card');

  assert.deepEqual(
    segments.map((segment) => ({ text: segment.text, role: segment.role })),
    [
      { text: 'Why long-term memory for LLMs remains unsolved', role: 'original' },
      { text: '为什么大型语言模型的长期记忆问题仍未解决', role: 'translation' },
      { text: '', role: 'spacer' },
      { text: 'Despite what you see, long-term memory remains unsolved.', role: 'original' },
      { text: '尽管表面如此，长期记忆问题仍未解决。', role: 'translation' },
    ]
  );
});

test('buildQuoteBlocksFromSegments preserves image-adjacent quote paragraph grouping order', () => {
  const quoteBlocks = buildQuoteBlocksFromSegments([
    { html: 'Title EN', text: 'Title EN', role: 'original', groupId: 'g1' },
    { html: '标题中文', text: '标题中文', role: 'translation', groupId: 'g1' },
    createTweetParagraphSpacerSegment('g1'),
    { html: 'Summary EN', text: 'Summary EN', role: 'original', groupId: 'g2' },
    { html: '摘要中文', text: '摘要中文', role: 'translation', groupId: 'g2' },
  ]);

  assert.deepEqual(
    quoteBlocks.map((block) => ({
      type: block.type,
      role: block.layout?.role,
      text: block.text,
    })),
    [
      { type: 'quote', role: 'original', text: 'Title EN' },
      { type: 'quote', role: 'translation', text: '标题中文' },
      { type: 'paragraph', role: 'spacer', text: '' },
      { type: 'quote', role: 'original', text: 'Summary EN' },
      { type: 'quote', role: 'translation', text: '摘要中文' },
    ]
  );
});

test('buildQuoteBlocksFromSegments preserves alternating quote rows after mixed-language card-row recovery', () => {
  const quoteBlocks = buildQuoteBlocksFromSegments(buildTwitterCardSegments([
    [{
      html: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      text: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      role: 'normal',
    }],
    [{
      html: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      text: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      role: 'normal',
    }],
  ], () => 'g-quote-card'));

  assert.deepEqual(
    quoteBlocks.map((block) => ({
      type: block.type,
      role: block.layout?.role,
      text: block.text,
    })),
    [
      { type: 'quote', role: 'original', text: 'Why long-term memory for LLMs remains unsolved' },
      { type: 'quote', role: 'translation', text: '为什么大型语言模型的长期记忆问题仍未解决' },
      { type: 'paragraph', role: 'spacer', text: '' },
      { type: 'quote', role: 'original', text: 'Despite what you see, long-term memory remains unsolved.' },
      { type: 'quote', role: 'translation', text: '尽管表面如此，长期记忆问题仍未解决。' },
    ]
  );
});

test('appendQuoteTweetContentBlocks appends canonical quote blocks in order', () => {
  const blocks = [];
  const contentParts = [];
  const textParts = [];

  appendQuoteTweetContentBlocks(blocks, contentParts, textParts, {
    blocks: [{
      id: 'quote-1',
      type: 'quote',
      html: '<blockquote><p>Why long-term memory for LLMs remains unsolved</p><p>Despite what you see, long-term memory remains unsolved.</p></blockquote>',
      text: 'Why long-term memory for LLMs remains unsolved\nDespite what you see, long-term memory remains unsolved.',
    }, {
      id: 'img-1',
      type: 'image',
      html: '<img src="https://pbs.twimg.com/media/example.jpg" alt="" data-mowen-id="img-1" />',
      text: '',
    }],
  });

  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['quote', 'image']
  );
  assert.match(blocks[0].html, /Why long-term memory for LLMs remains unsolved/);
  assert.equal(blocks[1].type, 'image');
  assert.deepEqual(textParts, [
    'Why long-term memory for LLMs remains unsolved\nDespite what you see, long-term memory remains unsolved.',
  ]);
});

test('shouldAppendGenericQuoteFallback skips generic fallback when structured quote text already exists', () => {
  assert.equal(
    shouldAppendGenericQuoteFallback([{
      source: 'ordered',
      blocks: buildQuoteBlocksFromSegments([
        { html: 'Top AI Papers of the Week', text: 'Top AI Papers of the Week', role: 'original', groupId: 'g1' },
        { html: '本周顶级 AI 论文', text: '本周顶级 AI 论文', role: 'translation', groupId: 'g1' },
      ]),
    }]),
    false,
  );

  assert.equal(
    shouldAppendGenericQuoteFallback([{
      source: 'placeholder',
      blocks: [],
    }]),
    true,
  );
});

test('getQuoteLinkLabelFromBlocks prefers the first structured title block over later summary lines', () => {
  const blocks = buildQuoteBlocksFromSegments([
    { html: 'Top AI Papers of the Week', text: 'Top AI Papers of the Week', role: 'original', groupId: 'g1' },
    { html: '本周顶级 AI 论文', text: '本周顶级 AI 论文', role: 'translation', groupId: 'g1' },
    createTweetParagraphSpacerSegment('g1'),
    {
      html: 'The Top AI Papers of the Week (April 6 - April 12)\n1. Neural Computers',
      text: 'The Top AI Papers of the Week (April 6 - April 12)\n1. Neural Computers',
      role: 'original',
      groupId: 'g2',
    },
  ]);

  assert.equal(
    getQuoteLinkLabelFromBlocks('https://x.com/dair_ai/status/2043354582319870362', blocks),
    'Top AI Papers of the Week',
  );
});

test('planTwitterSaveRequests preserves fallback quote body when quoted article ordered blocks only contain images', () => {
  const requests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: "i've been working on llm...",
    sourceUrl: 'https://x.com/chrysb/status/2043024331538886838',
    content: '',
    limit: 10000,
    blocks: [
      {
        id: 'link-1',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="https://x.com/chrysb/status/2043024331538886838">Why long-term memory for LLMs remains unsolved</a></p>',
        text: '🔗 引用文章：Why long-term memory for LLMs remains unsolved',
        layout: { preserveInlineParagraphs: true },
      },
      {
        id: 'quote-1',
        type: 'quote',
        html: '<blockquote><p>Why long-term memory for LLMs remains unsolved</p><p>Despite what you see, long-term memory for conversational LLMs remains an unsolved problem.</p></blockquote>',
        text: 'Why long-term memory for LLMs remains unsolved\nDespite what you see, long-term memory for conversational LLMs remains an unsolved problem.',
      },
      {
        id: 'img-1',
        type: 'image',
        html: '<img src="https://pbs.twimg.com/media/example.jpg" alt="" data-mowen-id="img-1" />',
        text: '',
      },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  const quoteNode = (requests[0].body.content || []).find((node) =>
    typeof node === 'object' &&
    node !== null &&
    'type' in node &&
    node.type === 'quote'
  );

  assert.ok(quoteNode);
  assert.match(JSON.stringify(quoteNode), /Despite what you see/);
});

test('planTwitterSaveRequests keeps quoted article body alternating when card detail rows arrive mixed-language per row', () => {
  const quoteBlocks = buildQuoteBlocksFromSegments(buildTwitterCardSegments([
    [{
      html: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      text: 'Why long-term memory for LLMs remains unsolved 为什么大型语言模型的长期记忆问题仍未解决',
      role: 'normal',
    }],
    [{
      html: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      text: 'Despite what you see, long-term memory remains unsolved. 尽管表面如此，长期记忆问题仍未解决。',
      role: 'normal',
    }],
  ], () => 'g-mixed-save'));

  const requests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: 'Quoted article formatting',
    sourceUrl: 'https://x.com/example/status/1',
    content: '',
    limit: 1000,
    blocks: [
      {
        id: 'lead-en',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">Lead English</p>',
        text: 'Lead English',
        layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'lead-g1' },
      },
      {
        id: 'lead-zh',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">正文中文</p>',
        text: '正文中文',
        layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'lead-g1' },
      },
      {
        id: 'quote-link',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="https://example.com/ref">Why long-term memory for LLMs remains unsolved</a></p>',
        text: '🔗 引用文章：Why long-term memory for LLMs remains unsolved',
        layout: { preserveInlineParagraphs: true },
      },
      ...quoteBlocks,
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  const sequence = summarizeTopLevelBodyNodes(requests[0].body).slice(4);
  assert.deepEqual(sequence, [
    { type: 'paragraph', text: 'Lead English' },
    { type: 'paragraph', text: '正文中文' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '🔗 引用文章：Why long-term memory for LLMs remains unsolved' },
    { type: 'paragraph', text: '' },
    {
      type: 'quote',
      text: 'Why long-term memory for LLMs remains unsolved\n为什么大型语言模型的长期记忆问题仍未解决\n\nDespite what you see, long-term memory remains unsolved.\n尽管表面如此，长期记忆问题仍未解决。',
    },
  ]);
});

test('planTwitterSaveRequests formats twitter-post and x-longform bodies identically for the same bilingual body and quote blocks', () => {
  const sharedBlocks = [
    {
      id: 'body-en',
      type: 'paragraph',
      html: '<p data-mowen-preserve-inline-paragraph="1">Lead English</p>',
      text: 'Lead English',
      layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'body-g1' },
    },
    {
      id: 'body-zh',
      type: 'paragraph',
      html: '<p data-mowen-preserve-inline-paragraph="1">正文中文</p>',
      text: '正文中文',
      layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'body-g1' },
    },
    {
      id: 'body-spacer',
      type: 'paragraph',
      html: TWEET_PARAGRAPH_SPACER_HTML,
      text: '',
      layout: { preserveInlineParagraphs: true, role: 'spacer', groupId: 'body-g1' },
    },
    {
      id: 'quote-link',
      type: 'paragraph',
      html: '<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="https://example.com/ref">Why long-term memory for LLMs remains unsolved</a></p>',
      text: '🔗 引用文章：Why long-term memory for LLMs remains unsolved',
      layout: { preserveInlineParagraphs: true },
    },
    ...buildQuoteBlocksFromSegments([
      { html: 'Why long-term memory for LLMs remains unsolved', text: 'Why long-term memory for LLMs remains unsolved', role: 'original', groupId: 'quote-g1' },
      { html: '为什么大型语言模型的长期记忆问题仍未解决', text: '为什么大型语言模型的长期记忆问题仍未解决', role: 'translation', groupId: 'quote-g1' },
      createTweetParagraphSpacerSegment('quote-g1'),
      { html: 'Despite what you see, long-term memory remains unsolved.', text: 'Despite what you see, long-term memory remains unsolved.', role: 'original', groupId: 'quote-g2' },
      { html: '尽管表面如此，长期记忆问题仍未解决。', text: '尽管表面如此，长期记忆问题仍未解决。', role: 'translation', groupId: 'quote-g2' },
    ]),
  ];

  const twitterPostRequests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: 'Unified formatting',
    sourceUrl: 'https://x.com/example/status/1',
    content: '',
    limit: 2000,
    blocks: sharedBlocks,
  });
  const xLongformRequests = planTwitterSaveRequests({
    clipKind: 'x-longform',
    title: 'Unified formatting',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p>unused</p>',
    limit: 2000,
    blocks: sharedBlocks,
  });

  assert.equal(twitterPostRequests.length, 1);
  assert.equal(xLongformRequests.length, 1);
  assert.equal(twitterPostRequests[0].createMode, 'body');
  assert.equal(xLongformRequests[0].createMode, 'body');
  if (twitterPostRequests[0].createMode !== 'body' || xLongformRequests[0].createMode !== 'body') {
    throw new Error('expected body requests');
  }

  assert.deepEqual(
    summarizeTopLevelBodyNodes(twitterPostRequests[0].body),
    summarizeTopLevelBodyNodes(xLongformRequests[0].body),
  );
});

test('planTwitterSaveRequests avoids double spacers when bilingual body already ends with a spacer before quote link', () => {
  const requests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: 'Spacer boundary',
    sourceUrl: 'https://x.com/example/status/2',
    content: '',
    limit: 2000,
    blocks: [
      {
        id: 'body-en',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">Lead English</p>',
        text: 'Lead English',
        layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'body-g1' },
      },
      {
        id: 'body-zh',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">正文中文</p>',
        text: '正文中文',
        layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'body-g1' },
      },
      {
        id: 'body-spacer',
        type: 'paragraph',
        html: TWEET_PARAGRAPH_SPACER_HTML,
        text: '',
        layout: { preserveInlineParagraphs: true, role: 'spacer', groupId: 'body-g1' },
      },
      {
        id: 'quote-link',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="https://example.com/ref">Quoted title</a></p>',
        text: '🔗 引用文章：Quoted title',
        layout: { preserveInlineParagraphs: true },
      },
      ...buildQuoteBlocksFromSegments([
        { html: 'Quoted title', text: 'Quoted title', role: 'original', groupId: 'quote-g1' },
        { html: '引用标题', text: '引用标题', role: 'translation', groupId: 'quote-g1' },
      ]),
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  assert.deepEqual(
    summarizeTopLevelBodyNodes(requests[0].body).slice(4),
    [
      { type: 'paragraph', text: 'Lead English' },
      { type: 'paragraph', text: '正文中文' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '🔗 引用文章：Quoted title' },
      { type: 'paragraph', text: '' },
      { type: 'quote', text: 'Quoted title\n引用标题' },
    ]
  );
});

test('planTwitterSaveRequests uses body mode for single x-longform clips and preserves title source body spacing', () => {
  const requests = planTwitterSaveRequests({
    clipKind: 'x-longform',
    title: 'Claude Code is not AGI,...',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p>English</p><p>中文</p>',
    limit: 200,
    blocks: [
      {
        id: 'b1',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">English</p>',
        text: 'English',
        layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'g1' },
      },
      {
        id: 'b2',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">中文</p>',
        text: '中文',
        layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'g1' },
      },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  assert.deepEqual(
    summarizeTopLevelBodyNodes(requests[0].body).slice(0, 6),
    [
      { type: 'paragraph', text: 'Claude Code is not AGI,...' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '📄 来源：查看原文' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'English' },
      { type: 'paragraph', text: '中文' },
    ]
  );
});

test('prepareTwitterLongformNotePlan propagates split titles for multipart saves', () => {
  const requests = prepareTwitterLongformNotePlan({
    title: 'Claude Code is not AGI,...',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p>unused for split</p>',
    entries: [
      createParagraphEntry('English block one', 'g1'),
      createParagraphEntry('中文块一', 'g1'),
      createParagraphEntry('English block two', 'g2'),
      createParagraphEntry('中文块二', 'g2'),
    ],
    limit: 26,
    singleNoteCreateMode: 'html',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => ({
      createMode: request.createMode,
      index: request.index,
      total: request.total,
      title: request.title,
    })),
    [
      { createMode: 'body', index: 0, total: 2, title: 'Claude Code is not AGI,...' },
      { createMode: 'body', index: 1, total: 2, title: 'Claude Code is not AGI,... (2)' },
    ]
  );
  assert.equal(requests[0].createMode, 'body');
  assert.equal(requests[1].createMode, 'body');
  assert.match(JSON.stringify(requests[0].body), /Claude Code is not AGI,\.\.\./);
  assert.match(JSON.stringify(requests[1].body), /Claude Code is not AGI,\.\.\. \(2\)/);
});

test('resolveTwitterSaveTitle falls back to the first content paragraph when title is blank', () => {
  const resolvedTitle = resolveTwitterSaveTitle(
    '',
    [createParagraphEntry('Alpha beta gamma delta epsilon zeta eta theta')],
    '<p>unused</p>'
  );

  assert.equal(resolvedTitle, 'Alpha beta gamma delta...');
});

test('normalizeTwitterNoteEntries collapses consecutive blank paragraphs to one spacer', () => {
  const normalized = normalizeTwitterNoteEntries([
    createParagraphEntry('English'),
    createParagraphEntry(''),
    createParagraphEntry(''),
    createParagraphEntry('中文'),
    createParagraphEntry(''),
    createParagraphEntry(''),
    createParagraphEntry('链接'),
  ]);

  assert.deepEqual(
    normalized.map((entry) => entry.node.content?.[0]?.text || ''),
    ['English', '', '中文', '', '链接']
  );
});

test('normalizeTwitterNoteEntries merges quoted reference runs into one contiguous quote node', () => {
  const normalized = normalizeTwitterNoteEntries([
    createParagraphEntry('Lead English', 'body-g1'),
    createParagraphEntry('正文中文', 'body-g1'),
    createParagraphEntry('🔗 引用文章：Reference title'),
    createParagraphEntry(''),
    {
      node: {
        type: 'quote',
        content: [{ type: 'text', text: 'Quoted English' }],
      },
      groupId: 'quote-g1',
    },
    {
      node: {
        type: 'quote',
        content: [{ type: 'text', text: '引用中文' }],
      },
      groupId: 'quote-g1',
    },
    createParagraphEntry(''),
    {
      node: {
        type: 'quote',
        content: [{ type: 'text', text: 'Summary English' }],
      },
      groupId: 'quote-g2',
    },
    {
      node: {
        type: 'quote',
        content: [{ type: 'text', text: '摘要中文' }],
      },
      groupId: 'quote-g2',
    },
  ]);

  assert.deepEqual(
    normalized.map((entry) => ({
      type: entry.node.type,
      text: getNodeText(entry.node),
    })),
    [
      { type: 'paragraph', text: 'Lead English' },
      { type: 'paragraph', text: '正文中文' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '🔗 引用文章：Reference title' },
      { type: 'paragraph', text: '' },
      { type: 'quote', text: 'Quoted English\n引用中文\n\nSummary English\n摘要中文' },
    ]
  );
});

test('normalizeTwitterHtmlContent keeps at most one blank paragraph between sections', () => {
  const normalized = normalizeTwitterHtmlContent(
    '<p>English</p><p><br></p><p><br></p><p>中文</p><p><br></p><p><br></p><p><br></p><p>Link</p>'
  );

  assert.equal(normalized, '<p>English</p><p><br></p><p>中文</p><p><br></p><p>Link</p>');
});

test('normalizeTwitterHtmlContent preserves a single blank line for repeated br runs', () => {
  const normalized = normalizeTwitterHtmlContent(
    '<p>段落</p><p data-mowen-preserve-inline-paragraph="1">Paper:<br><br><br>https://arxiv.org/abs/2604.08000</p>'
  );

  assert.equal(
    normalized,
    '<p>段落</p><p data-mowen-preserve-inline-paragraph="1">Paper:<br><br>https://arxiv.org/abs/2604.08000</p>'
  );
});

test('htmlToNoteAtom keeps one spacer paragraph for preserved inline br-only blocks', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1">English</p><p data-mowen-preserve-inline-paragraph="1"><br></p><p data-mowen-preserve-inline-paragraph="1">中文</p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  assert.deepEqual(
    (atom.content || []).map((node) => ({
      type: node.type,
      text: node.content?.map((child) => child.text || '').join('') || '',
    })),
    [
      { type: 'paragraph', text: 'English' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '中文' },
    ]
  );
});

test('htmlToNoteAtom preserves bold marks inside preserved inline twitter paragraphs', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1"><strong>1. 老牌AI Newsletter</strong></p>'
  ) as {
    content?: Array<{
      type: string;
      content?: Array<{ text?: string; marks?: Array<{ type: string }> }>;
    }>;
  };

  const firstNode = atom.content?.[0]?.content?.[0];
  assert.match(
    (firstNode?.text || '').replace(/[\u2060\u200b]/g, ''),
    /^1\.\s*老牌\s*AI Newsletter$/
  );
  assert.deepEqual(firstNode?.marks, [{ type: 'bold' }]);
});

test('htmlToNoteAtom preserves one blank line inside preserved inline paragraphs', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1">Paper:<br><br><br>https://arxiv.org/abs/2604.08000</p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  assert.equal(
    atom.content?.[0]?.content?.map((child) => child.text || '').join(''),
    'Paper:\n\nhttps://arxiv.org/abs/2604.08000'
  );
});

test('htmlToNoteAtom trims boundary breaks but keeps one internal blank line for preserved inline links', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1"><br><br>Paper:<br><br><br>https://arxiv.org/abs/2604.08000<br><br></p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  assert.equal(
    atom.content?.[0]?.content?.map((child) => child.text || '').join(''),
    'Paper:\n\nhttps://arxiv.org/abs/2604.08000'
  );
});

test('htmlToNoteAtom trims boundary line breaks inside preserved inline paragraphs', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1">\n\nPaper: <a href="https://example.com">https://example.com</a></p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  assert.equal(
    atom.content?.[0]?.content?.map((child) => child.text || '').join(''),
    'Paper: https://example.com'
  );
});

test('splitTextIntoTwitterInlineBreakTokens keeps whitespace-only blank lines for bare links', () => {
  assert.deepEqual(
    splitTextIntoTwitterInlineBreakTokens('\n\nhttps://example.com\n\n'),
    ['', '', 'https://example.com', '', '']
  );
});

test('htmlToNoteAtom turns preserved inline anchor spacing into paragraph spacer blocks', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1">Lead<br><br><a href="https://example.com">https://example.com</a><br><br>Next</p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  assert.deepEqual(
    (atom.content || []).map((node) => ({
      type: node.type,
      text: node.content?.map((child) => child.text || '').join('') || '',
    })),
    [
      { type: 'paragraph', text: 'Lead' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'https://example.com' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'Next' },
    ]
  );
});

test('shouldInsertSpacerBetweenTweetTextBatches keeps blank lines between separate main tweet text blocks', () => {
  assert.equal(
    shouldInsertSpacerBetweenTweetTextBatches(
      {
        id: 'prev',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">前三年更新稳定</p>',
        text: '前三年更新稳定',
        layout: { preserveInlineParagraphs: true, role: 'normal' },
      },
      [{
        html: '<a href="https://example.com">https://example.com</a>',
        text: 'https://example.com',
        role: 'normal',
      }]
    ),
    true
  );

  assert.equal(
    shouldInsertSpacerBetweenTweetTextBatches(
      {
        id: 'spacer',
        type: 'paragraph',
        html: '<p><br></p>',
        text: '',
        layout: { preserveInlineParagraphs: true, role: 'spacer' },
      },
      [{
        html: '<a href="https://example.com">https://example.com</a>',
        text: 'https://example.com',
        role: 'normal',
      }]
    ),
    false
  );
});

test('prepareTwitterLongformNotePlan repairs blank titles and repeated blank lines for single-note body saves', () => {
  const requests = prepareTwitterLongformNotePlan({
    title: '',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p>Alpha beta gamma delta epsilon zeta eta theta</p><p><br></p><p><br></p><p>中文</p>',
    entries: [
      createParagraphEntry('Alpha beta gamma delta epsilon zeta eta theta'),
      createParagraphEntry(''),
      createParagraphEntry(''),
      createParagraphEntry('中文'),
    ],
    limit: 200,
    singleNoteCreateMode: 'body',
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, 'Alpha beta gamma delta...');
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  assert.deepEqual(
    summarizeTopLevelBodyNodes(requests[0].body).slice(0, 7),
    [
      { type: 'paragraph', text: 'Alpha beta gamma delta...' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '📄 来源：查看原文' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'Alpha beta gamma delta epsilon zeta eta theta' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '中文' },
    ]
  );
});

test('planTwitterSaveRequestsFromEntries prefixes body saves with title and source for twitter posts', () => {
  const requests = planTwitterSaveRequestsFromEntries({
    clipKind: 'twitter-post',
    title: '',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p>Alpha beta gamma delta epsilon zeta eta theta</p><p><br></p><p><br></p><p>中文</p>',
    limit: 200,
    contentEntries: [
      createParagraphEntry('Alpha beta gamma delta epsilon zeta eta theta'),
      createParagraphEntry(''),
      createParagraphEntry(''),
      createParagraphEntry('中文'),
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  assert.deepEqual(
    summarizeTopLevelBodyNodes(requests[0].body).slice(0, 7),
    [
      { type: 'paragraph', text: 'Alpha beta gamma delta...' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '📄 来源：查看原文' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'Alpha beta gamma delta epsilon zeta eta theta' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: '中文' },
    ]
  );
});

test('planTwitterSaveRequests pads reference links with single blank lines and keeps images tight', () => {
  const requests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: 'Reference formatting',
    sourceUrl: 'https://x.com/example/status/1',
    content: '',
    limit: 1000,
    blocks: [
      {
        id: 'body-1',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">Lead English</p>',
        text: 'Lead English',
        layout: { preserveInlineParagraphs: true, role: 'original', groupId: 'g1' },
      },
      {
        id: 'body-2',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">正文中文</p>',
        text: '正文中文',
        layout: { preserveInlineParagraphs: true, role: 'translation', groupId: 'g1' },
      },
      {
        id: 'quote-link',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">🔗 引用文章：<a href="https://example.com/ref">Reference title</a></p>',
        text: '🔗 引用文章：Reference title',
        layout: { preserveInlineParagraphs: true },
      },
      {
        id: 'quote-en',
        type: 'quote',
        html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">Quoted English</p></blockquote>',
        text: 'Quoted English',
      },
      {
        id: 'quote-zh',
        type: 'quote',
        html: '<blockquote><p data-mowen-preserve-inline-paragraph="1">引用中文</p></blockquote>',
        text: '引用中文',
      },
      {
        id: 'quote-image',
        type: 'image',
        html: '<img src="https://pbs.twimg.com/media/example.jpg" alt="" data-mowen-id="img-1" />',
        text: '',
      },
      {
        id: 'tail',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">Back to article</p>',
        text: 'Back to article',
        layout: { preserveInlineParagraphs: true, role: 'normal', groupId: 'g2' },
      },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  const sequence = summarizeTopLevelBodyNodes(requests[0].body).slice(4);
  assert.deepEqual(sequence, [
    { type: 'paragraph', text: 'Lead English' },
    { type: 'paragraph', text: '正文中文' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '🔗 引用文章：Reference title' },
    { type: 'paragraph', text: '' },
    { type: 'quote', text: 'Quoted English\n引用中文' },
    { type: 'image', text: '' },
    { type: 'paragraph', text: 'Back to article' },
  ]);
});

test('planTwitterSaveRequests renders standalone link spacing with visible spacer paragraphs', () => {
  const requests = planTwitterSaveRequests({
    clipKind: 'twitter-post',
    title: 'Link spacing',
    sourceUrl: 'https://x.com/example/status/1',
    content: '',
    limit: 1000,
    blocks: [
      {
        id: 'body-1',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1">前三年更新稳定，每周AI热点和AI工具非常全面。</p>',
        text: '前三年更新稳定，每周AI热点和AI工具非常全面。',
        layout: { preserveInlineParagraphs: true, role: 'normal', groupId: 'g1' },
      },
      {
        id: 'link-1',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1"><a href="https://bensbites.com">bensbites.com</a></p>',
        text: 'bensbites.com',
        layout: { preserveInlineParagraphs: true, role: 'normal', groupId: 'g2' },
      },
      {
        id: 'body-2',
        type: 'paragraph',
        html: '<p data-mowen-preserve-inline-paragraph="1"><strong>2. AK大神去Huggingface后搞的热门AI论文Digg榜。</strong></p>',
        text: '2. AK大神去Huggingface后搞的热门AI论文Digg榜。',
        layout: { preserveInlineParagraphs: true, role: 'normal', groupId: 'g3' },
      },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  if (requests[0].createMode !== 'body') {
    throw new Error('expected body request');
  }

  const bodyNodes = requests[0].body.content || [];
  const linkIndex = bodyNodes.findIndex((node) => getNodeText(node).trim() === 'bensbites.com');
  assert.ok(linkIndex > 0, 'expected standalone link paragraph in body');

  const previousSpacerNode = bodyNodes[linkIndex - 1] as { content?: Array<{ text?: string }> };
  const nextSpacerNode = bodyNodes[linkIndex + 1] as { content?: Array<{ text?: string }> };

  assert.equal(getNodeText(previousSpacerNode as { text?: string; content?: Array<{ text?: string; content?: Array<unknown> }> }), '');
  assert.equal(getNodeText(nextSpacerNode as { text?: string; content?: Array<{ text?: string; content?: Array<unknown> }> }), '');
  assert.equal(previousSpacerNode.content?.[0]?.text, '\u00A0');
  assert.equal(nextSpacerNode.content?.[0]?.text, '\u00A0');
});

test('planTwitterSaveRequestsFromEntries avoids stacked blank space before preserved-inline link paragraphs', () => {
  const atom = htmlToNoteAtom(
    '<p data-mowen-preserve-inline-paragraph="1"><br><br>Paper:<br><br><br>https://arxiv.org/abs/2604.08000</p>'
  ) as {
    content?: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };

  const requests = planTwitterSaveRequestsFromEntries({
    clipKind: 'twitter-post',
    title: 'Paper Links',
    sourceUrl: 'https://x.com/example/status/1',
    content: '<p data-mowen-preserve-inline-paragraph="1"><br><br>Paper:<br><br><br>https://arxiv.org/abs/2604.08000</p>',
    limit: 200,
    contentEntries: (atom.content || []).map((node) => ({ node })),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].createMode, 'body');
  assert.doesNotMatch(JSON.stringify(requests[0].body), /\\n\\nPaper:/);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /2604\.08000\\n\\n/);
  assert.match(JSON.stringify(requests[0].body), /Paper:\\n\\n/);
  assert.match(JSON.stringify(requests[0].body), /https:\/\/arxiv\.org\/abs\/2604\.08000/);
});
