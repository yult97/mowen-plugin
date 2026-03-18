/**
 * Content Extractor Module
 * 
 * Handles extracting content from web pages using different strategies
 * for different page types (WeChat, general articles).
 */

import { Readability } from '@mozilla/readability';
import { ExtractResult, ContentBlock } from '../types';
import { generateId, isWeixinArticle, getDomain, stripHtml, isValidPageTitle, extractTitleFromText } from '../utils/helpers';
import { extractImages, removeLinkedBadgeImages } from './images';
import { isTwitterPage, extractTwitterContent } from './twitterExtractor';
// import { normalizeReadabilityHtml } from './extractor-utils'; // Defined internally

import { extractCaptionForImage } from './captionExtractor';
import { detectCodeLanguage } from '../utils/shikiLanguages';
import {
    ARTICLE_SELECTORS,
    AUTHOR_SELECTORS,
    TIME_SELECTORS,
    JUNK_SELECTORS,
    STRUCTURAL_SELECTORS,
    METADATA_TEXT_PATTERNS
} from '../config/site-selectors';



// Cache for extracted content
let cachedExtractResult: ExtractResult | null = null;
let isExtracting = false;

/**
 * Get cached extraction result if available.
 */
export function getCachedResult(): ExtractResult | null {
    return cachedExtractResult;
}

/**
 * Check if extraction is in progress.
 */
export function isExtractingContent(): boolean {
    return isExtracting;
}

/**
 * Clear the cached result.
 */
export function clearCache(): void {
    cachedExtractResult = null;
}

/**
 * Main content extraction function.
 */
export async function extractContent(): Promise<ExtractResult> {
    isExtracting = true;
    console.log('[extractor] 🚀 Starting content extraction...');

    const url = window.location.href;
    const domain = getDomain(url);

    const startTime = Date.now();

    try {
        let result: ExtractResult;

        // Use specific extractor for different page types
        if (isWeixinArticle(url)) {
            console.log('[extractor] 📱 Detected WeChat article');
            result = extractWeixinContent(url, domain);
        } else if (isTwitterPage(url)) {
            console.log('[extractor] 🐦 Detected X/Twitter page');
            result = await extractTwitterContent(url, domain);
        } else {
            // 其他页面使用通用提取器
            console.log('[extractor] 📄 Using general page extractor');
            result = extractWithReadability(url, domain);
        }

        // Cache the result
        cachedExtractResult = result;

        const elapsed = Date.now() - startTime;

        console.log(`[extractor] ✅ Extracted: title=${result.title}, words=${result.wordCount}, images=${result.images.length}, time=${elapsed}ms`);

        return result;
    } finally {
        isExtracting = false;
    }
}

/**
 * WeChat-specific content extraction.
 */
export function extractWeixinContent(url: string, domain: string): ExtractResult {
    const titleEl = document.querySelector('#activity-name') as HTMLElement;
    const contentEl = document.querySelector('#js_content') as HTMLElement;
    const authorEl = document.querySelector('#js_name') as HTMLElement;
    const publishTimeEl = document.querySelector('#publish_time') as HTMLElement;

    let title = titleEl?.innerText?.trim() || document.title;
    const author = authorEl?.innerText?.trim();
    const publishTime = publishTimeEl?.innerText?.trim();

    let contentHtml = '';
    let blocks: ContentBlock[] = [];

    if (contentEl) {
        const contentClone = contentEl.cloneNode(true) as HTMLElement;
        cleanContent(contentClone);
        contentHtml = contentClone.innerHTML;
        blocks = parseBlocks(contentClone);
    }

    // 处理无标题情况：从正文中提取第一句话作为标题
    if (!isValidPageTitle(title)) {
        const plainText = stripHtml(contentHtml);
        const extracted = extractTitleFromText(plainText, 30);
        if (extracted.title) {
            title = extracted.title;
            // 从正文中移除已提取的标题部分
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = contentHtml;
            // 获取纯标题文本（去除省略号）
            const titleText = extracted.title.replace(/\.{3}$/, '').trim();
            // 遍历所有块级元素，找到包含标题文本的第一个元素
            const allBlocks = tempDiv.querySelectorAll('p, div, section, span');
            for (const block of allBlocks) {
                const blockText = block.textContent?.trim() || '';
                // 严格匹配条件：
                // 1. 元素内容不超过 100 字符（避免匹配到大块内容）
                // 2. 元素内容长度在标题长度的 1.2 倍以内（允许标点符号差异）
                // 3. 元素内容必须以标题文本开头
                // 4. 避免误删：元素内容不能比标题长很多（可能是包含标题的正文段落）
                const isExactMatch = blockText.length <= titleText.length * 1.2;
                const isSmallBlock = blockText.length < 100;
                const startsWithTitle = blockText.startsWith(titleText);

                if (isSmallBlock && isExactMatch && startsWithTitle) {
                    block.remove();
                    contentHtml = tempDiv.innerHTML;
                    blocks = parseBlocks(tempDiv);
                    break;
                }
            }
            console.log('[extractor] 📝 Extracted title from content:', title);
        }
    }

    const images = extractImages(contentEl || document.body);
    const wordCount = stripHtml(contentHtml).length;

    return {
        title,
        sourceUrl: url,
        domain,
        author,
        publishTime,
        contentHtml,
        blocks,
        images,
        wordCount,
    };
}

/**
 * General article extraction using Mozilla Readability library with adapter layer.
 * 包含完整的适配逻辑：DOM预处理 -> Readability解析 -> 失败验证 -> 格式规范化 -> 转换
 */
export function extractWithReadability(url: string, domain: string): ExtractResult {
    // 1. 克隆与预处理
    const documentClone = document.cloneNode(true) as Document;
    preprocessDom(documentClone, url);

    // 2. 显式提取封面图 (Hero Image) - 已移除，改用 Step 5 的 extractImageNearTitle
    // const heroImage = extractHeroImage(document);




    // 3. Readability 解析
    const reader = new Readability(documentClone, {
        debug: false,
        keepClasses: true,
        // 允许的标签，确保不漏掉代码块等
        // Readability 默认会保留常见标签，通常不需要额外配置 classes
    });

    const article = reader.parse();

    // 4. Fail-fast 失败判定
    // 如果解析为空，或者内容过短，或者段落太少，降级到原有逻辑
    if (!article || article.content.length < 200 || !hasEnoughParagraphs(article.content)) {
        console.log('[extractor] ⚠️ Readability validation failed (too short or empty), falling back...');
        return extractWithFallback(url, domain);
    }

    console.log('[extractor] ✅ Readability parsed successfully');

    let contentHtml = article.content;
    let title = article.title || document.title;
    const author = article.byline || undefined;

    // 处理无标题情况：从正文中提取第一句话作为标题
    if (!isValidPageTitle(title)) {
        const plainText = stripHtml(contentHtml);
        const extracted = extractTitleFromText(plainText, 30);
        if (extracted.title) {
            title = extracted.title;
            // 从正文中移除已提取的标题部分
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = contentHtml;
            // 获取纯标题文本（去除省略号）
            const titleText = extracted.title.replace(/\.{3}$/, '').trim();
            // 遍历所有块级元素，找到包含标题文本的第一个元素
            const allBlocks = tempDiv.querySelectorAll('p, div, section, span');
            for (const block of allBlocks) {
                const blockText = block.textContent?.trim() || '';
                // 严格匹配条件：
                // 1. 元素内容不超过 100 字符（避免匹配到大块内容）
                // 2. 元素内容长度在标题长度的 1.2 倍以内（允许标点符号差异）
                // 3. 元素内容必须以标题文本开头
                // 4. 避免误删：元素内容不能比标题长很多（可能是包含标题的正文段落）
                const isExactMatch = blockText.length <= titleText.length * 1.2;
                const isSmallBlock = blockText.length < 100;
                const startsWithTitle = blockText.startsWith(titleText);

                if (isSmallBlock && isExactMatch && startsWithTitle) {
                    block.remove();
                    contentHtml = tempDiv.innerHTML;
                    break;
                }
            }
            console.log('[extractor] 📝 Extracted title from content:', title);
        }
    }

    // 辅助函数：提取 URL 路径用于对比（忽略协议和域名）
    // 例如 "http://www.latepost.com/uploads/cover/abc.png" -> "/uploads/cover/abc.png"
    const getUrlPath = (url: string): string => {
        try {
            return new URL(url).pathname.toLowerCase();
        } catch {
            // 如果 URL 解析失败，使用简单的正则提取
            return url.replace(/^https?:\/\/[^/]+/i, '').toLowerCase();
        }
    };

    // 5. 智能注入首图 (Smart Hero Image Injection)
    // 不再使用 Meta 标签注入 (a16z 痛点)，改为探测标题附近的 DOM 图片 (baoyu.io 需求)。
    // 仅当 Readability 漏掉且图片确实在标题附近时注入。
    const nearbyImage = extractImageNearTitle(document, title);

    if (nearbyImage) {
        // 使用 URL 路径检查，忽略协议和域名差异
        const imgPath = getUrlPath(nearbyImage.src);

        if (!contentHtml.toLowerCase().includes(imgPath)) {
            console.log(`[extractor] 🖼️ Injecting detected header image: ${nearbyImage.src}`);
            // 封面图不使用 alt，避免显示不相关的图片说明
            const imgHtml = `<figure class="hero-image"><img src="${nearbyImage.src}" alt="" /></figure>`;
            contentHtml = imgHtml + contentHtml;
        } else {
            console.log(`[extractor] ℹ️ Header image already in content, skipping: ${nearbyImage.src}`);
        }
    }

    // 5.5 【新增】从原始 DOM 的特殊容器中提取遗漏的正文图片
    // Latepost 等网站的 .article-body 可能未被 Readability 正确识别
    const specialBodyContainers = [
        '.article-body',    // Latepost 正文
        '.ql-editor',       // Quill 富文本编辑器
    ];

    // 用于比较的 contentHtml（小写）
    const contentHtmlLower = contentHtml.toLowerCase();

    for (const selector of specialBodyContainers) {
        const container = document.querySelector(selector);
        if (container) {
            const containerImages = container.querySelectorAll('img');
            containerImages.forEach(img => {
                // 检查该图片是否已在 contentHtml 中（使用 URL 路径比较）
                const imgPath = getUrlPath(img.src);
                if (img.src && !img.src.startsWith('data:') && !contentHtmlLower.includes(imgPath)) {
                    // 过滤头像等小图
                    const className = (img.className || '').toLowerCase();
                    if (className.includes('avatar') || className.includes('icon') || className.includes('author')) {
                        return;
                    }
                    const width = img.naturalWidth || img.width || 0;
                    const height = img.naturalHeight || img.height || 0;
                    // 只注入较大的图片
                    if ((width > 200 && height > 100) || (!width && !height)) {
                        console.log(`[extractor] 🖼️ Injecting missed body image from ${selector}: ${img.src}`);
                        const imgHtml = `<figure><img src="${img.src}" alt="${img.alt || ''}" /></figure>`;
                        contentHtml += imgHtml;
                    }
                }
            });
        }
    }

    // 5.6 【新增】移除正文中的重复标题
    // 某些网站（如纽约时报中文网）的 <h1> 标题位于 <article> 内部，
    // 导致 Readability 将其作为正文一部分提取，与 title 字段重复。
    // 在此移除与 title 完全匹配的 h1 元素。
    {
        const tempDivForH1 = document.createElement('div');
        tempDivForH1.innerHTML = contentHtml;
        const h1Elements = tempDivForH1.querySelectorAll('h1');
        h1Elements.forEach(h1 => {
            const h1Text = h1.textContent?.trim() || '';
            // 如果 h1 内容与标题完全匹配或为空，则移除
            if (h1Text === title || h1Text === '') {
                console.log('[extractor] 🗑️ Removing duplicate h1 from content:', h1Text.substring(0, 30));
                h1.remove();
            }
        });
        contentHtml = tempDivForH1.innerHTML;
    }

    // 6. HTML 规范化 (Post-processing)
    // 清理嵌套 div，修复列表，确保适合 noteAtom 转换
    contentHtml = normalizeReadabilityHtml(contentHtml);

    // 7. 转换 - 复用现有的转换逻辑
    // 从规范化后的 HTML 中提取图片和内容块
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = contentHtml;

    // 提取图片 (从处理后的 HTML 中提取，确保一致性)
    const images = extractImages(tempDiv);
    console.log(`[extractor] 📷 Extracted ${images.length} images from adapter output`);

    const blocks = parseBlocks(tempDiv);
    const wordCount = stripHtml(contentHtml).length;

    return {
        title,
        sourceUrl: url,
        domain,
        author,
        publishTime: undefined, // Readability 不提供发布时间
        contentHtml,
        blocks,
        images,
        wordCount,
    };
}

/**
 * Fallback extraction logic (Original Selector-based approach)
 */
function extractWithFallback(url: string, domain: string): ExtractResult {
    console.log('[extractor] 🔄 Running fallback extraction...');
    const documentClone = document.cloneNode(true) as Document;
    const article = extractArticle(documentClone);

    const title = article.title || document.title;
    const contentHtml = article.content || '';

    // Fallback logic for Substack images
    let imageEl: HTMLElement;
    const isSubstack = domain.includes('substack') || url.includes('substack.com') ||
        document.querySelector('.available-content') !== null;

    if (isSubstack) {
        const availableContent = document.querySelector('.available-content') as HTMLElement;
        if (availableContent) {
            imageEl = availableContent;
        } else {
            imageEl = article.imageElement || article.contentElement || document.body;
        }
    } else {
        imageEl = article.imageElement || article.contentElement || document.body;
    }

    const images = extractImages(imageEl);
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = contentHtml;
    const blocks = parseBlocks(tempDiv);
    const wordCount = stripHtml(contentHtml).length;

    return {
        title,
        sourceUrl: url,
        domain,
        author: article.author,
        publishTime: article.publishTime,
        contentHtml,
        blocks,
        images,
        wordCount,
    };
}

// --- Adapters & Helpers ---

function serializeElementAttributes(element: Element | null | undefined): string {
    if (!element) return '';

    return Array.from(element.attributes)
        .map(attr => `${attr.name}="${attr.value.replace(/"/g, '&quot;')}"`)
        .join(' ');
}

function detectCodeLanguageFromElements(
    pre: Element | null,
    code: Element | null,
    extraElements: Array<Element | null | undefined> = []
): string | null {
    const candidateElements = [pre, code, ...extraElements].filter((element): element is Element => Boolean(element));
    const seen = new Set<Element>();
    const extras: string[] = [];

    let preAttrs = '';
    let codeAttrs = '';

    for (const element of candidateElements) {
        if (seen.has(element)) continue;
        seen.add(element);

        const attrs = serializeElementAttributes(element);
        if (!attrs) continue;

        if (element === pre) {
            preAttrs += ` ${attrs}`;
        } else if (element === code) {
            codeAttrs += ` ${attrs}`;
        } else {
            extras.push(attrs);
        }
    }

    return detectCodeLanguage(`${preAttrs} ${extras.join(' ')}`, codeAttrs);
}

function syncCodeLanguageMetadata(pre: HTMLElement, code: HTMLElement | null): void {
    const wrapperSelector = '[data-language], [data-lang], [class*="language-"], [class*="lang-"], [class*="hljs"]';
    const language = detectCodeLanguageFromElements(
        pre,
        code,
        [
            pre.parentElement,
            pre.closest(wrapperSelector),
            code?.parentElement,
            code?.closest(wrapperSelector),
        ]
    );

    if (!language) return;

    pre.setAttribute('data-language', language);
    if (code) {
        code.setAttribute('data-language', language);
    }
}

function normalizeStandaloneCodeBlocks(doc: Document, body: HTMLElement): void {
    const standaloneCodes = Array.from(body.querySelectorAll('code')).filter(code => !code.closest('pre'));

    for (const code of standaloneCodes) {
        const parent = code.parentElement;
        if (!parent) continue;

        const text = code.textContent || '';
        const hasLanguageHint = Boolean(
            detectCodeLanguageFromElements(
                null,
                code,
                [
                    parent,
                    parent.closest('[data-language], [data-lang], [class*="language-"], [class*="lang-"], [class*="hljs"]'),
                ]
            )
        );
        const hasOnlyCodeContent = Array.from(parent.childNodes).every(node => {
            if (node === code) return true;
            if (node.nodeType === Node.TEXT_NODE) {
                return !(node.textContent || '').trim();
            }
            const element = node as Element;
            return element.tagName === 'BUTTON' || element.classList.contains('copy-code-btn');
        });
        const looksLikeBlockCode = hasOnlyCodeContent && (hasLanguageHint || /\n/.test(text) || text.length > 120);

        if (!looksLikeBlockCode) continue;

        const clonedCode = code.cloneNode(true) as HTMLElement;
        const pre = doc.createElement('pre');
        pre.appendChild(clonedCode);
        syncCodeLanguageMetadata(pre, clonedCode);
        pre.querySelectorAll('button, .copy-btn, .copy-code-btn, .line-numbers-rows').forEach(el => el.remove());

        if (['P', 'DIV', 'SECTION', 'ARTICLE', 'LI'].includes(parent.tagName) && hasOnlyCodeContent) {
            parent.replaceWith(pre);
        } else {
            code.replaceWith(pre);
        }
    }
}

/**
 * 强制元素及其祖先链可见
 * 解决 Milvus 等站点使用 Tab 切换代码块时，非激活代码块被 CSS 隐藏（display:none），
 * Readability 的 isElementVisible 检查会彻底删除不可见元素的问题。
 */
function forceElementVisible(el: HTMLElement): void {
    // 常见的隐藏 class 名（不包含通用词以避免误伤）
    const HIDDEN_CLASSES = ['hidden', 'hide', 'is-hidden', 'd-none', 'display-none', 'invisible'];
    let current: HTMLElement | null = el;

    while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
        // 移除 hidden 属性
        if (current.hasAttribute('hidden')) {
            current.removeAttribute('hidden');
        }

        // 修复 style 中的隐藏
        const style = current.style;
        if (style.display === 'none') {
            style.setProperty('display', 'block', 'important');
        }
        if (style.visibility === 'hidden') {
            style.setProperty('visibility', 'visible', 'important');
        }
        if (style.opacity === '0') {
            style.setProperty('opacity', '1', 'important');
        }

        // 移除常见隐藏 class
        for (const cls of HIDDEN_CLASSES) {
            if (current.classList.contains(cls)) {
                current.classList.remove(cls);
            }
        }

        current = current.parentElement;
    }
}

/**
 * Pre-process DOM before Readability: Clean noise, fix lazy loading, absolute URLs.
 */
function preprocessDom(doc: Document, baseUrl: string) {
    // 1. Remove noise elements
    const noiseSelectors = ['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'button', 'input', 'select', 'textarea'];
    doc.querySelectorAll(noiseSelectors.join(',')).forEach(el => el.remove());

    // 2. Fix Lazy Loading Images
    // Try to find real src in dataset
    const imgCandidates = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'dataset.src'];
    doc.querySelectorAll('img').forEach(img => {
        // Fix srcset if present (pick largest) - simple approach: remove srcset to force src, or let Readability handle it.
        // Readability might be confused by srcset, so let's simplify: if src is missing/placeholder, fix it.
        if (!img.src || img.src.startsWith('data:') || img.src.includes('placeholder')) {
            for (const attr of imgCandidates) {
                if (img.getAttribute(attr)) {
                    img.src = img.getAttribute(attr)!;
                    break;
                }
            }
        }
    });

    // 3. Absolute URLs
    // Base element might handle this, but explicit conversion is safer
    const makeAbsolute = (relUrl: string) => {
        try {
            return new URL(relUrl, baseUrl).href;
        } catch (e) {
            return relUrl;
        }
    };

    doc.querySelectorAll('img').forEach(img => {
        if (img.src) img.src = makeAbsolute(img.getAttribute('src') || img.src);
    });

    doc.querySelectorAll('a').forEach(a => {
        if (a.href) a.href = makeAbsolute(a.getAttribute('href') || a.href);
    });

    // 4. 【新增】将 font-weight: bold 样式的 span 转换为语义化的 <strong> 标签
    // 在 Readability 解析之前进行，因为 Readability 会移除 style 属性
    doc.querySelectorAll('span[style]').forEach(span => {
        const style = span.getAttribute('style') || '';
        // 检测 font-weight: bold 或 font-weight: 700+ 的样式
        if (/font-weight\s*:\s*(bold|[7-9]\d{2})/i.test(style)) {
            const strong = doc.createElement('strong');
            while (span.firstChild) {
                strong.appendChild(span.firstChild);
            }
            span.replaceWith(strong);
        }
    });

    // 5. 【新增】智能提取图片注释 (Image Caption Extraction)
    // 计算并暂存注释到 data-mowen-caption，以便稍后 Readability 清洗后保留
    doc.querySelectorAll('img').forEach(img => {
        const caption = extractCaptionForImage(img);
        if (caption) {
            // console.log(`[extractor] 📝 Found caption for image: "${caption}"`);
            img.setAttribute('data-mowen-caption', caption);
        }
    });

    // 6. 【新增】代码块语言信息提升 + 可见性修复（Code Language Promotion & Visibility Fix）
    // 在 Readability 解析前：
    //   a) 强制显示所有 <pre> 标签及其被隐藏的祖先容器
    //      原因：Milvus 等站点使用多语言 Tab，非激活代码块被 CSS 隐藏（display:none），
    //      Readability 的 isElementVisible 检查会彻底删除不可见元素
    //   b) 将 <code> 标签上的语言信息提升到父级 <pre> 上
    doc.querySelectorAll('pre').forEach(pre => {
        // a) 强制显示 <pre> 及其被隐藏的祖先容器
        forceElementVisible(pre as HTMLElement);

        // b) 语言信息提升
        const code = pre.querySelector('code');
        syncCodeLanguageMetadata(pre as HTMLElement, code as HTMLElement | null);

        // c) 清除代码块内的干扰元素（复制按钮、行号等）
        pre.querySelectorAll('button, .copy-btn, .copy-code-btn, .line-numbers-rows').forEach(el => el.remove());
    });

    // 7. 过滤文档顶部的 badge/CTA 图片（如 Open in Colab / View on GitHub）
    // 这类图片不是正文内容，保留会导致被当作普通文章配图剪藏。
    removeLinkedBadgeImages(doc.body);
}

// function extractHeroImage removed

/**
 * 尝试在标题附近探测图片（智能补全）
 * 策略：
 * 1. 找到文章标题 (H1)
 * 2. 在标题紧邻的兄弟节点或子节点中寻找显著大图
 * 3. 这种图通常是文章的“封面”或“首图”，如果 Readability 漏掉了，值得补回
 * 4. 特别检测：Latepost (.abstract-pic-right) 等特殊封面图容器
 */
function extractImageNearTitle(doc: Document, articleTitle: string): { src: string, alt?: string } | null {
    if (!articleTitle) return null;

    // 0. 优先检测特殊封面图容器（Latepost 等网站）
    // 这些容器通常包含明确的封面图，不依赖标题定位
    const specialCoverSelectors = [
        '.abstract-pic-right img',  // Latepost 封面图
        '.cover-image img',         // 通用封面图
        '.hero-image img',          // Hero 图
        '.post-cover img',          // 文章封面
    ];

    for (const selector of specialCoverSelectors) {
        const coverImg = doc.querySelector(selector) as HTMLImageElement;
        if (coverImg?.src && !coverImg.src.startsWith('data:')) {
            console.log(`[extractor] 🎯 Found cover image via special selector "${selector}": ${coverImg.src}`);
            // 不返回 alt，避免封面图显示不相关的图片说明
            return { src: coverImg.src };
        }
    }

    // 1. 定位标题元素
    // 优先找 H1，且内容包含标题文字
    const h1s = Array.from(doc.querySelectorAll('h1'));
    let titleEl = h1s.find(h1 => h1.textContent?.includes(articleTitle.substring(0, 10))); // 模糊匹配前缀

    if (!titleEl) {
        // 尝试找 class 包含 title 的元素
        titleEl = Array.from(doc.querySelectorAll('[class*="title"]'))
            .find(el => el.textContent?.includes(articleTitle.substring(0, 10)) && el.tagName.match(/^H[1-6]$/)) as HTMLHeadingElement;
    }

    if (!titleEl) return null;

    console.log('[extractor] 📍 Located title element, searching for nearby images...');

    // 2. 向下搜寻图片 (Look ahead in the whole document or main content area)
    // 扩展 rootContext 选择器以支持更多网站结构
    const rootContext =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.querySelector('.article-body') ||  // Latepost 正文
        document.querySelector('.ql-editor') ||     // Quill 编辑器
        document.querySelector('.content') ||       // 通用内容区
        document.body;
    const images = Array.from(rootContext.querySelectorAll('img'));

    // 找到第一张在其后的图片
    for (const img of images) {
        // 必须在 title 元素之后 (Bitmask 4: DOCUMENT_POSITION_FOLLOWING)
        const position = titleEl.compareDocumentPosition(img);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {

            // 检查是否是大图
            const width = parseInt(img.getAttribute('width') || '0') || img.naturalWidth || 0;
            const height = parseInt(img.getAttribute('height') || '0') || img.naturalHeight || 0;
            const className = (img.className || '').toLowerCase();

            // 过滤明显的小图标/头像
            if (className.includes('avatar') || className.includes('icon') || className.includes('author')) continue;

            // 宽松的尺寸阈值 (或无尺寸，假设懒加载未完成时交由后续处理，但通常首图会有尺寸或占位)
            // 增加宽高比检查，避免扁长的分割线图
            if ((width > 300 && height > 150) || (!width && !height)) {
                // 距离保护：如果图片离 Title 太远（例如是在评论区），可能也不对。
                // 但 Readability 提取的内容通常包含了正文，如果这张图在正文中，Readability 会包含它；
                // 我们现在的目标是找 Readability *漏掉* 的图（通常就在正文前、Title 后）。
                // 所以这里我们假设 "Title 后的第一张大图" 就是它是安全的。

                console.log(`[extractor] 🎯 Found image near title (global search): ${img.src}`);
                return { src: img.src, alt: img.alt };
            }
        }
    }

    return null;
}




/**
 * Normalize Readability output HTML to be friendly for noteAtom converter.
 */
function normalizeReadabilityHtml(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    // 清理链接型 badge/按钮图片，避免它们出现在正文与图片候选中。
    removeLinkedBadgeImages(body);

    // 1. Unwrap layout divs (divs that just contain other block elements or text)
    // simple logic: if a div has no attributes (cleaned by Readability?) or just class,
    // and contains block elements, maybe unwrap?
    // Actually Readability output is usually cleanish, but might have nested divs.
    // Let's strip classes 'page', 'content', 'entry-content' etc wrapper divs if they exist inside.

    // 1. Unwrap layout divs (divs that just contain other block elements or text)
    // simple logic: if a div has no attributes (cleaned by Readability?) or just class,
    // and contains block elements, maybe unwrap?
    // Actually Readability output is usually cleanish, but might have nested divs.
    // Let's strip classes 'page', 'content', 'entry-content' etc wrapper divs if they exist inside.

    // Strategy: Remove all <div> tags but keep their children. 
    // noteAtom parses <p>, <ul>, etc. Divs usually just add spacing/grouping.
    // BUT we need to be careful about divs that ARE the content blocks (e.g. some sites use div instead of p).
    // Let's try converting divs that contain text directly into <p>.
    body.querySelectorAll('div').forEach(div => {
        // If div behaves like a text paragraph (no block children) -> turn to p
        const hasBlockChildren = div.querySelector('div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, table, pre, figure');
        if (!hasBlockChildren && (div.textContent?.trim() || '').length > 0) {
            const p = doc.createElement('p');
            p.innerHTML = div.innerHTML;
            div.replaceWith(p);
        } else if (hasBlockChildren) {
            // If it's a wrapper, maybe unwrap? 
            // For now, let's leave it. parseBlocks handles <div> as BLOCK_START/END boundaries.
            // The issue "too much spacing" comes from <div><div><p>... generating multiple boundaries.
            // We can accept that for now or try to unwrap strict wrappers.
        }
    });

    // 2. Fix Lists: Readability sometimes puts <p> inside <li>? 
    // noteAtom relies on convertListItems via regex.
    // Double bullets happen if <li> contains a <p> or text that noteAtom also treats as a block.
    // Clean <li> content: unwrap <p> inside <li>.
    body.querySelectorAll('li p').forEach(p => {
        // move children of P to LI
        while (p.firstChild) {
            p.parentNode?.insertBefore(p.firstChild, p);
        }
        p.remove();
        // Insert a br if there were multiple Ps?
    });

    // 2.5【新增】将 font-weight: bold 样式的 span 转换为语义化的 <strong> 标签
    // Latepost 等网站使用 <span style="font-weight: bold;"> 而非 <strong>
    // 在清理 style 属性之前进行转换，确保加粗样式被保留
    body.querySelectorAll('span[style]').forEach(span => {
        const style = span.getAttribute('style') || '';
        // 检测 font-weight: bold 或 font-weight: 700+ 的样式
        if (/font-weight\s*:\s*(bold|[7-9]\d{2})/i.test(style)) {
            // 创建 <strong> 元素替换 span
            const strong = doc.createElement('strong');
            // 保留 span 的所有子节点
            while (span.firstChild) {
                strong.appendChild(span.firstChild);
            }
            span.replaceWith(strong);
        }
    });

    // 2.6【新增】将被 Readability 打散成独立 <code> 的块级代码重新包装成 <pre>
    normalizeStandaloneCodeBlocks(doc, body);

    // 2.7【新增】在属性清理前再次同步代码块语言元数据
    body.querySelectorAll('pre').forEach(pre => {
        const code = pre.querySelector('code');
        syncCodeLanguageMetadata(pre, code);
        pre.querySelectorAll('button, .copy-btn, .copy-code-btn, .line-numbers-rows').forEach(el => el.remove());
    });

    // 3. 【新增】清理冗余 HTML 属性，大幅减少 HTML 体积
    // 保留必要属性：href, src, alt, data-mowen-uid, width, height, target, rel, style
    // 注意：保留 style 属性以便 noteAtom 处理其他样式（如斜体）
    // 注意：保留 data-mowen-caption 以传递提取到的图片注释
    // 移除：class, id, data-* (除白名单外), contenteditable 等
    const BASE_KEEP_ATTRS = new Set([
        'href',
        'src',
        'alt',
        'data-mowen-uid',
        'data-mowen-caption',
        'width',
        'height',
        'target',
        'rel',
        'srcset',
        'data-src',
        'data-original',
        'style',
    ]);

    body.querySelectorAll('*').forEach(el => {
        const keepAttrs = new Set(BASE_KEEP_ATTRS);
        if (el.tagName === 'PRE' || el.tagName === 'CODE') {
            keepAttrs.add('class');
            keepAttrs.add('data-language');
            keepAttrs.add('data-lang');
            keepAttrs.add('translate');
        }

        const attrsToRemove: string[] = [];
        for (const attr of Array.from(el.attributes)) {
            if (!keepAttrs.has(attr.name)) {
                attrsToRemove.push(attr.name);
            }
        }
        attrsToRemove.forEach(attr => el.removeAttribute(attr));
    });

    return body.innerHTML;
}

/**
 * Check if content has enough paragraphs to be considered a valid article.
 */
function hasEnoughParagraphs(html: string): boolean {
    const match = html.match(/<(p|div|li|h[1-6])[^>]*>/gi);
    return match ? match.length >= 3 : false;
}



/**
 * Extract article content from a document.
 */
function extractArticle(doc: Document): {
    title: string;
    content: string;
    author?: string;
    publishTime?: string;
    contentElement?: HTMLElement;
    imageElement?: HTMLElement;
} {
    let contentElement: HTMLElement | null = null;

    for (const selector of ARTICLE_SELECTORS) {
        contentElement = doc.querySelector(selector) as HTMLElement;
        if (contentElement && contentElement.innerText.length > 200) {
            break;
        }
    }

    if (!contentElement) {
        contentElement = doc.body;
    }

    const imageClone = contentElement.cloneNode(true) as HTMLElement;
    const clone = contentElement.cloneNode(true) as HTMLElement;
    cleanContent(clone, true); // Aggressive cleaning for text
    cleanContent(imageClone, false); // Safe cleaning for images (keeps headers, removes ads/junk)

    // Extract title
    const titleEl = doc.querySelector('h1') || doc.querySelector('title');
    let title = '';
    if (titleEl) {
        const titleClone = titleEl.cloneNode(true) as HTMLElement;
        titleClone.querySelectorAll('a.header-anchor, a.heading-anchor, a.anchor, .header-anchor').forEach(el => el.remove());
        title = titleClone.textContent?.trim() || '';
    }

    // Remove duplicate h1s
    const clonedH1s = clone.querySelectorAll('h1');
    clonedH1s.forEach(h1 => {
        const h1Clone = h1.cloneNode(true) as HTMLElement;
        h1Clone.querySelectorAll('a.header-anchor, a.heading-anchor, a.anchor, .header-anchor').forEach(el => el.remove());
        const h1Text = h1Clone.textContent?.trim() || '';
        if (h1Text === title || h1Text === '') {
            h1.remove();
        }
    });

    // Extract author
    let author: string | undefined;
    for (const selector of AUTHOR_SELECTORS) {
        const el = doc.querySelector(selector) as HTMLElement;
        if (el?.innerText) {
            author = el.innerText.trim();
            break;
        }
    }

    // Extract publish time
    let publishTime: string | undefined;
    for (const selector of TIME_SELECTORS) {
        const el = doc.querySelector(selector) as HTMLElement;
        if (el) {
            publishTime = el.getAttribute('datetime') || el.innerText?.trim();
            break;
        }
    }

    return {
        title,
        content: clone.innerHTML,
        author,
        publishTime,
        contentElement: clone,
        imageElement: imageClone,
    };
}


/**
 * Clean content by removing unwanted elements.
 * 
 * @param element The element to clean
 * @param aggressive If true, removes structural elements like headers, footers, navs (for text extraction).
 *                   If false, only removes ads, social bars, comments (for image extraction).
 */
export function cleanContent(element: HTMLElement, aggressive: boolean = true): void {
    // 1. Remove Junk (Ads, Social, Comments, Interaction Bars) - Always Safe
    for (const selector of JUNK_SELECTORS) {
        element.querySelectorAll(selector).forEach((el) => el.remove());
    }

    // 2. Remove Structural Elements (Headers, Footers, Nav) - Only if aggressive
    // These might contain main images, so be careful when extracting images.
    if (aggressive) {
        for (const selector of STRUCTURAL_SELECTORS) {
            element.querySelectorAll(selector).forEach((el) => el.remove());
        }
    } else {
        // Always remove script and style even in non-aggressive mode
        element.querySelectorAll('script, style').forEach((el) => el.remove());
    }

    removeLinkedBadgeImages(element);

    // Remove hidden elements
    element.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') {
            el.remove();
        }
    });

    // 3. Remove elements by text content patterns (for sites with unique text markers)
    // This handles author bylines, breadcrumbs, dates etc. that can't be targeted by class alone
    if (aggressive) {
        const elementsToRemove: HTMLElement[] = [];

        // General text pattern removal
        // 添加 time 元素，因为日期信息通常在 time 标签内
        element.querySelectorAll('div, span, p, a, time').forEach((el) => {
            const text = (el.textContent || '').trim();
            // Only match small elements (less than 100 chars) to avoid removing large content blocks
            if (text.length > 0 && text.length < 100) {
                for (const pattern of METADATA_TEXT_PATTERNS) {
                    if (pattern.test(text)) {
                        // Remove the closest container that looks like a metadata block
                        // Use a safer traversal: only go up to .flex or small containers
                        const container = (el as HTMLElement).closest('.flex') || el.parentElement;
                        if (container && container !== element && (container as HTMLElement).innerText.length < 300) {
                            elementsToRemove.push(container as HTMLElement);
                        }
                        break;
                    }
                }
            }
        });

        // Specific eesel.ai targeted removal logic

        // 1. Remove Author/Header Block
        // Structure: div containing "Written by" and "Reviewed by"
        // We find the specific element containing BOTH strings
        element.querySelectorAll('*').forEach((el) => {
            // Avoid selecting body or main container
            if (el.tagName === 'BODY' || el === element) return;

            const text = (el.textContent || '').trim();
            const lowerText = text.toLowerCase();

            // Author Metadata Block (Top)
            if (text.includes('Written by') && text.includes('Reviewed by') && text.length < 500) {
                elementsToRemove.push(el as HTMLElement);
            }

            // Author Card (Bottom): "Article by [Name]" or "Share this post"
            if ((text.includes('Article by') || text.includes('Share this post')) && text.length < 300) {
                // Often these are in a wrapper
                const container = (el as HTMLElement).closest('.flex') || el.parentElement;
                if (container && container !== element && (container as HTMLElement).innerText.length < 500) {
                    elementsToRemove.push(container as HTMLElement);
                } else {
                    elementsToRemove.push(el as HTMLElement);
                }
            }

            // Side CTA / Promo Card: "Try it for free" + "Learn more"
            if (lowerText.includes('try it for free') && lowerText.includes('learn more') && text.length < 300) {
                const container = (el as HTMLElement).closest('div') || el;
                elementsToRemove.push(container as HTMLElement);
            }

            // Breadcrumbs: "Blogs / Guides"
            if (lowerText === 'blogs / guides' || (lowerText.includes('blogs / guides') && text.length < 50)) {
                const container = (el as HTMLElement).closest('.flex') || el.parentElement;
                if (container && container !== element) {
                    elementsToRemove.push(container as HTMLElement);
                }
            }
        });

        // 2. Remove FAQ Section Safely
        // Find the "Frequently asked questions" heading
        const faqHeaders = Array.from(element.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div'));
        for (const header of faqHeaders) {
            if (header.textContent && header.textContent.trim() === 'Frequently asked questions') {
                // Find the containing section. 
                // CAUTION: Do not go too high up. 
                // eesel.ai structure: section > div > h2
                const faqContainer = header.closest('section');

                // If the section is too large (likely the whole article), fallback to strict parent usage
                // or try to find the specific wrapper class if known, but safer to assume the section is correct if distinct
                // On eesel.ai, the FAQ is in its own <section> at the bottom.
                if (faqContainer && faqContainer !== element) {
                    // Check if this section contains the main article content (heuristic: very long text)
                    // If it contains > 5000 chars, it's probably the main wrapper, don't delete.
                    if (faqContainer.innerText.length < 5000) {
                        elementsToRemove.push(faqContainer);
                    } else {
                        // Fallback: delete the header and its immediate siblings/parent
                        const parent = header.parentElement;
                        if (parent && parent.innerText.length < 5000) {
                            elementsToRemove.push(parent);
                        }
                    }
                }
            }
        }

        // Remove collected elements
        elementsToRemove.forEach(el => {
            if (el.parentNode) {
                el.remove();
            }
        });
    }
}

/**
 * Parse content blocks from an element.
 */
export function parseBlocks(element: HTMLElement): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const children = element.children;

    for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement;
        const tagName = child.tagName.toLowerCase();

        let type: ContentBlock['type'] = 'other';
        let level: number | undefined;

        if (/^h[1-6]$/.test(tagName)) {
            type = 'heading';
            level = parseInt(tagName[1], 10);
        } else if (tagName === 'p') {
            type = 'paragraph';
        } else if (tagName === 'ul' || tagName === 'ol') {
            type = 'list';
        } else if (tagName === 'blockquote') {
            type = 'quote';
        } else if (tagName === 'pre' || tagName === 'code') {
            type = 'code';
        } else if (tagName === 'img' || child.querySelector('img')) {
            type = 'image';
        }

        if (!child.innerHTML.trim()) continue;

        blocks.push({
            id: generateId(),
            type,
            html: child.outerHTML,
            text: child.innerText || '',
            level,
        });
    }

    return blocks;
}
