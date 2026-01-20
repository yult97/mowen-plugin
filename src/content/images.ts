/**
 * Image Extraction Module
 * 
 * Handles extracting images from the DOM, filtering non-content images,
 * and preparing image candidates for processing.
 */

import { ImageCandidate } from '../types';
import { generateId } from '../utils/helpers';
import { normalizeImageUrl } from './imageNormalizer';
import {
    IMAGE_EXCLUDE_PARENT_SELECTORS,
    AVATAR_CLASS_KEYWORDS,
    AVATAR_CLASS_ONLY_KEYWORDS,
    AVATAR_ALT_PATTERNS,
    DECORATIVE_ALT_PATTERNS
} from '../config/site-selectors';

/**
 * 获取图片的可见说明文字（用户在网页上能看到的）
 * 只提取 figcaption 等可见元素，不使用 alt 属性（alt 在页面上不可见）
 * 
 * @param img 图片元素
 * @returns 可见的图片说明，如果没有则返回空字符串
 */
function getVisibleCaption(img: HTMLImageElement): string {
    // 1. 检查是否在 <figure> 中，并查找 <figcaption>
    const figure = img.closest('figure');
    if (figure) {
        const figcaption = figure.querySelector('figcaption');
        if (figcaption) {
            const text = figcaption.textContent?.trim();
            if (text) {
                console.log(`[images] found visible caption (figcaption): "${text.substring(0, 50)}..."`);
                return text;
            }
        }
    }

    // 2. 不使用 alt 属性，因为它在页面上不可见
    // alt 属性只有在图片加载失败时才会显示给用户

    return '';
}

/**
 * Extract images from a container element, filtering out non-content images.
 */
export function extractImages(container: HTMLElement): ImageCandidate[] {
    const images: ImageCandidate[] = [];
    const seen = new Set<string>();
    let order = 0;

    // Selectors for non-content image containers (avatars, author bios, social, etc.)
    const excludeParentSelectors = IMAGE_EXCLUDE_PARENT_SELECTORS;

    // Check if an image should be excluded based on its context
    function shouldExcludeImage(img: HTMLImageElement): boolean {
        // Medium specific: exclude author photo
        if (img.getAttribute('data-testid') === 'authorPhoto') {
            console.log(`[images] excluding: Medium authorPhoto`);
            return true;
        }

        // Check image's own class/alt for avatar indicators
        const imgClass = (img.className || '').toLowerCase();
        const imgAlt = (img.alt || '').toLowerCase();
        const imgSrc = (img.src || '').toLowerCase();

        // Medium specific: exclude resize:fill (typically avatars) and small resize params
        if (imgSrc.includes('miro.medium.com')) {
            // resize:fill is used for avatars, resize:fit is for content images
            if (imgSrc.includes('resize:fill')) {
                console.log(`[images] excluding: Medium resize:fill (avatar pattern)`);
                return true;
            }
            // Check for small resize dimensions (e.g., resize:fit:64, resize:fit:88)
            const sizeMatch = imgSrc.match(/resize:[^/]+:(\d+)/);
            if (sizeMatch && parseInt(sizeMatch[1]) <= 100) {
                console.log(`[images] excluding: Medium small resize (${sizeMatch[1]}px)`);
                return true;
            }
        }

        // Check class for keywords (exact word match for class names)
        for (const keyword of AVATAR_CLASS_KEYWORDS) {
            if (imgClass.includes(keyword)) {
                console.log(`[images] excluding: class contains "${keyword}"`);
                return true;
            }
        }

        // Check class-only keywords
        for (const keyword of AVATAR_CLASS_ONLY_KEYWORDS) {
            if (imgClass.includes(keyword)) {
                console.log(`[images] excluding: class contains "${keyword}"`);
                return true;
            }
        }

        // Check alt for very specific avatar patterns (literal words, not substrings)
        for (const pattern of AVATAR_ALT_PATTERNS) {
            if (pattern.test(imgAlt)) {
                console.log(`[images] excluding: alt matches avatar pattern "${pattern.source}"`);
                return true;
            }
        }

        // Check alt for decorative/background image patterns
        for (const pattern of DECORATIVE_ALT_PATTERNS) {
            if (pattern.test(imgAlt)) {
                console.log(`[images] excluding: alt matches decorative pattern "${pattern.source}"`);
                return true;
            }
        }

        // Check if image is very small (likely an icon or avatar)
        const rect = img.getBoundingClientRect();
        const rectWidth = rect.width;
        const rectHeight = rect.height;
        const naturalWidth = img.naturalWidth || 0;
        const naturalHeight = img.naturalHeight || 0;
        // Also check attributes as fallback (crucial for unloaded images)
        const attrWidth = parseInt(img.getAttribute('width') || '0', 10);
        const attrHeight = parseInt(img.getAttribute('height') || '0', 10);

        const effectiveWidth = naturalWidth > 0 ? naturalWidth : (rectWidth > 0 ? rectWidth : attrWidth);
        const effectiveHeight = naturalHeight > 0 ? naturalHeight : (rectHeight > 0 ? rectHeight : attrHeight);

        // Filter small images (icons, avatars)
        // Adjusted to 50px to ensure legitimate small content images (like badges, pixel art) are not filtered,
        // while still catching standard UI icons (usually 16, 24, 32, 48px).
        if (effectiveWidth > 0 && effectiveHeight > 0 && effectiveWidth <= 50 && effectiveHeight <= 50) {
            console.log(`[images] excluding: small size (${effectiveWidth}x${effectiveHeight})`);
            return true;
        }

        // Check if image or parent is circular (avatar indicator)
        // Increased depth to 5 for sites like eesel.ai where avatar containers are deeper
        let element: HTMLElement | null = img;
        let depth = 0;
        while (element && depth < 5) {
            const hasRoundedFull = element.classList?.contains('rounded-full') ||
                element.classList?.contains('rounded-circle') ||
                element.classList?.contains('circle');

            if (hasRoundedFull) {
                console.log(`[images] excluding: rounded-full/circle class at depth ${depth}`);
                return true;
            }

            // Check for overflow-hidden with small fixed dimensions (common avatar pattern)
            // e.g., "relative w-10 h-10 rounded-full overflow-hidden" on eesel.ai
            const hasOverflowHidden = element.classList?.contains('overflow-hidden');
            if (hasOverflowHidden) {
                // Check if this container also has small fixed dimensions
                const classList = element.className || '';
                const hasSmallFixedSize = /\bw-(8|9|10|11|12|14|16)\b/.test(classList) &&
                    /\bh-(8|9|10|11|12|14|16)\b/.test(classList);
                if (hasSmallFixedSize) {
                    console.log(`[images] excluding: overflow-hidden with small fixed size at depth ${depth}`);
                    return true;
                }
            }

            // Check for small Tailwind size classes (expanded range to include more avatar sizes)
            const smallWidthClasses = ['w-4', 'w-5', 'w-6', 'w-7', 'w-8', 'w-9', 'w-10', 'w-11', 'w-12', 'w-14', 'w-16'];
            const smallHeightClasses = ['h-4', 'h-5', 'h-6', 'h-7', 'h-8', 'h-9', 'h-10', 'h-11', 'h-12', 'h-14', 'h-16'];
            const hasSmallTailwindClass = smallWidthClasses.some(c => element!.classList?.contains(c)) ||
                smallHeightClasses.some(c => element!.classList?.contains(c));
            if (hasSmallTailwindClass) {
                console.log(`[images] excluding: Tailwind small size class at depth ${depth}`);
                return true;
            }

            // Check border-radius
            const style = window.getComputedStyle(element);
            const borderRadius = style.borderRadius;
            if (borderRadius === '50%' || borderRadius === '9999px' || borderRadius === '100%') {
                console.log(`[images] excluding: circular via border-radius at depth ${depth}`);
                return true;
            }

            // Check for square images with rounded corners in author sections
            // Common pattern: author bio photo with rounded-md, size 150-300px square
            // Check both the image itself AND parent elements for rounded classes
            const hasRoundedMd = element.classList?.contains('rounded-md') ||
                element.classList?.contains('rounded-lg') ||
                element.classList?.contains('rounded-xl');

            if (hasRoundedMd && depth <= 3) {
                // Check if it's a square image in typical author photo size range
                const w = img.naturalWidth || img.width || 0;
                const h = img.naturalHeight || img.height || 0;
                const isSquare = w > 0 && h > 0 && Math.abs(w - h) < 20; // Allow 20px tolerance
                const isAuthorPhotoSize = w >= 100 && w <= 300;

                if (isSquare && isAuthorPhotoSize) {
                    // Additional check: is the alt text author-like?
                    const altLower = (img.alt || '').toLowerCase();
                    const isAuthorAlt = altLower.includes('undefined') || // Common pattern: "Stevia undefined"
                        /^[a-z]+\s*$/.test(altLower.trim()) || // Just a name
                        /^[a-z]+\s+[a-z]+\s*$/i.test(altLower.trim()); // First Last name pattern

                    if (isAuthorAlt) {
                        console.log(`[images] excluding: square rounded author photo (${w}x${h}, alt="${img.alt}", depth=${depth})`);
                        return true;
                    }
                }
            }

            element = element.parentElement;
            depth++;
        }

        // Check if parent element matches exclude selectors
        let parent = img.parentElement;
        depth = 0;
        while (parent && depth < 5) {
            for (const selector of excludeParentSelectors) {
                try {
                    if (parent.matches(selector)) {
                        console.log(`[images] excluding: parent matches "${selector}"`);
                        return true;
                    }
                } catch {
                    // Invalid selector, skip
                }
            }

            // Check parent's text content for author-related keywords
            // Only match in SMALL containers (typical author bylines are 50-300 chars)
            const parentText = (parent.textContent || '').toLowerCase();

            // Conservative author patterns - only very specific phrases
            const authorTextPatterns = [
                'written by', 'reviewed by', 'article by', 'posted by',
                'author:', 'by author', 'about the author'
            ];

            for (const pattern of authorTextPatterns) {
                // Only match if container is small (50-300 chars) - typical byline size
                if (parentText.includes(pattern) && parentText.length > 50 && parentText.length < 300) {
                    console.log(`[images] excluding: near author byline text "${pattern}" (len=${parentText.length})`);
                    return true;
                }
            }

            parent = parent.parentElement;
            depth++;
        }

        // Check if URL contains avatar/profile indicators
        const avatarUrlPatterns = ['/avatar', '/profile', '/user/', '/authors/', '/team/', 'gravatar.com', 'githubusercontent.com/u/'];
        for (const pattern of avatarUrlPatterns) {
            if (imgSrc.includes(pattern)) {
                console.log(`[images] excluding: URL contains "${pattern}"`);
                return true;
            }
        }

        return false;
    }

    // 1. Extract from <img> elements
    const imgElements = container.querySelectorAll('img');
    imgElements.forEach((img) => {
        if (shouldExcludeImage(img)) {
            return;
        }

        const urls = getImageUrls(img);
        urls.forEach((urlInfo) => {
            // Use normalizedUrl as the key for deduplication
            // This ensures same image with different resize params isn't duplicated
            if (!seen.has(urlInfo.normalizedUrl)) {
                seen.add(urlInfo.normalizedUrl);

                // 提取可见的图片说明（figcaption），而不是不可见的 alt 属性
                // figcaption 是用户在网页上可以看到的图片说明
                const visibleCaption = getVisibleCaption(img);

                images.push({
                    id: generateId(),
                    url: urlInfo.originalUrl,           // Original URL for HTML matching
                    normalizedUrl: urlInfo.normalizedUrl, // Normalized URL for upload
                    kind: urlInfo.kind,
                    order: order++,
                    inMainContent: true,
                    width: img.naturalWidth || img.width || undefined,
                    height: img.naturalHeight || img.height || undefined,
                    // 使用可见说明（figcaption）而非 alt 属性
                    alt: visibleCaption || undefined,
                });
            }
        });
    });

    // 2. Extract from <picture> elements
    const pictureElements = container.querySelectorAll('picture source');
    pictureElements.forEach((source) => {
        const srcset = source.getAttribute('srcset');
        if (srcset) {
            const parsed = parseSrcsetWithOriginal(srcset);
            if (parsed && !seen.has(parsed.normalizedUrl)) {
                seen.add(parsed.normalizedUrl);
                images.push({
                    id: generateId(),
                    url: parsed.originalUrl,
                    normalizedUrl: parsed.normalizedUrl,
                    kind: 'srcset',
                    order: order++,
                    inMainContent: true,
                });
            }
        }
    });

    // 3. Extract from background images
    const allElements = container.querySelectorAll('*');
    allElements.forEach((el) => {
        const style = window.getComputedStyle(el as HTMLElement);
        const bgImage = style.backgroundImage;
        if (bgImage && bgImage !== 'none') {
            const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
            if (urlMatch && urlMatch[1]) {
                const originalUrl = urlMatch[1];
                const normalized = normalizeImageUrl(originalUrl);
                if (!seen.has(normalized)) {
                    seen.add(normalized);
                    images.push({
                        id: generateId(),
                        url: originalUrl,
                        normalizedUrl: normalized,
                        kind: 'background',
                        order: order++,
                        inMainContent: true,
                    });
                }
            }
        }
    });

    // 4. Extract og:image
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    if (ogImage) {
        const normalizedOg = normalizeImageUrl(ogImage);
        if (!seen.has(normalizedOg)) {
            seen.add(normalizedOg);
            images.push({
                id: generateId(),
                url: ogImage,
                normalizedUrl: normalizedOg,
                kind: 'og',
                order: order++,
                inMainContent: false,
            });
        }
    }

    // 5. Extract preload images
    const preloadImages = document.querySelectorAll('link[rel="preload"][as="image"]');
    preloadImages.forEach((link) => {
        const href = link.getAttribute('href');
        if (href && !seen.has(href)) {
            seen.add(href);
            images.push({
                id: generateId(),
                url: href,
                normalizedUrl: normalizeImageUrl(href),
                kind: 'preload',
                order: order++,
                inMainContent: false,
            });
        }
    });

    console.log(`[images] candidates total=${images.length}`);

    // Filter: Only return images that have corresponding img tags in contentHtml
    const matchableImages = images.filter(img => {
        const matchableKinds = ['img', 'lazy', 'srcset'];
        const isMatchable = matchableKinds.includes(img.kind) && img.inMainContent;
        if (!isMatchable) {
            console.log(`[images] filtering out: kind=${img.kind}, inMainContent=${img.inMainContent}`);
        }
        return isMatchable;
    });

    console.log(`[images] filtered: matchable=${matchableImages.length}, filtered_out=${images.length - matchableImages.length}`);

    return matchableImages;
}

/**
 * Get the best image URL from an img element.
 * Returns both original URL (for HTML matching) and normalized URL (for upload).
 */
export function getImageUrls(img: HTMLImageElement): Array<{ originalUrl: string; normalizedUrl: string; kind: ImageCandidate['kind'] }> {
    // Priority: Return ONLY ONE URL per img element to avoid duplicate processing
    const lazyAttrs = [
        'data-src',
        'data-original',
        'data-url',
        'data-lazy',
        'data-actualsrc',
        'data-hires',
        'data-lazy-src',
    ];

    for (const attr of lazyAttrs) {
        const value = img.getAttribute(attr);
        if (value && isValidImageUrl(value) && !value.startsWith('data:')) {
            const normalized = normalizeImageUrl(value);
            console.log(`[images] using ${attr} original=${value.substring(0, 40)}... normalized=${normalized.substring(0, 40)}...`);
            return [{ originalUrl: value, normalizedUrl: normalized, kind: 'lazy' }];
        }
    }

    if (img.currentSrc && isValidImageUrl(img.currentSrc) && !img.currentSrc.startsWith('data:')) {
        const normalized = normalizeImageUrl(img.currentSrc);
        return [{ originalUrl: img.currentSrc, normalizedUrl: normalized, kind: 'img' }];
    }

    if (img.src && isValidImageUrl(img.src) && !img.src.startsWith('data:')) {
        const normalized = normalizeImageUrl(img.src);
        return [{ originalUrl: img.src, normalizedUrl: normalized, kind: 'img' }];
    }

    if (img.srcset) {
        const parsed = parseSrcsetWithOriginal(img.srcset);
        if (parsed && !parsed.originalUrl.startsWith('data:')) {
            return [{ originalUrl: parsed.originalUrl, normalizedUrl: parsed.normalizedUrl, kind: 'srcset' }];
        }
    }

    const dataSrcset = img.getAttribute('data-srcset');
    if (dataSrcset) {
        const parsed = parseSrcsetWithOriginal(dataSrcset);
        if (parsed && !parsed.originalUrl.startsWith('data:')) {
            return [{ originalUrl: parsed.originalUrl, normalizedUrl: parsed.normalizedUrl, kind: 'srcset' }];
        }
    }

    return [];
}


/**
 * Parse srcset to get the highest resolution URL.
 * Returns normalized URL only (for backward compatibility).
 */
export function parseSrcset(srcset: string): string | null {
    const result = parseSrcsetWithOriginal(srcset);
    return result ? result.normalizedUrl : null;
}

/**
 * Parse srcset to get both original and normalized URLs.
 * Returns the highest resolution URL from srcset.
 * 
 * IMPORTANT: Substack CDN URLs contain commas in their parameters (e.g., w_1456,c_limit,f_webp).
 * Simple split(',') breaks these URLs. We need to split by the descriptor pattern instead.
 */
export function parseSrcsetWithOriginal(srcset: string): { originalUrl: string; normalizedUrl: string } | null {
    // Srcset format: "URL1 1x, URL2 2x" or "URL1 100w, URL2 200w"
    // The URL may contain commas (like Substack CDN), so we can't just split by comma.
    // Instead, we split by the pattern: "descriptorValue, " where descriptorValue matches digits followed by w or x
    // E.g., "https://cdn.com/w_100,h_200/img.jpg 100w, https://cdn.com/w_200,h_400/img.jpg 200w"
    //       should split into ["https://cdn.com/w_100,h_200/img.jpg 100w", "https://cdn.com/w_200,h_400/img.jpg 200w"]

    // Regex: split at positions where we have "digits + (w|x), " pattern
    // This splits "URL 100w, URL2" into ["URL 100w", "URL2"]
    const parts = srcset.split(/(?<=\d[wx]),\s*/i).map((s) => s.trim());

    let maxWidth = 0;
    let bestUrl = '';

    for (const part of parts) {
        // Split URL from descriptor (last space-separated token)
        const lastSpaceIdx = part.lastIndexOf(' ');
        let url = part;
        let descriptor = '';

        if (lastSpaceIdx !== -1) {
            const potentialDescriptor = part.slice(lastSpaceIdx + 1);
            // Check if it matches descriptor pattern (digits + w/x)
            if (/^\d+[wx]$/i.test(potentialDescriptor)) {
                url = part.slice(0, lastSpaceIdx);
                descriptor = potentialDescriptor;
            }
        }

        if (!url) continue;

        const width = parseInt(descriptor?.replace(/[wx]/i, '') || '0', 10);
        if (width > maxWidth || !bestUrl) {
            maxWidth = width;
            bestUrl = url;
        }
    }

    if (!bestUrl) return null;

    return {
        originalUrl: bestUrl,
        normalizedUrl: normalizeImageUrl(bestUrl),
    };
}

/**
 * Check if a URL is a valid image URL.
 */
export function isValidImageUrl(url: string): boolean {
    if (!url) return false;
    if (url.startsWith('data:image/')) return true;
    if (url.startsWith('blob:')) return true;

    try {
        const parsed = new URL(url, window.location.href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
