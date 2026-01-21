/**
 * Content Extractor Module
 * 
 * Handles extracting content from web pages using different strategies
 * for different page types (WeChat, general articles).
 */

import { Readability } from '@mozilla/readability';
import { ExtractResult, ContentBlock } from '../types';
import { generateId, isWeixinArticle, getDomain, stripHtml } from '../utils/helpers';
import { extractImages } from './images';
import { isTwitterPage, extractTwitterContent } from './twitterExtractor';
// import { normalizeReadabilityHtml } from './extractor-utils'; // Defined internally

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

    const title = titleEl?.innerText?.trim() || document.title;
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
    const title = article.title || document.title;
    const author = article.byline || undefined;

    // 5. 智能注入首图 (Smart Hero Image Injection)
    // 不再使用 Meta 标签注入 (a16z 痛点)，改为探测标题附近的 DOM 图片 (baoyu.io 需求)。
    // 仅当 Readability 漏掉且图片确实在标题附近时注入。
    const nearbyImage = extractImageNearTitle(document, title);

    if (nearbyImage && !contentHtml.includes(nearbyImage.src)) {
        console.log(`[extractor] 🖼️ Injecting detected header image: ${nearbyImage.src}`);
        const imgHtml = `<figure class="hero-image"><img src="${nearbyImage.src}" alt="${nearbyImage.alt || 'Header Image'}" /></figure>`;
        contentHtml = imgHtml + contentHtml;
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
}

// function extractHeroImage removed

/**
 * 尝试在标题附近探测图片（智能补全）
 * 策略：
 * 1. 找到文章标题 (H1)
 * 2. 在标题紧邻的兄弟节点或子节点中寻找显著大图
 * 3. 这种图通常是文章的“封面”或“首图”，如果 Readability 漏掉了，值得补回
 */
function extractImageNearTitle(doc: Document, articleTitle: string): { src: string, alt?: string } | null {
    if (!articleTitle) return null;

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
    // 不再局限于 parent，而是从全文（或主要区域）中寻找 Title 之后的图片
    // 这样可以应对 Title 和 Image 分属不同容器的情况
    const rootContext = document.querySelector('article') || document.querySelector('main') || document.body;
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

    // 1. Unwrap layout divs (divs that just contain other block elements or text)
    // simple logic: if a div has no attributes (cleaned by Readability?) or just class,
    // and contains block elements, maybe unwrap?
    // Actually Readability output is usually cleanish, but might have nested divs.
    // Let's strip classes 'page', 'content', 'entry-content' etc wrapper divs if they exist inside.

    const divWrapperSelectors = ['div#page', 'div#content', 'div.entry-content', 'div.article-content'];
    divWrapperSelectors.forEach(sel => {
        const el = body.querySelector(sel);
        if (el) {
            // If the wrapper is the only child or main wrapper, replace parent with children
            // Hard to do strictly without breaking layout.
            // Let's rely on stripHtml-like logic or simpler cleaning.
        }
    });

    // Strategy: Remove all <div> tags but keep their children. 
    // noteAtom parses <p>, <ul>, etc. Divs usually just add spacing/grouping.
    // BUT we need to be careful about divs that ARE the content blocks (e.g. some sites use div instead of p).
    // Let's try converting divs that contain text directly into <p>.
    body.querySelectorAll('div').forEach(div => {
        // If div behaves like a text paragraph (no block children) -> turn to p
        const hasBlockChildren = div.querySelector('div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, table, pre, figure');
        if (!hasBlockChildren && div.textContent?.trim().length! > 0) {
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

    // 3. 【新增】清理冗余 HTML 属性，大幅减少 HTML 体积
    // 保留必要属性：href, src, alt, data-mowen-uid, width, height, target, rel
    // 移除：class, id, style, data-* (除 data-mowen-uid), contenteditable 等
    const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'data-mowen-uid', 'width', 'height', 'target', 'rel', 'srcset', 'data-src', 'data-original']);

    body.querySelectorAll('*').forEach(el => {
        const attrsToRemove: string[] = [];
        for (const attr of Array.from(el.attributes)) {
            if (!KEEP_ATTRS.has(attr.name)) {
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
 */
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
                let faqContainer = header.closest('section');

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
