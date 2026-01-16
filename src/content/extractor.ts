/**
 * Content Extractor Module
 * 
 * Handles extracting content from web pages using different strategies
 * for different page types (WeChat, general articles).
 */

import { ExtractResult, ContentBlock } from '../types';
import { generateId, isWeixinArticle, getDomain, stripHtml } from '../utils/helpers';
import { extractImages } from './images';

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

        // Use specific extractor for WeChat articles
        if (isWeixinArticle(url)) {
            console.log('[extractor] 📱 Detected WeChat article');
            result = extractWeixinContent(url, domain);
        } else {
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
 * General article extraction using Readability-like approach.
 */
export function extractWithReadability(url: string, domain: string): ExtractResult {
    const documentClone = document.cloneNode(true) as Document;
    const article = extractArticle(documentClone);

    const title = article.title || document.title;
    const contentHtml = article.content || '';

    // For image extraction, prefer .available-content on Substack to avoid avatars/UI
    // Use the LIVE document for image extraction, not the clone
    let imageEl: HTMLElement;
    const isSubstack = domain.includes('substack') || url.includes('substack.com') ||
        document.querySelector('.available-content') !== null;

    if (isSubstack) {
        // Substack: strictly use .available-content for images, fall back to article.imageElement
        const availableContent = document.querySelector('.available-content') as HTMLElement;
        if (availableContent) {
            console.log(`[extractor] 🎯 Substack: using .available-content for images (${availableContent.querySelectorAll('img').length} images)`);
            imageEl = availableContent;
        } else {
            console.log(`[extractor] ⚠️ Substack but no .available-content, using fallback`);
            imageEl = article.imageElement || article.contentElement || document.body;
        }
    } else {
        imageEl = article.imageElement || article.contentElement || document.body;
    }

    console.log(`[extractor] 📷 Image extraction from: ${imageEl.tagName}.${imageEl.className?.split(' ')[0] || 'no-class'}`);
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
    const articleSelectors = [
        '.available-content',
        '.newsletter-post',
        'article',
        '[role="main"]',
        '.post-content',
        '.article-content',
        '.entry-content',
        '.content',
        'main',
        '#content',
        '.post',
        '.article',
    ];

    let contentElement: HTMLElement | null = null;

    for (const selector of articleSelectors) {
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
    const authorSelectors = ['[rel="author"]', '.author', '.byline', '[itemprop="author"]', '.post-author'];
    let author: string | undefined;
    for (const selector of authorSelectors) {
        const el = doc.querySelector(selector) as HTMLElement;
        if (el?.innerText) {
            author = el.innerText.trim();
            break;
        }
    }

    // Extract publish time
    const timeSelectors = ['time[datetime]', '[itemprop="datePublished"]', '.published', '.post-date', '.date'];
    let publishTime: string | undefined;
    for (const selector of timeSelectors) {
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
    const junkSelectors = [
        '.advertisement', '.ads', '.social-share', '.comments', '.related-posts',
        '[aria-hidden="true"]', 'iframe[src*="ads"]',
        // Substack specific
        '.post-ufi', '.like-button-container', '.share-dialog',
        '.subscription-widget-wrap', '.substack-post-footer',
        '.post-header', '.post-ufi-button', '.pencraft.style-button',
        '.portable-archive-header', '.banner', '.post-footer',
        '.profile-hover-card', '.user-hover-card', '.pencraft',
        // Comment sections
        '.vssue', '.vssue-container', '.gitalk-container', '.gitalk',
        '.giscus', '.giscus-frame', '.utterances', '.disqus_thread', '#disqus_thread',
        '.comment-section', '#comments', '[class*="comment"]',
        // VuePress/VitePress
        '.page-edit', '.page-nav', '.page-meta', '.last-updated',
        // Header anchors
        'a.header-anchor', 'a.heading-anchor', 'a.anchor', '.header-anchor',
        // Twitter/X
        '[data-testid="User-Name"]', '[data-testid="UserName"]', '[data-testid="User-Names"]',
        '[data-testid="subscribe"]', '[data-testid="reply"]', '[data-testid="retweet"]',
        '[data-testid="like"]', '[data-testid="bookmark"]', '[data-testid="share"]',
        '[data-testid="analyticsButton"]', '[data-testid="app-text-transition-container"]',
        '[class*="engagement-bar"]', '[class*="reactions-bar"]',
        '[class*="like-count"]', '[class*="retweet-count"]', '[class*="reply-count"]',
        '[class*="share-count"]', '[class*="view-count"]',
        '[class*="subscribe-button"]', '[class*="follow-button"]',
        // Medium specific - Author info, engagement, reading time
        '[data-testid="authorPhoto"]',           // Author avatar
        'img[data-testid="authorPhoto"]',        // Author avatar img
        '[data-testid="storyPublishDate"]',      // Publish date
        'button[aria-label="responses"]',        // Comments button
        'button[data-testid="headerClapButton"]', // Clap button
        'svg[aria-label="clap"]',                // Clap icon
        '[data-testid="headerSocialShareButton"]', // Share buttons
        '[data-testid="audioPlayButton"]',       // Listen to article button
        '.speechify-ignore',                       // Medium audio wrapper
        // Medium author byline patterns (div containing author link + read time)
        'a[href*="/@"][rel="noopener follow"]', // Author link in byline
        // Video players
        'video', '.video-player', '.video-container', '.video_iframe', '.video_card',
        '[class*="video-player"]', '[class*="video-controls"]', '[class*="video-bar"]',
        // WeChat video
        '.js_tx_video_container', '.js_video_channel_video', '.video_channel_card_container',
        '.video_card_container', '.mpvideosnap_container', '.video_info_wrap',
        '.video_desc', '.video_channel', '.video_player_container', '.js_video_container',
        '.wx-video', '[class*="video_channel"]', '[class*="mpvideo"]', '[class*="wxvideo"]',
        '.video_play_btn', '.video_progress', '.video_time', '.video_fullscreen',
        '.video_speed', '.video_share', '.video_replay', '.video_attention',
        // WeChat author follow
        '.profile_info_area', '.profile_meta', '.wx_follow_btn', '.js_share_content',
        '[class*="follow"]', '[class*="subscribe"]',
        // iframes
        'iframe:not([src*="mp.weixin"])',
        // eesel.ai specific - FAQ section, author metadata, breadcrumbs
        // CAUTION: Do NOT use generic class selectors like [class*="faq"] or [class*="component-margin-bottom"]
        // because the main article container often has these classes (e.g. via Tailwind modifiers like [&_.faqWrapper]),
        // causing the ENTIRE ARTICLE to be deleted.
        // We will handle FAQ removal via text pattern matching in step 3 below.
    ];

    for (const selector of junkSelectors) {
        element.querySelectorAll(selector).forEach((el) => el.remove());
    }

    // 2. Remove Structural Elements (Headers, Footers, Nav) - Only if aggressive
    // These might contain main images, so be careful when extracting images.
    if (aggressive) {
        const structuralSelectors = [
            'script', 'style', 'nav', 'header', 'footer', 'aside'
        ];
        for (const selector of structuralSelectors) {
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
        const textPatterns = [
            /^(written by|reviewed by|edited by|posted by)\s*$/i,
            /^(last edited|last updated|published on)\s*\w+\s+\d+,?\s*\d*$/i,
            /^expert verified$/i,
            /^(blogs?|guides?|articles?)\s*[\/|]\s*(blogs?|guides?|articles?)?$/i,
        ];

        const elementsToRemove: HTMLElement[] = [];

        // General text pattern removal
        element.querySelectorAll('div, span, p, a').forEach((el) => {
            const text = (el.textContent || '').trim();
            // Only match small elements (less than 100 chars) to avoid removing large content blocks
            if (text.length > 0 && text.length < 100) {
                for (const pattern of textPatterns) {
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
