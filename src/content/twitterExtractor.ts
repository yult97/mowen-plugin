/**
 * Twitter/X 专用内容提取器
 * 
 * 只提取推文正文内容，排除所有动态元素（点赞数、时间戳、评论等），
 * 确保每次提取的字数稳定一致。
 * 支持提取 Quote Tweet（引用推文）并格式化为引用块。
 */

import { ExtractResult, ContentBlock, ImageCandidate } from '../types';
import { generateId } from '../utils/helpers';
import { extractImages } from './images';
import { TWITTER_SELECTORS } from '../config/site-selectors';
import { normalizeImageUrl } from './imageNormalizer';
import { detectCodeLanguage } from '../utils/shikiLanguages';

/**
 * 辅助函数：归一化文本
 * 去除标点、空格、特殊符号，仅保留文字和数字，用于模糊匹配去重
 */
function normalizeText(text: string): string {
    return text.replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase();
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function serializeElementAttributes(element: Element | null): string {
    if (!element) {
        return '';
    }

    return Array.from(element.attributes)
        .map((attribute) => `${attribute.name}="${attribute.value}"`)
        .join(' ');
}

function normalizeCodeText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/^\n+|\n+$/g, '');
}

function extractNormalizedCodeBlock(pre: HTMLElement): { html: string; text: string } | null {
    const code = pre.querySelector('code');
    const rawText = code?.textContent || pre.textContent || '';
    const codeText = normalizeCodeText(rawText);

    if (!codeText.trim()) {
        return null;
    }

    const language = detectCodeLanguage(
        serializeElementAttributes(pre),
        serializeElementAttributes(code)
    ) || 'text';
    const escapedCode = escapeHtml(codeText);

    return {
        html: `<pre data-language="${language}"><code class="language-${language}">${escapedCode}</code></pre>`,
        text: codeText,
    };
}

function preserveTextNodeLineBreaks(root: HTMLElement): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    let currentNode = walker.nextNode();
    while (currentNode) {
        if (currentNode instanceof Text) {
            textNodes.push(currentNode);
        }
        currentNode = walker.nextNode();
    }

    textNodes.forEach((textNode) => {
        const value = textNode.nodeValue || '';
        if (!value.includes('\n') || !value.trim()) {
            return;
        }

        const parent = textNode.parentNode;
        if (!parent) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const parts = value.split(/\n+/);

        parts.forEach((part, index) => {
            if (part) {
                fragment.appendChild(document.createTextNode(part));
            }
            if (index < parts.length - 1) {
                fragment.appendChild(document.createElement('br'));
            }
        });

        parent.replaceChild(fragment, textNode);
    });
}

function normalizeXArticleInlineHtml(element: HTMLElement): string {
    const clone = element.cloneNode(true) as HTMLElement;

    Array.from(clone.querySelectorAll('div')).reverse().forEach((div) => {
        const parent = div.parentNode;
        if (!parent) {
            return;
        }

        const fragment = document.createDocumentFragment();
        while (div.firstChild) {
            fragment.appendChild(div.firstChild);
        }

        if (div.nextSibling) {
            fragment.appendChild(document.createElement('br'));
        }

        parent.replaceChild(fragment, div);
    });

    preserveTextNodeLineBreaks(clone);

    clone.querySelectorAll('*').forEach((node) => {
        if (!(node instanceof HTMLElement)) {
            return;
        }

        Array.from(node.attributes).forEach((attribute) => {
            const keepStyle = attribute.name === 'style';
            const keepHref = node.tagName === 'A' && attribute.name === 'href';
            if (!keepStyle && !keepHref) {
                node.removeAttribute(attribute.name);
            }
        });
    });

    return clone.innerHTML;
}

/**
 * Quote Tweet（引用推文）数据结构
 */
interface QuoteTweet {
    /** 原推文链接 */
    url: string;
    /** 引用链接展示文案（优先使用标题） */
    linkLabel?: string;
    /** 引用推文的文本内容 */
    text: string;
    /** 引用推文的 HTML 内容 */
    html: string;
    /** 引用推文中的图片 */
    images: ImageCandidate[];
}

interface TweetTextSegment {
    html: string;
    text: string;
    textOnly?: boolean;
}

const TWEET_PARAGRAPH_SPACER_HTML = '<p><br></p>';

/**
 * 检测是否为 Twitter/X 页面
 */
export function isTwitterPage(url: string): boolean {
    return url.includes('twitter.com') || url.includes('x.com');
}

// 标记脚本是否已注入
let pageContextHelperInjected = false;

// Quote URL 缓存：避免在多次稳定性检测提取中重复调用 pageContextHelper
// Key: 容器元素的某个稳定标识（如 innerText hash 或 DOM 路径）
// Value: 提取到的 URL
const quoteUrlCache = new Map<string, string>();

/**
 * 生成容器的缓存 key（基于内容 hash）
 */
function getContainerCacheKey(container: HTMLElement): string {
    // 使用容器的文本内容前 100 字符作为 key
    const textContent = (container.innerText || '').trim().substring(0, 100);
    // 简单 hash
    let hash = 0;
    for (let i = 0; i < textContent.length; i++) {
        hash = ((hash << 5) - hash) + textContent.charCodeAt(i);
        hash = hash & hash;
    }
    return `quote_${hash}`;
}

/**
 * 清理 Quote URL 缓存
 * 应在 SPA 路由变化（URL 变化）时调用
 */
export function clearQuoteUrlCache(): void {
    if (quoteUrlCache.size > 0) {
        console.log(`[twitterExtractor] 🗑️ 清理 Quote URL 缓存 (${quoteUrlCache.size} 条)`);
        quoteUrlCache.clear();
    }
}

/**
 * 注入 pageContextHelper.js 到页面主世界
 * 这个脚本可以访问 React Fiber，并通过 CustomEvent 与 Content Script 通信
 */
function injectPageContextHelper(): void {
    if (pageContextHelperInjected) return;
    if (typeof chrome === 'undefined' || !chrome.runtime) return;

    try {
        const scriptUrl = chrome.runtime.getURL('public/pageContextHelper.js');
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.onload = () => {
            console.log('[twitterExtractor] ✅ pageContextHelper.js 注入成功');
            script.remove();
        };
        script.onerror = (e) => {
            console.log('[twitterExtractor] ⚠️ pageContextHelper.js 注入失败:', e);
        };
        (document.head || document.documentElement).appendChild(script);
        pageContextHelperInjected = true;
    } catch (e) {
        console.log('[twitterExtractor] ⚠️ 注入脚本出错:', e);
    }
}

/**
 * 通过页面上下文提取 React Fiber 中的 URL
 * 使用 CustomEvent 与 pageContextHelper.js 通信
 * 
 * 注意：此函数是异步的，因为需要等待 pageContextHelper.js 返回结果
 */
async function extractUrlViaPageContext(element: HTMLElement): Promise<string | null> {
    const tempId = `mowen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    element.setAttribute('data-mowen-temp-id', tempId);

    return new Promise((resolve) => {
        let resolved = false;

        // 设置结果监听器
        const resultHandler = (event: CustomEvent) => {
            const detail = event.detail || {};
            if (detail.tempId === tempId && !resolved) {
                resolved = true;
                const result = detail.result;
                // 清理
                document.removeEventListener('mowen-extract-url-result', resultHandler as EventListener);
                element.removeAttribute('data-mowen-temp-id');

                if (result && result.startsWith('http')) {
                    resolve(result);
                } else {
                    resolve(null);
                }
            }
        };

        document.addEventListener('mowen-extract-url-result', resultHandler as EventListener);

        // 触发提取事件
        document.dispatchEvent(new CustomEvent('mowen-extract-url', {
            detail: { tempId }
        }));

        // 设置超时（500ms 以确保即使在多次快速提取时也有足够时间）
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                document.removeEventListener('mowen-extract-url-result', resultHandler as EventListener);
                element.removeAttribute('data-mowen-temp-id');
                console.log('[twitterExtractor] ⚠️ extractUrlViaPageContext 超时');
                resolve(null);
            }
        }, 500);
    });
}

/**
 * 提取 Twitter/X 页面内容
 * 
 * 专注于提取推文正文，排除动态元素
 */
export async function extractTwitterContent(url: string, domain: string): Promise<ExtractResult> {
    console.log('[twitterExtractor] 🐦 开始提取 X/Twitter 内容');

    // 注入页面上下文辅助脚本（用于访问 React Fiber）
    injectPageContextHelper();

    // 尝试多个备选选择器获取主推文容器
    const containerSelectors = [
        TWITTER_SELECTORS.primaryColumn,           // [data-testid="primaryColumn"]
        '[data-testid="tweet"]',                   // 直接找推文
        'main[role="main"]',                       // 主内容区
        '[role="main"]',                           // 备选主内容区
        'article',                                 // 通用文章容器
    ];

    let container: HTMLElement | null = null;
    for (const selector of containerSelectors) {
        container = document.querySelector(selector) as HTMLElement;
        if (container && container.innerText.length > 50) {
            console.log(`[twitterExtractor] ✅ 找到容器: ${selector}`);
            break;
        }
    }

    if (!container) {
        console.log('[twitterExtractor] ⚠️ 未找到任何容器，返回空结果以触发回退');
        return createEmptyResult(url, domain);
    }

    // 1. 检测是否为 X Article
    const isXArticle = detectXArticle(container);

    // 2. 提取标题
    const { title, contentStart } = extractTitleWithMeta(container, isXArticle);

    let baseContentHtml: string;
    let baseBlocks: ContentBlock[];
    let textContent: string;
    let quoteTweets: QuoteTweet[];
    let quoteTweetContainers: Element[];
    let mainImages: ImageCandidate[];

    if (isXArticle) {
        console.log('[twitterExtractor] 📄 检测到 X Article（长文章），使用专用提取器');
        // 传入 contentStart 用于去重
        const articleResult = await extractXArticleContent(container, contentStart);
        baseContentHtml = articleResult.contentHtml;
        baseBlocks = articleResult.blocks;
        textContent = articleResult.textContent;
        mainImages = articleResult.images;
        quoteTweets = articleResult.quoteTweets;
        quoteTweetContainers = articleResult.quoteTweetContainers;
        // X Article 已按 DOM 顺序提取所有内容（文字、图片、Quote Tweet）
        // 无需额外的图片过滤和 Quote 拼装
    } else {
        // 普通推文提取
        // 传入 contentStart 用于去重
        const tweetResult = await extractTweetContent(container, contentStart);
        baseContentHtml = tweetResult.contentHtml;
        baseBlocks = tweetResult.blocks;
        textContent = tweetResult.textContent;
        quoteTweets = tweetResult.quoteTweets;
        quoteTweetContainers = tweetResult.quoteTweetContainers;
        mainImages = extractTweetImages(container, quoteTweetContainers as HTMLElement[]);
    }

    // 构建最终 images 数组
    let images: ImageCandidate[];
    if (isXArticle) {
        images = mainImages; // X Article 已包含所有图片
        console.log(`[twitterExtractor] 📷 X Article 图片总数: ${images.length} 张 (已含引用图片)`);
    } else {
        const quoteImages = quoteTweets.flatMap((qt) => qt.images);
        images = [...mainImages, ...quoteImages];
        console.log(`[twitterExtractor] 📷 普通推文图片: 主帖 ${mainImages.length} 张 + 引用 ${quoteImages.length} 张 = ${images.length} 张`);
    }

    // 对于 X Article，图片已在 extractXArticleContent 中按 DOM 顺序添加到 baseBlocks
    // 无需再生成和插入 mainImageBlocks，直接使用 baseBlocks
    let finalContentHtml = baseContentHtml;
    let finalBlocks = [...baseBlocks];

    // 只有普通推文需要额外处理主图片的插入
    if (!isXArticle && mainImages.length > 0) {
        // 将主推文图片添加到 contentHtml 和 blocks 中（在文本内容之后、引用帖内容之前）
        const mainImageHtmlParts: string[] = [];
        const mainImageBlocks: ContentBlock[] = [];

        mainImages.forEach((img) => {
            // Use real alt text if available and meaningful, otherwise empty string
            const rawAlt = (img.alt || '').trim();
            // Filter out generic placeholders
            const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                rawAlt === 'null' || rawAlt === 'undefined';
            const altText = (rawAlt && !isGeneric) ? rawAlt : '';

            const imgBlock: ContentBlock = {
                id: generateId(),
                type: 'image',
                html: `<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`,
                text: altText,
            };
            mainImageBlocks.push(imgBlock);
            mainImageHtmlParts.push(`<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`);
        });

        // 查找引用帖分隔符的位置（引用文章链接）
        const quoteStartIndex = baseContentHtml.indexOf('<p>🔗 引用文章：');

        if (quoteStartIndex > 0) {
            // 在引用帖之前插入主推文图片
            finalContentHtml = baseContentHtml.substring(0, quoteStartIndex) +
                mainImageHtmlParts.join('') +
                baseContentHtml.substring(quoteStartIndex);
        } else {
            // 没有引用帖，直接追加到末尾
            finalContentHtml = baseContentHtml + mainImageHtmlParts.join('');
        }

        // 在 blocks 中也需要类似的插入逻辑
        const quoteBlockIndex = baseBlocks.findIndex((b) =>
            b.type === 'paragraph' &&
            b.text?.includes('🔗 引用文章：')
        );

        if (quoteBlockIndex > 0) {
            // 在引用帖之前插入主推文图片
            finalBlocks = [
                ...baseBlocks.slice(0, quoteBlockIndex),
                ...mainImageBlocks,
                ...baseBlocks.slice(quoteBlockIndex)
            ];
        } else {
            // 没有引用帖，直接追加到末尾
            finalBlocks = [...baseBlocks, ...mainImageBlocks];
        }
    }

    const wordCount = textContent.length;

    // 如果标题使用了正文前30字，从正文中去除这部分避免重复
    if (contentStart && finalBlocks.length > 0) {
        const firstBlock = finalBlocks[0];
        const firstLine = getFirstNonEmptyLine(firstBlock.text);

        if (firstLine.startsWith(contentStart) && firstBlock.text.includes('\n')) {
            finalBlocks.shift();
            if (finalBlocks[0]?.text === '') {
                finalBlocks.shift();
            }
            console.log(`[twitterExtractor] ✂️ 从正文中移除与标题重复的首个双语段: "${contentStart}"`);
        } else if (firstBlock.text.startsWith(contentStart)) {
            // 从第一个块中移除标题文本
            const newText = firstBlock.text.substring(contentStart.length).trim();
            if (newText) {
                finalBlocks[0] = {
                    ...firstBlock,
                    text: newText,
                    html: `<p>${newText}</p>`,
                };
            } else {
                // 如果移除后为空，删除这个块
                finalBlocks.shift();
            }
            console.log(`[twitterExtractor] ✂️ 从正文中去除标题文本: "${contentStart}"`);
        }
    }

    console.log(`[twitterExtractor] ✅ 提取完成: ${wordCount} 字, ${images.length} 张图片`);

    return {
        title: title,
        sourceUrl: url,
        domain,
        author: extractAuthor(),
        publishTime: extractPublishTime(),
        contentHtml: finalContentHtml,
        blocks: finalBlocks,
        images,
        wordCount,
    };
}

/**
 * 提取页面标题（带元数据）
 * 使用格式：「作者名：正文前 30 字」
 * 对于 X Article，优先使用文章标题
 * 
 * @returns { title: 最终标题, contentStart: 返回用于去重的原始文本（不截断） }
 */
function extractTitleWithMeta(container: HTMLElement, isXArticle: boolean): { title: string; contentStart?: string } {
    // 尝试从主推文提取作者名
    const authorElement = container.querySelector('[data-testid="User-Name"]') ||
        document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="User-Name"]');
    let authorName = '';
    if (authorElement) {
        // 取第一个 span 作为显示名
        const nameSpan = authorElement.querySelector('span');
        if (nameSpan) {
            authorName = nameSpan.textContent?.trim() || '';
        }
    }

    const draftBlocks = document.querySelectorAll('.public-DraftStyleDefault-block');
    let contentPreview = '';
    let rawContentStart = ''; // 新增：用于去重的原始文本

    if (isXArticle) {
        console.log('[twitterExtractor] 📄 提取 X Article 标题...');

        const firstSegmentText = getFirstXArticleSegmentText();

        // 策略 1：优先使用页面标题 (document.title)
        let pageTitle = document.title;
        console.log(`[twitterExtractor] 📄 原始页面标题: "${pageTitle}"`);

        // 清理常用后缀和前缀
        pageTitle = pageTitle.replace(/\s*\/\s*(X|Twitter)$/i, ''); // " / X"
        pageTitle = pageTitle.replace(/\s+on\s+(X|Twitter)$/i, ''); // " on X"
        pageTitle = pageTitle.replace(/^\(\d+\+?\)\s*/, '');  // "(1) " 通知数
        pageTitle = pageTitle.trim();
        pageTitle = pageTitle.replace(/^[""]|[""]$/g, ''); // 移除首尾引号

        // 排除通用标题
        const genericTitles = ['X', 'Twitter', 'Home', 'Notification', 'Search', 'Profile'];
        if (pageTitle && !genericTitles.includes(pageTitle) && pageTitle.length > 2) {
            contentPreview = pageTitle;
            rawContentStart = pageTitle; // 假设页面标题就是正文第一行
            console.log(`[twitterExtractor] 📄 策略1-清洗后的页面标题: "${contentPreview}"`);
        }

        // 页面标题若是中英文直接拼接，优先使用正文首个真实段落作为标题
        if (firstSegmentText && pageTitle && pageTitle.includes(firstSegmentText) && pageTitle !== firstSegmentText) {
            contentPreview = firstSegmentText;
            rawContentStart = firstSegmentText;
            console.log(`[twitterExtractor] 📄 策略1b-使用首个正文子段替代拼接标题: "${contentPreview}"`);
        }

        // 策略 2：如果页面标题不可用，查找 H1 或 Heading
        if (!contentPreview) {
            const headingObj = container.querySelector('h1') || container.querySelector('[role="heading"]');
            if (headingObj) {
                const headingText = headingObj.textContent?.trim();
                if (headingText && headingText.length > 2 && !headingText.includes('Timeline')) {
                    contentPreview = headingText;
                    rawContentStart = headingText;
                    console.log(`[twitterExtractor] 📄 策略2-语义化标题: "${contentPreview}"`);
                }
            }
        }

        // 策略 3：如果还没找到，从正文区域提取
        if (!contentPreview && draftBlocks.length > 0) {
            for (let i = 0; i < Math.min(3, draftBlocks.length); i++) {
                const block = draftBlocks[i] as HTMLElement;
                const text = getFirstXArticleSegmentText() || block.innerText?.trim() || '';

                if (text && text.length > 2) {
                    contentPreview = text;
                    rawContentStart = text; // 这种情况下这一段必定是正文开头
                    console.log(`[twitterExtractor] 📄 策略3-首个正文块: "${contentPreview}"`);
                    break;
                }
            }
        }
    } else {
        // 普通推文：取第一行作为标题
        const mainTweetText = document.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"] [data-testid="tweetText"]');
        if (mainTweetText) {
            const fullText = mainTweetText.textContent?.trim() || '';
            // 取第一行（按换行符分割）
            const firstLine = fullText.split('\n')[0].trim();
            // 如果第一行太长，截取前 50 字用于显示
            contentPreview = firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine;
            // 去重必须用完整的第一行
            rawContentStart = firstLine;

            if (contentPreview) {
                console.log(`[twitterExtractor] 📝 普通推文，使用第一行: "${contentPreview}" (raw length: ${rawContentStart.length})`);
            }
        }
    }

    if (contentPreview) {
        return { title: contentPreview, contentStart: rawContentStart };
    } else if (authorName) {
        return { title: `${authorName} 的推文` };
    }

    // Fallback: 使用原始页面标题
    let title = document.title;
    title = title.replace(/^\(\d+\)\s*/, '');
    title = title.replace(/\s+on X:\s*/, ': ');
    title = title.replace(/\s*\/\s*X$/, '');
    title = title.replace(/^[""]|[""]$/g, '');
    return { title: title.trim() || '推文' };
}

/**
 * 查找容器内所有 Quote Tweet 容器
 * 
 * 支持多种形式：
 * 1. [data-testid="quoteTweet"] - 标准 Quote Tweet
 * 2. 嵌套的 article[data-testid="tweet"] - 长文章中的嵌入推文
 * 3. div[role="link"] 且内部包含 tweetText - 某些标准推文页面的引用
 * 4. 通过边框样式识别的引用容器
 */
function findQuoteTweetContainers(container: HTMLElement): HTMLElement[] {
    const containers: HTMLElement[] = [];
    console.log(`[twitterExtractor] 🔍 开始查找 Quote Tweet 容器...`);

    const mainTweet = container.querySelector('[data-testid="tweet"]');
    if (!mainTweet) {
        console.log(`[twitterExtractor] ⚠️ 未找到 mainTweet，无法进行基于主推文的排除`);
    }

    // 辅助：主推文的文本节点，用于防误判
    const mainTweetFirstText = mainTweet ? mainTweet.querySelector('[data-testid="tweetText"]') : null;

    // --- 方式 1：标准 Quote Tweet ---
    const quoteTweets = container.querySelectorAll('[data-testid="quoteTweet"]');
    console.log(`[twitterExtractor] 方式1 [data-testid="quoteTweet"]: 找到 ${quoteTweets.length} 个`);
    quoteTweets.forEach((el) => containers.push(el as HTMLElement));

    if (mainTweet) {
        // --- 方式 2：嵌套的 article ---
        const nestedTweets = mainTweet.querySelectorAll('article[data-testid="tweet"]');
        console.log(`[twitterExtractor] 方式2 嵌套 article: 找到 ${nestedTweets.length} 个`);
        nestedTweets.forEach((el) => {
            if (!containers.includes(el as HTMLElement)) containers.push(el as HTMLElement);
        });

        // --- 方式 3 & 4：div[role="link"] & Card Wrapper ---
        const candidates = Array.from(mainTweet.querySelectorAll('div[role="link"], [data-testid="card.wrapper"]'));
        console.log(`[twitterExtractor] 方式3/4/5 候选容器: ${candidates.length} 个`);

        let matchCount = 0;
        candidates.forEach((el, idx) => {
            if (containers.includes(el as HTMLElement)) return;

            // 排除包含主推文文本的容器
            if (mainTweetFirstText && el.contains(mainTweetFirstText)) {
                // console.log(`[twitterExtractor] 候选 #${idx} 跳过: 包含主推文文本`);
                return;
            }

            // 排除过于简单的按钮链接
            if (el.tagName === 'DIV' && el.getAttribute('role') === 'link' && el.innerHTML.length < 50) {
                // console.log(`[twitterExtractor] 候选 #${idx} 跳过: 内容过短`);
                return;
            }

            const hasQuoteText = el.querySelector('[data-testid="tweetText"]');
            const hasTime = el.querySelector('time');
            const hasUserName = el.querySelector('[data-testid="User-Name"]');
            const hasImage = el.querySelector('img');
            const hasCardWrapper = el.getAttribute('data-testid') === 'card.wrapper' || el.querySelector('[data-testid="card.wrapper"]');

            // 链接检查：支持 status, article, events 等
            const hasLink = el.querySelector('a[href*="/status/"]') ||
                el.querySelector('a[href*="/article/"]') ||
                el.querySelector('a[href*="/events/"]') ||
                el.querySelector('a[href*="/i/"]'); // 很多内部链接是 /i/ 开头

            // 综合判断逻辑
            let isMatch = false;
            let matchType = '';

            if (hasQuoteText && (hasTime || hasUserName)) {
                isMatch = true;
                matchType = '标准引用';
            } else if (hasCardWrapper) {
                isMatch = true;
                matchType = '卡片Wrapper';
            } else if (hasImage && hasLink) {
                isMatch = true;
                matchType = '图片+链接卡片';
            } else if (hasImage && (el as HTMLElement).innerText.length > 5 && (el.getAttribute('role') === 'link' || el.closest('[data-testid="card.wrapper"]'))) {
                // 只有图片和文字，且本身是链接
                isMatch = true;
                matchType = '图片+文字链接';
            } else if (el.getAttribute('role') === 'link' && hasImage && (el as HTMLElement).innerText.length > 20) {
                // 方式6：文章封面卡片 - role="link" 但无 data-testid，有图片和较长文本
                // 特征：包含 article-cover-image 或带有摘要文字的卡片
                const hasArticleCover = el.querySelector('[data-testid*="cover"], [class*="cover"], img[alt*="Cover"]') ||
                    (el.querySelector('img') && (el as HTMLElement).innerText.includes('文章'));
                if (hasArticleCover || (el as HTMLElement).innerText.length > 50) {
                    isMatch = true;
                    matchType = '文章封面卡片';
                }
            }

            if (isMatch) {
                containers.push(el as HTMLElement);
                matchCount++;
                console.log(`[twitterExtractor] ✅ 候选 #${idx} 匹配成功 (${matchType}): ${el.tagName}.${el.className.substring(0, 20)}...`);
            } else {
                console.log(`[twitterExtractor] ❌ 候选 #${idx} 不匹配: hasQuoteText=${!!hasQuoteText}, hasCard=${!!hasCardWrapper}, hasImg=${!!hasImage}, hasLink=${!!hasLink}`);
            }
        });
        console.log(`[twitterExtractor] 方式3/4/5 最终匹配: ${matchCount} 个`);
    }

    console.log(`[twitterExtractor] 🔍 总共找到 ${containers.length} 个 Quote Tweet 容器`);
    return containers;
}

/**
 * 提取单个 Quote Tweet 的内容
 * (重命名为 extractQuotedTweet 以符合新规范)
 */
async function extractQuotedTweet(quoteContainer: HTMLElement): Promise<QuoteTweet | null> {
    // 0. 优先检查 DOM 属性缓存（最稳定，不受 innerText 变化影响）
    const savedUrl = quoteContainer.getAttribute('data-mowen-saved-url');

    // 检查缓存：避免在多次稳定性检测提取中重复调用 pageContextHelper
    const cacheKey = getContainerCacheKey(quoteContainer);
    const cachedUrl = quoteUrlCache.get(cacheKey);

    // 提取原推文链接 (优先级: DOM属性 > 内存缓存 > 重新提取)
    let fullUrl = savedUrl || cachedUrl || '';

    // 1. 泛化链接查找：查找任何看起来像内容链接的 href
    const potentialLinks = quoteContainer.querySelectorAll('a[href]');
    for (const link of potentialLinks) {
        const href = link.getAttribute('href');
        if (href && (
            href.includes('/status/') ||
            href.includes('/article/') ||
            href.includes('/events/') ||
            href.includes('/i/')
        )) {
            if (!href.includes('/photo/') && !href.includes('/video/') && !href.includes('/people/')) {
                fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
                break;
            }
        }
    }

    // 2. 尝试 container 自身的链接 (div[role="link"])
    if (!fullUrl) {
        const roleLink = quoteContainer.closest('div[role="link"]') ||
            quoteContainer.closest('a') ||
            quoteContainer.closest('[data-testid="card.wrapper"]');

        if (roleLink) {
            const containerHref = roleLink.getAttribute('href');
            if (containerHref && containerHref.length > 5) {
                fullUrl = containerHref.startsWith('http') ? containerHref : `https://x.com${containerHref}`;
            } else if (!containerHref) {
                // 如果 wrapper 自身没 href，找它里面的第一个有效链接
                const innerLink = roleLink.querySelector('a[href*="/status/"], a[href*="/article/"]');
                if (innerLink) {
                    const href = innerLink.getAttribute('href');
                    if (href) fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
                }
            }
        }
    }

    // 3. 扫描容器内所有元素的属性
    if (!fullUrl) {
        const allElements = quoteContainer.querySelectorAll('*');
        for (const el of Array.from(allElements)) {
            const attrs = ['data-url', 'data-permalink-path', 'href'];
            for (const attr of attrs) {
                const val = el.getAttribute(attr);
                if (val && (val.includes('/status/') || val.includes('/article/'))) {
                    fullUrl = val.startsWith('http') ? val : `https://x.com${val}`;
                    break;
                }
            }
            if (fullUrl) break;
        }
    }

    // 4. 尝试从 React Fiber/Props 提取（注意：Content Script 可能无法访问）
    if (!fullUrl) {
        try {
            let targetEl: Element | null = quoteContainer;
            let depth = 0;
            while (targetEl && depth < 5) {
                const props = getReactProps(targetEl);
                if (props) {
                    const reactData = findTweetDataInProps(props);
                    if (reactData) {
                        if (reactData.canonical_url) {
                            fullUrl = reactData.canonical_url;
                        } else if (reactData.id) {
                            const isArticle = reactData.__typename === 'Article' ||
                                (quoteContainer.innerText || '').includes('Article');
                            fullUrl = isArticle
                                ? `https://x.com/i/article/${reactData.id}`
                                : `https://x.com/i/status/${reactData.id}`;
                        }
                        if (fullUrl) break;
                    }
                }
                targetEl = targetEl.parentElement;
                depth++;
            }
        } catch (e) {
            // React 提取失败，继续
            void e;
        }
    }

    // 5. 终极方案：通过注入的 pageContextHelper.js 在页面主世界提取
    if (!fullUrl) {
        try {
            const urlFromPageContext = await extractUrlViaPageContext(quoteContainer);
            if (urlFromPageContext) {
                fullUrl = urlFromPageContext;
                console.log('[twitterExtractor] 🎯 通过 pageContextHelper 成功提取 URL:', fullUrl);
            }
        } catch (e) {
            // pageContextHelper 提取失败，继续
            void e;
        }
    }

    // 如果以上方法都失败，标记为未知链接
    if (!fullUrl) {
        console.log('[twitterExtractor] ⚠️ 未找到引用推文原始链接');
        fullUrl = '(未知链接)';
    } else {
        // 成功提取：保存到 DOM 属性和内存缓存
        if (!savedUrl) {
            quoteContainer.setAttribute('data-mowen-saved-url', fullUrl);
        }
        if (!cachedUrl) {
            quoteUrlCache.set(cacheKey, fullUrl);
            console.log(`[twitterExtractor] 📝 缓存 Quote URL: ${cacheKey} -> ${fullUrl}`);
        }
    }

    // 提取文本
    const textEl = quoteContainer.querySelector('[data-testid="tweetText"]');
    let text = '';
    let html = '';

    if (textEl) {
        text = (textEl as HTMLElement).innerText || textEl.textContent || '';
        html = cleanTwitterHtml((textEl as HTMLElement).innerHTML);
    }

    // 策略：通用文本提取 (如果找不到标准 tweetText)
    if (!text.trim()) {
        const clonedContainer = quoteContainer.cloneNode(true) as HTMLElement;
        const toRemove = clonedContainer.querySelectorAll(
            '[data-testid="User-Name"], time, [role="button"], svg, ' +
            '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"]' // 排除操作按钮
        );
        toRemove.forEach(el => el.remove());

        text = clonedContainer.innerText?.trim() || '';
        // 简单清理
        text = text.replace(/^文章\n?/gm, '').replace(/^Article\n?/gm, '').trim();
        html = `<p>${text.split('\n').join('</p><p>')}</p>`;
    }

    // 最终检查
    if (!text.trim()) {
        if (fullUrl) {
            text = `（引用推文内容请查看原文）`;
            html = text;
        } else {
            // 只要有图片，也算有效引用
            const hasImages = quoteContainer.querySelector('img');
            if (hasImages) {
                text = `（引用内容为图片）`;
                html = text;
            } else {
                // 没有URL，没有文字，没有图片 -> 放弃
                return null;
            }
        }
    }

    // 提取图片
    const images = extractQuoteTweetImages(quoteContainer);

    console.log(`[twitterExtractor] 🔍 Quote Tweet 提取结果: url=${fullUrl}, textLen=${text.length}, images=${images.length}`);

    return {
        url: fullUrl || '(未知链接)',
        linkLabel: getQuoteLinkLabel(fullUrl || '(未知链接)', text.trim()),
        text: text.trim(),
        html,
        images,
    };
}

/**
 * 清理 Twitter HTML，移除复杂样式只保留纯文本结构
 */
function cleanTwitterHtml(html: string): string {
    // 移除所有 class 属性（Twitter 的样式类非常复杂）
    let cleaned = html.replace(/\s*class="[^"]*"/gi, '');

    // 移除所有 style 属性
    cleaned = cleaned.replace(/\s*style="[^"]*"/gi, '');

    // 移除 data-* 属性
    cleaned = cleaned.replace(/\s*data-[a-z-]+="[^"]*"/gi, '');

    // 移除 dir 属性
    cleaned = cleaned.replace(/\s*dir="[^"]*"/gi, '');

    // 移除 lang 属性
    cleaned = cleaned.replace(/\s*lang="[^"]*"/gi, '');

    // 将多余的 span 标签简化（保留文本内容）
    // <span>text</span> -> text（如果 span 没有其他作用）
    cleaned = cleaned.replace(/<span>([^<]*)<\/span>/gi, '$1');

    // 去掉 HTML 源码中的无意义换行（真正的换行已通过 <br> DOM 元素表示）
    cleaned = cleaned.replace(/\n+/g, '');

    return cleaned.trim();
}

/**
 * 将普通推文 tweetText 元素按换行拆分为多个独立段落
 *
 * Twitter 的 tweetText 中，作者的换行通过 DOM 中的 <br> 元素表示。
 * 此函数将内容按 <br> 拆分为独立行，并对纯文本段落做中英文混合二次拆分。
 */
function splitTweetTextIntoSegments(element: HTMLElement): TweetTextSegment[] {
    const fullText = (element.innerText || element.textContent || '').trim();

    if (!fullText) return [];

    const paragraphTexts = splitTweetTextParagraphs(fullText);
    if (paragraphTexts.length > 1) {
        return paragraphTexts.map((paragraphText) => ({
            html: escapeHtml(paragraphText),
            text: paragraphText,
        }));
    }

    const rawHtml = element.innerHTML;
    // 清理 HTML（保留链接等语义标签和 <br>，移除样式类）
    const cleanedHtml = cleanTwitterHtml(rawHtml);

    // 复用已有的按 <br> 拆分逻辑
    const htmlSegments = splitXArticleInlineSegments(cleanedHtml);

    if (htmlSegments.length <= 1) {
        // 单段：检查是否包含中英文混合需要拆分
        const hasInlineMarkup = /<(a|strong|em|code)\b/i.test(cleanedHtml);
        if (!hasInlineMarkup) {
            const mixedParts = splitMixedLanguageText(fullText);
            if (mixedParts.length > 1) {
                return mixedParts.map(part => ({
                    html: escapeHtml(part),
                    text: part,
                }));
            }
        }
        return [{ html: cleanedHtml, text: fullText }];
    }

    // 多段：对每段检查中英文混合（仅纯文本段落）
    const result: Array<{ html: string; text: string }> = [];
    for (const seg of htmlSegments) {
        const segText = seg.text.trim();
        if (!segText) continue;

        // 含内联标签的段落不做中英文拆分（避免破坏链接结构）
        const hasInlineMarkup = /<(a|strong|em|code)\b/i.test(seg.html);
        if (!hasInlineMarkup) {
            const mixedParts = splitMixedLanguageText(segText);
            if (mixedParts.length > 1) {
                mixedParts.forEach(part => {
                    result.push({ html: escapeHtml(part), text: part });
                });
                continue;
            }
        }
        result.push(seg);
    }

    return result;
}

function splitTweetTextParagraphs(text: string): string[] {
    return text
        .split(/\n\s*\n+/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
}

function getFirstNonEmptyLine(text: string): string {
    return text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
}

function getQuoteLinkLabel(url: string, text: string): string {
    const candidate = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) =>
            line &&
            line !== url &&
            line !== '（引用推文内容请查看原文）' &&
            line !== '（引用内容为图片）'
        );

    if (!candidate) {
        return url;
    }

    return candidate.length > 80 ? `${candidate.substring(0, 80).trim()}...` : candidate;
}

function extractVisibleTextLines(element: HTMLElement): string[] {
    return (element.innerText || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function getParagraphLanguageKind(text: string): 'english' | 'chinese' | 'other' {
    const normalized = text.trim();
    if (!normalized) {
        return 'other';
    }

    const hanCount = countHanCharacters(normalized);
    const latinWordCount = countLatinWords(normalized);

    if (hanCount >= 2 && (latinWordCount === 0 || hanCount >= latinWordCount || hanCount >= 6)) {
        return 'chinese';
    }

    if (
        latinWordCount >= 2 &&
        (hanCount === 0 || (hanCount <= 2 && /^[^\u4e00-\u9fff]*[A-Za-z]/.test(normalized)))
    ) {
        return 'english';
    }

    return 'other';
}

function getDominantParagraphLanguageKind(segments: Array<{ html: string; text: string }>): 'english' | 'chinese' | 'other' {
    let englishCount = 0;
    let chineseCount = 0;

    for (const segment of segments) {
        const kind = getParagraphLanguageKind(segment.text);
        if (kind === 'english') {
            englishCount += 1;
        } else if (kind === 'chinese') {
            chineseCount += 1;
        }
    }

    if (englishCount === 0 && chineseCount === 0) {
        return 'other';
    }

    return englishCount >= chineseCount ? 'english' : 'chinese';
}

function isTranslatedTweetParagraphPair(
    firstSegments: TweetTextSegment[],
    secondSegments: TweetTextSegment[]
): boolean {
    if (firstSegments.length === 0 || secondSegments.length === 0) {
        return false;
    }

    if (firstSegments.length !== secondSegments.length || firstSegments.length < 3) {
        return false;
    }

    const firstLanguage = getDominantParagraphLanguageKind(firstSegments);
    const secondLanguage = getDominantParagraphLanguageKind(secondSegments);

    if (firstLanguage === secondLanguage || firstLanguage === 'other' || secondLanguage === 'other') {
        return false;
    }

    const headingLikeMatches = firstSegments.filter((segment, index) => {
        const other = secondSegments[index];
        if (!other) {
            return false;
        }

        const firstText = segment.text.trim();
        const secondText = other.text.trim();
        if (!firstText || !secondText) {
            return false;
        }

        return (
            startsWithExplicitBlockMarker(firstText) === startsWithExplicitBlockMarker(secondText) ||
            looksLikeStandaloneHeading(firstText, getXArticleSegmentLanguageKind(firstText)) ||
            looksLikeStandaloneHeading(secondText, getXArticleSegmentLanguageKind(secondText))
        );
    }).length;

    return headingLikeMatches >= Math.min(3, firstSegments.length);
}

function buildBilingualTweetParagraphSegments(
    originalSegments: TweetTextSegment[],
    translatedSegments: TweetTextSegment[]
): TweetTextSegment[] {
    const originalLanguage = getDominantParagraphLanguageKind(originalSegments);
    const translatedLanguage = getDominantParagraphLanguageKind(translatedSegments);
    const englishFirst = originalLanguage === 'english' || translatedLanguage !== 'english';

    return originalSegments.map((segment, index) => {
        const translated = translatedSegments[index];
        const primary = englishFirst ? segment : translated;
        const secondary = englishFirst ? translated : segment;
        const text = secondary
            ? `${primary.text}\n${secondary.text}`
            : primary.text;

        const html = secondary
            ? `${escapeHtml(primary.text)}<br>${escapeHtml(secondary.text)}`
            : primary.html;

        return {
            html,
            text,
            textOnly: Boolean(secondary),
        };
    });
}

function countHanCharacters(text: string): number {
    return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

function countLatinWords(text: string): number {
    return (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length;
}

function trimMixedLanguageBoundary(text: string): string {
    return text
        .replace(/^[\s\u00a0,，.。!！?？;；:：、\-–—>→()（）[\]【】"“”'‘’/]+/, '')
        .trim();
}

function startsWithLongEnglishPhrase(text: string): boolean {
    const normalized = trimMixedLanguageBoundary(text);
    if (!normalized || !/^[A-Za-z]/.test(normalized)) {
        return false;
    }

    const head = normalized.slice(0, 80);
    const firstWindow = head.slice(0, 24);
    if (countHanCharacters(firstWindow) > 0) {
        return false;
    }

    return countLatinWords(head) >= 3;
}

function startsWithLongHanPhrase(text: string): boolean {
    const normalized = trimMixedLanguageBoundary(text);
    if (!normalized) {
        return false;
    }

    const head = normalized.slice(0, 40);
    return countHanCharacters(head) >= 6 && countLatinWords(head.slice(0, 24)) <= 1;
}

function findPreviousScriptCharacter(text: string, startIndex: number): { index: number; char: string } | null {
    for (let index = startIndex; index >= 0; index--) {
        const char = text[index];
        if (/[\u4e00-\u9fffA-Za-z]/.test(char)) {
            return { index, char };
        }
    }

    return null;
}

function findNextScriptCharacter(text: string, startIndex: number): { index: number; char: string } | null {
    for (let index = startIndex; index < text.length; index++) {
        const char = text[index];
        if (/[\u4e00-\u9fffA-Za-z]/.test(char)) {
            return { index, char };
        }
    }

    return null;
}

function findMixedLanguageSplitIndex(text: string): number {
    for (let cursor = 1; cursor < text.length; cursor++) {
        const left = findPreviousScriptCharacter(text, cursor - 1);
        const right = findNextScriptCharacter(text, cursor);

        if (!left || !right || left.index >= right.index) {
            continue;
        }

        const between = text.slice(left.index + 1, right.index);
        if (between && !/^[\s\u00a0,，.。!！?？;；:：、\-–—>→()（）[\]【】"“”'‘’/]+$/.test(between)) {
            continue;
        }

        const markerMatch = between.match(/[>→\-–—]/);
        const splitIndex = markerMatch
            ? left.index + 1 + (markerMatch.index ?? 0)
            : right.index;

        const prefix = text.slice(0, right.index);
        const suffix = text.slice(right.index);
        const leftIsHan = /[\u4e00-\u9fff]/.test(left.char);
        const rightIsHan = /[\u4e00-\u9fff]/.test(right.char);
        const leftIsLatin = /[A-Za-z]/.test(left.char);
        const rightIsLatin = /[A-Za-z]/.test(right.char);

        if (leftIsHan && rightIsLatin) {
            // prefix 必须以中文为主（以中文开头），才算「中文段落 + 英文段落」可拆分
            // 避免英文句子中嵌入少量中文被误拆
            if (startsWithLongHanPhrase(prefix) && startsWithLongEnglishPhrase(suffix)) {
                return splitIndex;
            }
        } else if (leftIsLatin && rightIsHan) {
            // prefix 必须以英文为主（以英文开头），才算「英文段落 + 中文段落」可拆分
            // 避免中文句子中嵌入英文专有名词（如 Claude Code）后被误拆
            if (startsWithLongEnglishPhrase(prefix) && startsWithLongHanPhrase(suffix)) {
                return splitIndex;
            }
        }

        cursor = right.index;
    }

    return -1;
}

function splitMixedLanguageText(text: string): string[] {
    const normalizedText = text.trim();
    if (!normalizedText || countHanCharacters(normalizedText) === 0 || countLatinWords(normalizedText) === 0) {
        return normalizedText ? [normalizedText] : [];
    }

    const parts: string[] = [];
    let remaining = normalizedText;

    for (let round = 0; round < 6; round++) {
        const splitIndex = findMixedLanguageSplitIndex(remaining);
        if (splitIndex <= 0 || splitIndex >= remaining.length) {
            break;
        }

        const left = remaining.slice(0, splitIndex).trim();
        const right = remaining.slice(splitIndex).trim();
        if (!left || !right) {
            break;
        }

        parts.push(left);
        remaining = right;
    }

    parts.push(remaining);
    return parts.filter(Boolean);
}

type XArticleSegmentLanguageKind = 'english' | 'chinese' | 'other';

function getXArticleSegmentLanguageKind(text: string): XArticleSegmentLanguageKind {
    const normalized = text.trim();
    if (!normalized) {
        return 'other';
    }

    const hanCount = countHanCharacters(normalized);
    const latinWordCount = countLatinWords(normalized);

    if (hanCount >= 2 && (latinWordCount === 0 || hanCount >= latinWordCount || hanCount >= 6)) {
        return 'chinese';
    }

    if (
        latinWordCount >= 2 &&
        (hanCount === 0 || (hanCount <= 2 && /^[^\u4e00-\u9fff]*[A-Za-z]/.test(normalized)))
    ) {
        return 'english';
    }

    return 'other';
}

function endsWithHardParagraphBoundary(text: string): boolean {
    return /[。！？!?；;:：]$/.test(text.trim());
}

function startsWithExplicitBlockMarker(text: string): boolean {
    return /^([→➜•\-–—*]|\d+\.)\s*/.test(text.trim());
}

function looksLikeStandaloneHeading(text: string, kind: XArticleSegmentLanguageKind): boolean {
    const normalized = text.trim();
    if (!normalized || endsWithHardParagraphBoundary(normalized)) {
        return false;
    }

    if (kind === 'english') {
        const words = countLatinWords(normalized);
        return words > 0 && words <= 8 && /^[A-Z0-9]/.test(normalized);
    }

    if (kind === 'chinese') {
        const hanCount = countHanCharacters(normalized);
        return hanCount > 0 && hanCount <= 10 && !/[，,]/.test(normalized);
    }

    return false;
}

function getSegmentJoiner(left: string, right: string, kind: XArticleSegmentLanguageKind): string {
    const leftTrimmed = left.trimEnd();
    const rightTrimmed = right.trimStart();
    if (!leftTrimmed || !rightTrimmed) {
        return '';
    }

    const leftLast = leftTrimmed[leftTrimmed.length - 1];
    const rightFirst = rightTrimmed[0];
    const leftIsLatin = /[A-Za-z0-9]/.test(leftLast);
    const rightIsLatin = /[A-Za-z0-9]/.test(rightFirst);
    const leftIsHan = /[\u4e00-\u9fff]/.test(leftLast);
    const rightIsHan = /[\u4e00-\u9fff]/.test(rightFirst);

    if (leftIsLatin && rightIsLatin) {
        return ' ';
    }

    if (kind === 'english' && !/\s$/.test(leftTrimmed) && !/^\s/.test(rightTrimmed)) {
        return ' ';
    }

    if (leftIsHan || rightIsHan) {
        return '';
    }

    return '';
}

function mergeXArticleContinuationSegments(segments: Array<{ html: string; text: string }>): Array<{ html: string; text: string }> {
    const merged: Array<{ html: string; text: string }> = [];

    for (const segment of segments) {
        const currentText = segment.text.trim();
        const currentHtml = segment.html.trim();

        if (!currentText || !currentHtml) {
            continue;
        }

        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push({ html: currentHtml, text: currentText });
            continue;
        }

        const previousKind = getXArticleSegmentLanguageKind(previous.text);
        const currentKind = getXArticleSegmentLanguageKind(currentText);
        const sameLanguage = previousKind !== 'other' && previousKind === currentKind;

        if (
            sameLanguage &&
            !endsWithHardParagraphBoundary(previous.text) &&
            !startsWithExplicitBlockMarker(currentText) &&
            !looksLikeStandaloneHeading(previous.text, previousKind)
        ) {
            const joiner = getSegmentJoiner(previous.text, currentText, previousKind);
            previous.text = `${previous.text.trimEnd()}${joiner}${currentText.trimStart()}`;
            previous.html = `${previous.html}${joiner ? escapeHtml(joiner) : ''}${currentHtml}`;
            continue;
        }

        merged.push({ html: currentHtml, text: currentText });
    }

    return merged;
}

function refineXArticleParagraphSegments(segments: Array<{ html: string; text: string }>): Array<{ html: string; text: string }> {
    const refined = segments.flatMap((segment) => {
        const text = segment.text.trim();
        const html = segment.html.trim();

        if (!text || !html) {
            return [];
        }

        if (html.includes('<br') && !/<(a|strong|em|code)\b/i.test(html)) {
            return splitNestedBrTextSegments(html);
        }

        if (html.includes('<br') || /<(a|strong|em|code)\b/i.test(html)) {
            return [{ html, text }];
        }

        const splitParts = splitMixedLanguageText(text);
        if (splitParts.length <= 1) {
            return [{ html, text }];
        }

        return splitParts.map((part) => ({
            html: escapeHtml(part),
            text: part,
        }));
    });

    return mergeXArticleContinuationSegments(refined);
}

/**
 * Draft.js 有时会把同一段里的文本包成多层容器，flatten 后会留下嵌套 <br>。
 * 这里先按文本行拆开，再交给 continuation merge 重新合并，避免把视觉换行误存成真实段落。
 */
function splitNestedBrTextSegments(html: string): Array<{ html: string; text: string }> {
    const container = document.createElement('div');
    container.innerHTML = html;

    const textLines = (container.innerText || container.textContent || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (textLines.length === 0) {
        return [];
    }

    return textLines.map((line) => ({
        html: escapeHtml(line),
        text: line,
    }));
}

function extractXArticleParagraphSegments(element: HTMLElement): Array<{ html: string; text: string }> {
    const visibleLines = extractVisibleTextLines(element);
    const directChildDivs = Array.from(element.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'DIV')
        .filter((child) => !!child.innerText?.trim());

    if (directChildDivs.length > 1) {
        const structuralSegments = refineXArticleParagraphSegments(directChildDivs
            .map((child) => {
                const html = normalizeXArticleInlineHtml(child);
                const text = child.innerText?.trim() || '';
                return { html, text };
            })
            .filter((segment) => !!segment.html && !!segment.text));

        return structuralSegments;
    }

    const html = normalizeXArticleInlineHtml(element);
    const segments = refineXArticleParagraphSegments(splitXArticleInlineSegments(html));
    if (segments.length > 0) {
        return segments;
    }

    if (visibleLines.length > 1) {
        return refineXArticleParagraphSegments(visibleLines.map((line) => ({
            html: escapeHtml(line),
            text: line,
        })));
    }

    const text = element.innerText?.trim() || '';
    return html && text ? refineXArticleParagraphSegments([{ html, text }]) : [];
}

function splitXArticleInlineSegments(html: string): Array<{ html: string; text: string }> {
    const container = document.createElement('div');
    container.innerHTML = html;

    const segments: Array<{ html: string; text: string }> = [];
    let currentNodes: Node[] = [];

    const flushSegment = () => {
        if (currentNodes.length === 0) {
            return;
        }

        const segmentContainer = document.createElement('div');
        currentNodes.forEach((node) => segmentContainer.appendChild(node));

        const segmentHtml = segmentContainer.innerHTML.trim();
        const segmentText = (segmentContainer.innerText || segmentContainer.textContent || '').trim();

        if (segmentHtml && segmentText) {
            segments.push({
                html: segmentHtml,
                text: segmentText,
            });
        }

        currentNodes = [];
    };

    Array.from(container.childNodes).forEach((node) => {
        if (node.nodeName === 'BR') {
            flushSegment();
            return;
        }

        currentNodes.push(node.cloneNode(true));
    });

    flushSegment();

    return segments;
}

function getFirstXArticleSegmentText(): string {
    const draftBlocks = Array.from(document.querySelectorAll('.public-DraftStyleDefault-block'))
        .filter((block): block is HTMLElement => block instanceof HTMLElement);

    for (const block of draftBlocks) {
        const segments = extractXArticleParagraphSegments(block);
        const firstText = segments.find((segment) => !!segment.text)?.text;
        if (firstText) {
            return firstText;
        }
    }

    return '';
}

/**
 * 提取 Quote Tweet 中的图片
 */
function extractQuoteTweetImages(quoteContainer: HTMLElement): ImageCandidate[] {
    const images: ImageCandidate[] = [];
    let order = 0;
    const seenUrls = new Set<string>();

    // 查找媒体图片（标准推文图片）
    const photoElements = quoteContainer.querySelectorAll('[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img');

    photoElements.forEach((img) => {
        const imgEl = img as HTMLImageElement;
        const src = imgEl.src || imgEl.getAttribute('src') || '';

        if (src && !src.includes('profile_images') && !src.includes('emoji') && !seenUrls.has(src)) {
            seenUrls.add(src);
            const normalizedUrl = normalizeImageUrl(src);
            images.push({
                id: generateId(),
                url: src,
                normalizedUrl,
                kind: 'img',
                order: order++,
                inMainContent: true,
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
                alt: imgEl.alt || '',
            });
        }
    });

    // 备选：提取所有图片（用于 X Article 封面等没有标准 data-testid 的情况）
    if (images.length === 0) {
        const allImages = quoteContainer.querySelectorAll('img');
        allImages.forEach((img) => {
            const imgEl = img as HTMLImageElement;
            const src = imgEl.src || imgEl.getAttribute('src') || '';

            if (!src || seenUrls.has(src)) return;

            // 排除已知的非内容图片
            if (src.includes('profile_images') ||
                src.includes('emoji') ||
                src.includes('twemoji') ||
                src.includes('hashflags') ||
                src.includes('abs.twimg.com') ||  // 广告相关
                src.startsWith('data:')) {
                return;
            }

            // 获取图片尺寸（优先使用 naturalWidth/Height）
            const imgWidth = imgEl.naturalWidth || imgEl.width || 0;
            const imgHeight = imgEl.naturalHeight || imgEl.height || 0;

            // 条件：
            // 1. 尺寸已知且足够大（>100）
            // 2. 或者是 pbs.twimg.com 的媒体图片（即使尺寸未加载完成）
            const isTwimgMedia = src.includes('pbs.twimg.com/media/');
            const hasValidSize = imgWidth > 100 && imgHeight > 100;

            if (hasValidSize || isTwimgMedia) {
                seenUrls.add(src);
                const normalizedUrl = normalizeImageUrl(src);
                images.push({
                    id: generateId(),
                    url: src,
                    normalizedUrl,
                    kind: 'img',
                    order: order++,
                    inMainContent: true,
                    width: imgWidth,
                    height: imgHeight,
                    alt: imgEl.alt || '',
                });
                console.log(`[twitterExtractor] 📷 Quote 图片: ${imgWidth}x${imgHeight}, isTwimg=${isTwimgMedia}, src=${src.substring(0, 60)}`);
            }
        });
    }

    return images;
}

/**
 * 提取推文正文内容
 * 
 * 支持识别和提取 Quote Tweet，将其格式化为引用块
 */
async function extractTweetContent(container: HTMLElement, contentStart?: string): Promise<{
    contentHtml: string;
    blocks: ContentBlock[];
    textContent: string;
    quoteTweets: QuoteTweet[];
    quoteTweetContainers: HTMLElement[];
}> {
    // 1. 识别并提取所有 Quote Tweet
    const quoteTweetContainers = findQuoteTweetContainers(container);
    const quoteTweets: QuoteTweet[] = [];

    for (const quoteContainer of quoteTweetContainers) {
        const quoteTweet = await extractQuotedTweet(quoteContainer);
        if (quoteTweet) quoteTweets.push(quoteTweet);
    }

    // 2. 提取主推文文本
    const tweetArticles = container.querySelectorAll('[data-testid="tweet"]');
    if (tweetArticles.length === 0) {
        return { contentHtml: '', blocks: [], textContent: '', quoteTweets, quoteTweetContainers };
    }

    const mainTweetArticle = tweetArticles[0] as HTMLElement;
    const allTweetTextElements = mainTweetArticle.querySelectorAll(TWITTER_SELECTORS.tweetText);
    const mainTweetTextElements = Array.from(allTweetTextElements).filter((el) => {
        const isInsideQuote = quoteTweetContainers.some(c => c.contains(el));
        return !isInsideQuote;
    });

    // 3. 拼装主推文
    const contentParts: string[] = [];
    const blocks: ContentBlock[] = [];
    const textParts: string[] = [];
    const seenTexts = new Set<string>(); // 用于去重

    let isFirstBlock = true;
    const normalizationStart = contentStart ? normalizeText(contentStart) : '';

    for (let elementIndex = 0; elementIndex < mainTweetTextElements.length; elementIndex++) {
        const element = mainTweetTextElements[elementIndex] as HTMLElement;
        const fullText = (element.innerText || element.textContent || '').trim();

        if (!fullText) continue;

        // 按换行拆分为独立段落（修复换行丢失和中英文混合问题）
        let segments = splitTweetTextIntoSegments(element);
        if (segments.length === 0) continue;

        const nextElement = mainTweetTextElements[elementIndex + 1] as HTMLElement | undefined;
        const nextFullText = nextElement ? (nextElement.innerText || nextElement.textContent || '').trim() : '';
        if (nextElement && nextFullText) {
            const nextSegments = splitTweetTextIntoSegments(nextElement);
            if (isTranslatedTweetParagraphPair(segments, nextSegments)) {
                segments = buildBilingualTweetParagraphSegments(segments, nextSegments);
                elementIndex += 1;
            }
        }

        // --- 标题/正文去重 (归一化版本) ---
        if (isFirstBlock && normalizationStart) {
            const normalizedText = normalizeText(fullText);

            // 情况 1: 完全匹配 -> 保留
            if (normalizedText === normalizationStart) {
                console.log(`[twitterExtractor] ℹ️ 标题与正文首段完全一致，保留正文 (防止内容丢失): "${fullText.substring(0, 20)}..."`);
            }
            // 情况 2: 正文是标题的超集 -> 移除对应的首个 segment
            else if (normalizedText.startsWith(normalizationStart) && contentStart) {
                console.log(`[twitterExtractor] ✂️ 移除段落开头的标题前缀 (Normalized): "${contentStart.substring(0, 20)}..."`);
                const firstSeg = segments[0];
                const firstLine = getFirstNonEmptyLine(firstSeg.text);
                if (firstSeg.textOnly && firstLine.startsWith(contentStart)) {
                    console.log('[twitterExtractor] ✂️ 首段双语内容与标题重复，整段从正文中移除');
                    segments = segments.slice(1);
                } else if (firstSeg.text.startsWith(contentStart)) {
                    const newText = firstSeg.text.substring(contentStart.length).trim();
                    if (newText) {
                        segments[0] = {
                            ...firstSeg,
                            html: escapeHtml(newText),
                            text: newText,
                        };
                    } else {
                        segments = segments.slice(1);
                    }
                }
                if (segments.length === 0) {
                    isFirstBlock = false;
                    continue;
                }
            }
        }
        isFirstBlock = false;

        // 去重：用整体文本去重
        if (seenTexts.has(fullText)) continue;
        seenTexts.add(fullText);

        // 每个 segment 生成独立的 ContentBlock，并显式补回段落间空行。
        // X 的 tweetText 真实段落边界来自空行文本，而墨问里相邻 paragraph 默认间距较紧，
        // 因此这里插入一个空 paragraph 作为视觉分段，只作用于 Twitter/X 提取链路。
        segments.forEach((seg, segmentIndex) => {
            if (!seg.text.trim()) return;
            contentParts.push(`<div class="tweet-text">${seg.html}</div>`);
            textParts.push(seg.text);
            blocks.push({
                id: generateId(),
                type: 'paragraph',
                html: seg.textOnly ? '' : `<p>${seg.html}</p>`,
                text: seg.text,
            });

            if (segmentIndex < segments.length - 1) {
                contentParts.push(TWEET_PARAGRAPH_SPACER_HTML);
                blocks.push({
                    id: generateId(),
                    type: 'paragraph',
                    html: TWEET_PARAGRAPH_SPACER_HTML,
                    text: '',
                });
            }
        });
    }

    console.log(`[twitterExtractor] 📝 主推文提取: ${mainTweetTextElements.length} 个文本块, ${textParts.length} 个有效段落`);

    // 4. 拼装引用推文（严格遵循 Link -> Quote -> Images 顺序）
    quoteTweets.forEach((qt, qtIndex) => {
        // (1) 引用链接行
        const linkLabel = escapeHtml(qt.linkLabel || qt.url);
        const linkBlock: ContentBlock = {
            id: generateId(),
            type: 'paragraph',
            html: `<p>🔗 引用文章：<a href="${qt.url}">${linkLabel}</a></p>`,
            text: `🔗 引用文章：${qt.linkLabel || qt.url}`,
        };
        blocks.push(linkBlock);
        contentParts.push(linkBlock.html);
        textParts.push(linkBlock.text);

        // (2) 引用内容（在 quote 节点内）
        // 将 <br> 分隔的内容转为多段落 <p>，确保换行正确显示
        const quoteHtmlParagraphs = qt.html
            .split(/<br\s*\/?>/gi)
            .map(p => p.trim())
            .filter(Boolean)
            .map(p => `<p>${p}</p>`)
            .join('');
        const quoteBlock: ContentBlock = {
            id: generateId(),
            type: 'quote',
            html: `<blockquote>${quoteHtmlParagraphs || qt.html}</blockquote>`,
            text: qt.text,
        };
        blocks.push(quoteBlock);
        contentParts.push(quoteBlock.html);
        textParts.push(qt.text);

        // (3) 引用图片（独立节点，在 quote 之后）
        qt.images.forEach((img) => {
            // Use real alt text if available and meaningful, otherwise empty string
            const rawAlt = (img.alt || '').trim();
            // Filter out generic placeholders
            const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                rawAlt === 'null' || rawAlt === 'undefined';
            const altText = (rawAlt && !isGeneric) ? rawAlt : '';

            const imgBlock: ContentBlock = {
                id: generateId(),
                type: 'image',
                html: `<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`,
                text: altText,
            };
            blocks.push(imgBlock);
            contentParts.push(imgBlock.html);
        });

        console.log(`[twitterExtractor] 📝 Quote #${qtIndex + 1} 拼装: 图片=${qt.images.length}`);
    });

    return {
        contentHtml: contentParts.join(''),
        blocks,
        textContent: textParts.join('\n'),
        quoteTweets,
        quoteTweetContainers,
    };
}

/**
 * 提取推文中的图片
 * @param container 推文容器
 * @param excludeContainers 需要排除的容器（如引用帖容器），这些容器内的图片不会被提取
 */
function extractTweetImages(container: HTMLElement, excludeContainers: HTMLElement[] = []): ImageCandidate[] {
    // 只从主要推文区域提取图片，排除头像等
    const tweetArticles = container.querySelectorAll('[data-testid="tweet"]');

    if (tweetArticles.length === 0) {
        // 备选：直接从容器提取
        return extractImages(container);
    }

    // 只取第一条推文（主推文）的图片
    const mainTweet = tweetArticles[0] as HTMLElement;

    // 辅助函数：检查图片是否在排除容器内
    const isInExcludedContainer = (imgEl: HTMLElement): boolean => {
        for (const excludeContainer of excludeContainers) {
            if (excludeContainer.contains(imgEl)) {
                return true;
            }
        }
        return false;
    };

    // 查找推文中的图片（排除头像）
    const images: ImageCandidate[] = [];
    let order = 0;

    // 媒体图片通常在 [data-testid="tweetPhoto"] 中
    const photoElements = mainTweet.querySelectorAll('[data-testid="tweetPhoto"] img');

    photoElements.forEach((img) => {
        const imgEl = img as HTMLImageElement;

        // 排除在引用帖容器内的图片
        if (isInExcludedContainer(imgEl)) {
            console.log('[twitterExtractor] ⏭️ 跳过引用帖内的图片');
            return;
        }

        const src = imgEl.src || imgEl.getAttribute('src') || '';

        if (src && !src.includes('profile_images') && !src.includes('emoji')) {
            const normalizedUrl = normalizeImageUrl(src);
            images.push({
                id: generateId(),
                url: src,
                normalizedUrl,
                kind: 'img',
                order: order++,
                inMainContent: true,
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
                alt: imgEl.alt || '',
            });
        }
    });

    // 备选：提取普通图片（排除头像）
    if (images.length === 0) {
        const allImages = mainTweet.querySelectorAll('img');
        allImages.forEach((img) => {
            const imgEl = img as HTMLImageElement;

            // 排除在引用帖容器内的图片
            if (isInExcludedContainer(imgEl)) {
                return;
            }

            const src = imgEl.src || imgEl.getAttribute('src') || '';

            // 排除头像和 emoji
            if (src &&
                !src.includes('profile_images') &&
                !src.includes('emoji') &&
                !src.includes('twemoji') &&
                imgEl.width > 100 && imgEl.height > 100) {
                const normalizedUrl = normalizeImageUrl(src);
                images.push({
                    id: generateId(),
                    url: src,
                    normalizedUrl,
                    kind: 'img',
                    order: order++,
                    inMainContent: true,
                    width: imgEl.naturalWidth || imgEl.width,
                    height: imgEl.naturalHeight || imgEl.height,
                    alt: imgEl.alt || '',
                });
            }
        });
    }

    console.log(`[twitterExtractor] 📷 提取到 ${images.length} 张主推文图片 (排除了 ${excludeContainers.length} 个引用帖容器)`);
    return images;
}

/**
 * 提取作者
 */
function extractAuthor(): string | undefined {
    // 从页面 title 提取作者名
    const title = document.title;
    const match = title.match(/^\(?(?:\d+\)\s*)?(.+?)\s+on X:/);
    return match ? match[1].trim() : undefined;
}

/**
 * 提取发布时间
 */
function extractPublishTime(): string | undefined {
    // 查找第一个 time 元素
    const timeEl = document.querySelector(`${TWITTER_SELECTORS.primaryColumn} time`);
    if (timeEl) {
        return timeEl.getAttribute('datetime') || timeEl.textContent?.trim();
    }
    return undefined;
}

/**
 * 创建空结果
 */
function createEmptyResult(url: string, domain: string): ExtractResult {
    return {
        title: document.title || '推文',
        sourceUrl: url,
        domain,
        contentHtml: '',
        blocks: [],
        images: [],
        wordCount: 0,
    };
}

/**
 * 检测是否为 X Article（长文章）
 * X Article 使用 Draft.js 格式渲染，特征是包含 public-DraftStyleDefault-block 类的元素
 */
function detectXArticle(container: HTMLElement): boolean {
    // 检测 Draft.js 块元素（X Article 的主要特征）
    // X Article 页面使用 Draft.js 渲染，内容在 .public-DraftStyleDefault-block 类中
    const draftBlocks = Array.from(container.querySelectorAll('.public-DraftStyleDefault-block'));

    // 过滤掉可能是编辑器（如回复框）的块
    const validBlocks = draftBlocks.filter(block => {
        // 1. 忽略空内容的块（回复框默认是空的）
        if (!block.textContent?.trim()) return false;

        // 2. 忽略可编辑的块（这是输入框，不是发布的文章）
        // Draft.js 编辑器的容器通常有 contenteditable="true"
        if (block.getAttribute('contenteditable') === 'true') return false;
        if (block.closest('[contenteditable="true"]')) return false;
        return true;
    });

    if (validBlocks.length > 0) {
        console.log(`[twitterExtractor] 📄 检测到 ${validBlocks.length} 个有效的 Draft.js 块 (已过滤空块和编辑器)`);
        return true;
    }

    return false;
}

/**
 * 提取 X Article (长文章) 内容
 *
 * contentStart 参数用于移除已经作为标题使用的正文开头
 */
async function extractXArticleContent(container: HTMLElement, contentStart?: string): Promise<{
    contentHtml: string;
    blocks: ContentBlock[];
    textContent: string;
    images: ImageCandidate[];
    quoteTweets: QuoteTweet[];
    quoteTweetContainers: HTMLElement[];
}> {
    const blocks: ContentBlock[] = [];
    const contentParts: string[] = [];
    const textParts: string[] = [];
    const images: ImageCandidate[] = [];
    const quoteTweets: QuoteTweet[] = [];
    const quoteTweetContainers: HTMLElement[] = [];
    const seenUrls = new Set<string>();
    const seenTexts = new Set<string>();

    // 找到文章内容区域
    const articleContainer = container.querySelector('[data-testid="tweet"]') || container;

    // 预先识别所有 Quote Tweet 容器
    const allQuoteContainers = findQuoteTweetContainers(container);
    const quoteContainerSet = new Set(allQuoteContainers);

    console.log(`[twitterExtractor] 📄 X Article 按顺序提取开始，找到 ${allQuoteContainers.length} 个 Quote 容器`);

    let isFirstBlock = true;

    // 使用栈迭代遍历 DOM（按 DOM 顺序处理所有节点）
    // 栈中存储 [element, childIndex]，表示当前处理的元素及其子节点索引
    const stack: Array<{ element: HTMLElement; childIndex: number }> = [];
    const processed = new Set<HTMLElement>();

    // 初始化栈
    if (articleContainer.nodeType === Node.ELEMENT_NODE) {
        stack.push({ element: articleContainer as HTMLElement, childIndex: -1 });
    }

    while (stack.length > 0) {
        const current = stack[stack.length - 1];
        const element = current.element;

        // childIndex === -1 表示首次访问此节点，需要处理自身
        if (current.childIndex === -1) {
            current.childIndex = 0;

            // 跳过已处理的节点
            if (processed.has(element)) {
                stack.pop();
                continue;
            }

            // 检查是否是 Quote Tweet 容器
            if (quoteContainerSet.has(element)) {
                processed.add(element);
                // 适配新的 extractQuotedTweet 函数（异步）
                const quoteTweet = await extractQuotedTweet(element);
                if (quoteTweet) {
                    quoteTweets.push(quoteTweet);
                    quoteTweetContainers.push(element);

                    // (1) 引用链接行
                    const linkLabel = escapeHtml(quoteTweet.linkLabel || quoteTweet.url);
                    const linkBlock: ContentBlock = {
                        id: generateId(),
                        type: 'paragraph',
                        html: `<p>🔗 引用文章：<a href="${quoteTweet.url}">${linkLabel}</a></p>`,
                        text: `🔗 引用文章：${quoteTweet.linkLabel || quoteTweet.url}`,
                    };
                    blocks.push(linkBlock);
                    contentParts.push(linkBlock.html);
                    textParts.push(linkBlock.text);

                    // (2) 引用内容
                    const quoteBlock: ContentBlock = {
                        id: generateId(),
                        type: 'quote',
                        html: `<blockquote>${quoteTweet.html}</blockquote>`,
                        text: quoteTweet.text,
                    };
                    blocks.push(quoteBlock);
                    contentParts.push(quoteBlock.html);
                    textParts.push(quoteTweet.text);

                    // (3) 引用图片
                    quoteTweet.images.forEach((img: ImageCandidate) => {
                        // Use real alt text if available and meaningful, otherwise empty string
                        const rawAlt = (img.alt || '').trim();
                        // Filter out generic placeholders
                        const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                            rawAlt === 'null' || rawAlt === 'undefined';
                        const altText = (rawAlt && !isGeneric) ? rawAlt : '';

                        const imgBlock: ContentBlock = {
                            id: generateId(),
                            type: 'image',
                            html: `<img src="${img.url}" alt="${altText}" data-mowen-id="${img.id}" />`,
                            text: altText,
                        };
                        blocks.push(imgBlock);
                        contentParts.push(imgBlock.html);
                        images.push(img); // X Article 模式下图片统一收集
                    });

                    console.log(`[twitterExtractor] 📝 Quote Tweet 按顺序插入: url=${quoteTweet.url}, images=${quoteTweet.images.length}`);
                }
                stack.pop(); // 不再递归处理 Quote 容器内部
                continue;
            }

            // 检查是否在 Quote Tweet 容器内（跳过）
            let isInsideQuote = false;
            for (const qc of allQuoteContainers) {
                if (qc.contains(element) && element !== qc) {
                    isInsideQuote = true;
                    break;
                }
            }
            if (isInsideQuote) {
                stack.pop();
                continue;
            }

            // 检查是否是 Draft.js 文字块
            if (element.classList.contains('public-DraftStyleDefault-block')) {
                processed.add(element);
                const text = element.innerText?.trim() || '';
                const segments = extractXArticleParagraphSegments(element);

                if (text && !seenTexts.has(text)) {
                    // 去重逻辑：移除标题
                    if (isFirstBlock && contentStart) {
                        const cleanContentStart = contentStart.trim();
                        if (text === cleanContentStart || text.startsWith(cleanContentStart)) {
                            console.log(`[twitterExtractor] ✂️ X Article 移除标题段落: "${text.substring(0, 20)}..."`);
                            isFirstBlock = false;
                            stack.pop();
                            continue;
                        }
                    }
                    isFirstBlock = false;

                    seenTexts.add(text);
                    textParts.push(text);

                    const paragraphSegments = segments.length > 0
                        ? segments
                        : [];

                    paragraphSegments.forEach((segment) => {
                        contentParts.push(`<p>${segment.html}</p>`);
                        blocks.push({
                            id: generateId(),
                            type: 'paragraph',
                            html: `<p>${segment.html}</p>`,
                            text: segment.text,
                        });
                    });
                }
                stack.pop(); // 不再递归处理文字块内部
                continue;
            }

            // 检查是否是代码块
            if (element.tagName === 'PRE') {
                processed.add(element);
                const normalizedCodeBlock = extractNormalizedCodeBlock(element);

                if (normalizedCodeBlock) {
                    contentParts.push(normalizedCodeBlock.html);
                    textParts.push(normalizedCodeBlock.text);
                    blocks.push({
                        id: generateId(),
                        type: 'code',
                        html: normalizedCodeBlock.html,
                        text: normalizedCodeBlock.text,
                    });
                    console.log(`[twitterExtractor] 💻 X Article 代码块: ${normalizedCodeBlock.text.substring(0, 40)}...`);
                }

                stack.pop();
                continue;
            }

            // 检查是否是图片（媒体图片）
            if (element.tagName === 'IMG') {
                processed.add(element);
                const img = element as HTMLImageElement;
                const src = img.src || img.getAttribute('data-src') || '';

                // 跳过无效 URL
                if (!src || src.startsWith('data:') || src.includes('profile_images') ||
                    src.includes('emoji') || src.includes('twemoji') || src.includes('1x1')) {
                    stack.pop();
                    continue;
                }

                // 使用 naturalWidth/naturalHeight 验证图片已加载（比 width/height 更准确）
                const imgWidth = img.naturalWidth || img.width;
                const imgHeight = img.naturalHeight || img.height;
                const isComplete = img.complete && imgWidth > 0;

                // 跳过太小的图片（可能是图标或占位符）
                if (imgWidth < 100 || imgHeight < 100) {
                    console.log(`[twitterExtractor] ⏭️ 跳过小图片: ${imgWidth}x${imgHeight}, src=${src.substring(0, 50)}`);
                    stack.pop();
                    continue;
                }

                const normalizedUrl = normalizeImageUrl(src);
                if (!seenUrls.has(normalizedUrl)) {
                    seenUrls.add(normalizedUrl);

                    const imgCandidate: ImageCandidate = {
                        id: generateId(),
                        url: src,
                        normalizedUrl: normalizedUrl,
                        kind: 'img',
                        order: images.length,
                        inMainContent: true,
                        alt: img.alt || '',
                        width: imgWidth,
                        height: imgHeight,
                    };
                    images.push(imgCandidate);

                    // Use real alt text if available and meaningful, otherwise empty string
                    const rawAlt = (img.alt || '').trim();
                    // Filter out generic placeholders
                    const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                        rawAlt === 'null' || rawAlt === 'undefined';
                    const altText = (rawAlt && !isGeneric) ? rawAlt : '';
                    blocks.push({
                        id: generateId(),
                        type: 'image',
                        html: `<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`,
                        text: altText,
                    });
                    contentParts.push(`<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`);

                    console.log(`[twitterExtractor] 📷 图片 ${images.length}: ${imgWidth}x${imgHeight}, complete=${isComplete}, src=${src.substring(0, 60)}`);
                }
                stack.pop();
                continue;
            }

            // 检查是否是图片容器 [data-testid="tweetPhoto"]
            if (element.getAttribute('data-testid') === 'tweetPhoto') {
                processed.add(element);
                const img = element.querySelector('img') as HTMLImageElement;
                if (img) {
                    const src = img.src || img.getAttribute('data-src') || '';
                    if (src && !src.includes('profile_images') && !src.includes('emoji')) {
                        const normalizedUrl = normalizeImageUrl(src);
                        if (!seenUrls.has(normalizedUrl)) {
                            seenUrls.add(normalizedUrl);

                            const imgCandidate: ImageCandidate = {
                                id: generateId(),
                                url: src,
                                normalizedUrl: normalizedUrl,
                                kind: 'img',
                                order: images.length,
                                inMainContent: true,
                                alt: img.alt || '',
                                width: img.naturalWidth || img.width,
                                height: img.naturalHeight || img.height,
                            };
                            images.push(imgCandidate);

                            // Use real alt text if available and meaningful, otherwise empty string
                            const rawAlt = (img.alt || '').trim();
                            // Filter out generic placeholders
                            const isGeneric = /^(图片|图像|引用图|Image|Img|Picture|Photo)(\s*\d+)?$/i.test(rawAlt) ||
                                rawAlt === 'null' || rawAlt === 'undefined';
                            const altText = (rawAlt && !isGeneric) ? rawAlt : '';
                            blocks.push({
                                id: generateId(),
                                type: 'image',
                                html: `<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`,
                                text: altText,
                            });
                            contentParts.push(`<img src="${src}" alt="${altText}" data-mowen-id="${imgCandidate.id}" />`);
                        }
                    }
                }
                stack.pop();
                continue;
            }
        }

        // 处理子节点
        const children = element.children;
        if (current.childIndex < children.length) {
            const child = children[current.childIndex] as HTMLElement;
            current.childIndex++;
            if (child.nodeType === Node.ELEMENT_NODE) {
                stack.push({ element: child, childIndex: -1 });
            }
        } else {
            // 所有子节点都处理完了，弹出当前节点
            stack.pop();
        }
    }

    // 使用空字符串连接，避免产生额外的空行（空行会被 noteAtom 解析为空段落）
    const contentHtml = contentParts.join('');
    const textContent = textParts.join('\n');

    console.log(`[twitterExtractor] 📄 X Article 按顺序提取完成: ${blocks.length} 个块, ${textContent.length} 字, ${images.length} 张图片, ${quoteTweets.length} 个引用`);

    return {
        contentHtml,
        blocks,
        textContent,
        images,
        quoteTweets,
        quoteTweetContainers,
    };
}


/**
 * 获取 DOM 元素的 React Props
 */
function getReactProps(el: Element): any {
    if (!el) return null;
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    return propsKey ? (el as any)[propsKey] : null;
}

/**
 * 在 React Props 中深度查找 tweet 数据对象（保留旧函数兼容性）
 */
function findTweetDataInProps(props: any, depth = 0): any {
    if (!props || depth > 8) return null;

    // 1. 直接检查是否是 tweet 对象
    if (props.tweet && typeof props.tweet === 'object') {
        return props.tweet;
    }
    if (props.content && props.content.tweet) return props.content.tweet;

    if (props.id && (props.canonical_url || props.__typename === 'Tweet' || props.__typename === 'Article')) {
        return props;
    }

    const children = props.children;
    if (Array.isArray(children)) {
        for (const child of children) {
            if (child && child.props) {
                const found = findTweetDataInProps(child.props, depth + 1);
                if (found) return found;
            }
        }
    } else if (children && typeof children === 'object' && children.props) {
        const found = findTweetDataInProps(children.props, depth + 1);
        if (found) return found;
    }

    if (props.memoizedProps) {
        const found = findTweetDataInProps(props.memoizedProps, depth + 1);
        if (found) return found;
    }

    // 新增：检查 pendingProps
    if (props.pendingProps) {
        const found = findTweetDataInProps(props.pendingProps, depth + 1);
        if (found) return found;
    }

    return null;
}
