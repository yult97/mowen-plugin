/**
 * Image URL Normalizer
 * 
 * Handles all known CDN/optimization proxy patterns to extract
 * the highest quality original image URL.
 */

/**
 * Main entry point: Normalize any image URL to its best form.
 * Chains all CDN unwrap functions and applies URL normalization.
 */
export function normalizeImageUrl(url: string): string {
    if (!url) return url;

    // Step 1: Resolve relative URLs to absolute
    url = resolveUrl(url);

    // Step 2: Normalize protocol (// -> https://)
    url = normalizeProtocol(url);

    // Step 3: Try unwrapping CDN proxies (order matters - most specific first)
    url = unwrapSubstackImage(url);
    url = unwrapTwitterImage(url);
    url = unwrapNextJsImage(url);
    url = unwrapCloudflareImage(url);
    url = unwrapImgixImage(url);
    url = unwrapCloudinaryImage(url);
    url = unwrapWordPressImage(url);
    url = unwrapMediumImage(url);
    url = unwrapShopifyImage(url);

    return url;
}

/**
 * Resolve relative URLs to absolute using current page location.
 */
export function resolveUrl(url: string): string {
    if (!url) return url;

    // Already absolute
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
        return url;
    }

    // Data URLs - return as-is
    if (url.startsWith('data:')) {
        return url;
    }

    // Resolve relative URL
    try {
        return new URL(url, window.location.href).href;
    } catch {
        return url;
    }
}

/**
 * Normalize protocol-relative URLs (//example.com -> https://example.com)
 */
export function normalizeProtocol(url: string): string {
    if (url.startsWith('//')) {
        return 'https:' + url;
    }
    return url;
}

/**
 * Substack: Extract original image from CDN proxy URL
 * Pattern: https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2F...
 * We want: https://substack-post-media.s3.amazonaws.com/...
 */
function unwrapSubstackImage(url: string): string {
    if (url.includes('substackcdn.com/image/fetch')) {
        try {
            // The real URL is encoded after the fetch options
            const match = url.match(/\/image\/fetch\/[^/]+\/(https?%3A%2F%2F[^?#]+)/i);
            if (match && match[1]) {
                const decoded = decodeURIComponent(match[1]);
                console.log('[imageNormalizer] Unwrapped Substack URL:', decoded.substring(0, 60));
                return decoded;
            }
            // Alternative pattern: /image/fetch/.../https://...
            const altMatch = url.match(/\/image\/fetch\/[^/]+\/(https?:\/\/[^?#]+)/i);
            if (altMatch && altMatch[1]) {
                console.log('[imageNormalizer] Unwrapped Substack URL (alt):', altMatch[1].substring(0, 60));
                return altMatch[1];
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Substack URL:', url);
        }
    }
    return url;
}

/**
 * Twitter/X: Optimize image quality by removing size parameters
 * Pattern: https://pbs.twimg.com/media/IMAGE_ID?format=jpg&name=medium
 * We want: https://pbs.twimg.com/media/IMAGE_ID?format=jpg&name=large (or orig)
 */
function unwrapTwitterImage(url: string): string {
    if (url.includes('pbs.twimg.com')) {
        try {
            const urlObj = new URL(url);
            // Get the best quality version
            const name = urlObj.searchParams.get('name');
            if (name && name !== 'orig' && name !== 'large') {
                urlObj.searchParams.set('name', 'large');
                console.log('[imageNormalizer] Optimized Twitter image to large quality');
                return urlObj.href;
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Twitter URL:', url);
        }
    }
    return url;
}

/**
 * Next.js Image Optimization: /_next/image?url=ENCODED_URL&w=...
 */
function unwrapNextJsImage(url: string): string {
    if (url.includes('/_next/image') || url.includes('_next/image')) {
        try {
            const urlObj = new URL(url);
            const realUrl = urlObj.searchParams.get('url');
            if (realUrl) {
                if (realUrl.startsWith('http')) {
                    return realUrl;
                }
                return new URL(realUrl, urlObj.origin).href;
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Next.js image URL:', url);
        }
    }
    return url;
}

/**
 * Cloudflare Image Resizing: /cdn-cgi/image/width=...,format=.../ORIGINAL_URL
 * Format: https://example.com/cdn-cgi/image/[options]/[original-path-or-url]
 */
function unwrapCloudflareImage(url: string): string {
    if (url.includes('/cdn-cgi/image/')) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            // Pattern: /cdn-cgi/image/options/actual/path
            const match = pathname.match(/\/cdn-cgi\/image\/[^/]+\/(.+)/);
            if (match && match[1]) {
                const realPath = match[1];
                // Check if it's a full URL or a path
                if (realPath.startsWith('http')) {
                    return decodeURIComponent(realPath);
                }
                return new URL('/' + realPath, urlObj.origin).href;
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Cloudflare image URL:', url);
        }
    }
    return url;
}

/**
 * Imgix: Remove resizing parameters to get original quality
 * Pattern: https://example.imgix.net/path?w=400&h=300&...
 */
function unwrapImgixImage(url: string): string {
    if (url.includes('.imgix.net') || url.includes('imgix.com')) {
        try {
            const urlObj = new URL(url);
            // Remove common Imgix transformation parameters
            const paramsToRemove = ['w', 'h', 'fit', 'crop', 'auto', 'q', 'dpr', 'blur'];
            paramsToRemove.forEach(p => urlObj.searchParams.delete(p));
            return urlObj.href;
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Imgix URL:', url);
        }
    }
    return url;
}

/**
 * Cloudinary: Extract original from transformation URL
 * Pattern: https://res.cloudinary.com/[cloud]/image/upload/[transformations]/[version]/[path]
 * We want: https://res.cloudinary.com/[cloud]/image/upload/[version]/[path]
 */
function unwrapCloudinaryImage(url: string): string {
    if (url.includes('res.cloudinary.com') || url.includes('cloudinary.com/')) {
        try {
            // Match pattern and extract parts
            const match = url.match(/(https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)([^/]+\/)*?(v\d+\/)?(.+)/);
            if (match) {
                const base = match[1];
                const version = match[3] || '';
                const path = match[4];
                // Reconstruct without transformations
                return base + version + path;
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Cloudinary URL:', url);
        }
    }
    return url;
}

/**
 * WordPress: Remove size suffixes like -150x150, -300x300, -1024x768
 * Pattern: image-300x200.jpg -> image.jpg
 */
function unwrapWordPressImage(url: string): string {
    // Only apply to wp-content paths or common WordPress patterns
    if (url.includes('wp-content/uploads') || url.includes('/uploads/')) {
        try {
            // Match -[width]x[height] before file extension
            const cleaned = url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
            if (cleaned !== url) {
                return cleaned;
            }
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse WordPress URL:', url);
        }
    }
    return url;
}

/**
 * Medium: Remove resize parameters
 * Pattern: https://miro.medium.com/v2/resize:fit:720/format:webp/IMAGE_ID
 * We want: https://miro.medium.com/v2/IMAGE_ID (original)
 */
function unwrapMediumImage(url: string): string {
    if (url.includes('miro.medium.com')) {
        try {
            // Remove resize and format transformations
            const cleaned = url
                .replace(/\/resize:[^/]+/, '')
                .replace(/\/format:[^/]+/, '')
                .replace(/\/v2\/+/, '/v2/'); // Clean up double slashes
            return cleaned;
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Medium URL:', url);
        }
    }
    return url;
}

/**
 * Shopify: Remove size parameters from CDN URLs
 * Pattern: cdn.shopify.com/.../product_image_500x.jpg -> product_image.jpg
 * Or: ?width=500&height=500 query params
 */
function unwrapShopifyImage(url: string): string {
    if (url.includes('cdn.shopify.com') || url.includes('shopify.com/s/files')) {
        try {
            const urlObj = new URL(url);
            // Remove size query params
            urlObj.searchParams.delete('width');
            urlObj.searchParams.delete('height');
            urlObj.searchParams.delete('crop');

            // Also handle _500x suffix in filename
            let pathname = urlObj.pathname;
            pathname = pathname.replace(/_\d+x(\d+)?(\.[a-zA-Z]+)$/, '$2');
            urlObj.pathname = pathname;

            return urlObj.href;
        } catch (e) {
            console.log('[imageNormalizer] Failed to parse Shopify URL:', url);
        }
    }
    return url;
}
