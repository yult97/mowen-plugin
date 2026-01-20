/**
 * Image Fetcher
 * 
 * Provides multiple strategies for fetching images as base64 data
 * for message passing through Chrome extension APIs.
 */

/**
 * Fetch image as base64 encoded string for message passing.
 * This is needed because Blob objects cannot be passed through chrome.runtime.sendMessage.
 * 
 * Enhanced for WeChat (mmbiz.qpic.cn) images with multiple fallback strategies.
 */
export async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
    console.log('[imageFetcher] fetchImageAsBase64 start:', url.substring(0, 80));

    // Check image type
    const isWeixinImage = url.includes('mmbiz.qpic.cn') || url.includes('mmbiz.qlogo.cn');
    const isTwitterImage = url.includes('pbs.twimg.com') || url.includes('twimg.com');

    try {
        let blob: Blob | null = null;

        // Strategy 0: For Twitter images, try to find loaded image first (avoids CORS issues)
        if (isTwitterImage) {
            console.log('[imageFetcher] Twitter image detected, trying loaded image first');
            try {
                blob = await fetchFromLoadedImage(url);
                if (blob && blob.size > 0) {
                    console.log('[imageFetcher] Twitter loaded image fetch ok, size:', blob.size);
                } else {
                    blob = null;
                }
            } catch (e) {
                console.log('[imageFetcher] Twitter loaded image fetch failed:', e);
            }
        }

        // Strategy 1: For WeChat images, try canvas approach first (it can capture loaded images)
        if (isWeixinImage) {
            console.log('[imageFetcher] WeChat image detected, trying canvas first');
            try {
                blob = await fetchViaCanvas(url);
                if (blob && blob.size > 0) {
                    console.log('[imageFetcher] WeChat canvas fetch ok, size:', blob.size);
                } else {
                    blob = null;
                }
            } catch (e) {
                console.log('[imageFetcher] WeChat canvas fetch failed:', e);
            }
        }

        // Strategy 2: Try without credentials first (better for CDNs like Twitter pbs.twimg.com)
        if (!blob || blob.size === 0) {
            try {
                const response = await fetch(url, {
                    mode: 'cors',
                    credentials: 'omit',
                });
                if (response.ok) {
                    blob = await response.blob();
                    console.log('[imageFetcher] no-cred fetch ok, size:', blob.size);
                }
            } catch (e) {
                console.log('[imageFetcher] no-cred fetch failed:', e);
            }
        }

        // Strategy 3: Direct fetch with credentials (for same-origin or sites that require auth)
        if (!blob || blob.size === 0) {
            try {
                const response = await fetch(url, {
                    mode: 'cors',
                    credentials: 'include',
                    headers: {
                        'Accept': 'image/*,*/*;q=0.8',
                    },
                });
                if (response.ok) {
                    blob = await response.blob();
                    console.log('[imageFetcher] with-cred fetch ok, size:', blob.size);
                }
            } catch (e) {
                console.log('[imageFetcher] with-cred fetch failed:', e);
            }
        }

        // Strategy 4: Try XHR approach (sometimes works better for cross-origin)
        if (!blob || blob.size === 0) {
            try {
                blob = await fetchViaXHR(url);
                if (blob && blob.size > 0) {
                    console.log('[imageFetcher] XHR fetch ok, size:', blob.size);
                }
            } catch (e) {
                console.log('[imageFetcher] XHR fetch failed:', e);
            }
        }

        // Strategy 5: Canvas approach for non-WeChat images (already tried for WeChat above)
        if (!isWeixinImage && (!blob || blob.size === 0)) {
            console.log('[imageFetcher] trying canvas approach');
            try {
                blob = await fetchViaCanvas(url);
                if (blob && blob.size > 0) {
                    console.log('[imageFetcher] canvas fetch ok, size:', blob.size);
                }
            } catch (e) {
                console.log('[imageFetcher] canvas fetch failed:', e);
            }
        }

        // Strategy 6: Try to find the image already loaded on the page
        if (!blob || blob.size === 0) {
            console.log('[imageFetcher] trying to find loaded image');
            try {
                blob = await fetchFromLoadedImage(url);
                if (blob && blob.size > 0) {
                    console.log('[imageFetcher] loaded image fetch ok, size:', blob.size);
                }
            } catch (e) {
                console.log('[imageFetcher] loaded image fetch failed:', e);
            }
        }

        if (!blob || blob.size === 0) {
            console.log('[imageFetcher] all strategies failed for:', url.substring(0, 60));
            return null;
        }

        // Convert blob to base64
        const base64 = await blobToBase64(blob);
        const mimeType = blob.type || 'image/jpeg';

        console.log('[imageFetcher] success, base64 length:', base64.length);
        return { base64, mimeType };
    } catch (error) {
        console.error('[imageFetcher] error:', error);
        return null;
    }
}

/**
 * Fetch image via XHR (sometimes works better for cross-origin requests)
 */
async function fetchViaXHR(url: string): Promise<Blob | null> {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'blob';
        xhr.timeout = 10000;

        xhr.onload = () => {
            if (xhr.status === 200) {
                resolve(xhr.response as Blob);
            } else {
                resolve(null);
            }
        };

        xhr.onerror = () => resolve(null);
        xhr.ontimeout = () => resolve(null);

        try {
            xhr.send();
        } catch {
            resolve(null);
        }
    });
}

/**
 * Try to find and capture an already-loaded image from the page
 * Enhanced with fuzzy URL matching for Twitter/X images
 */
async function fetchFromLoadedImage(url: string): Promise<Blob | null> {
    // Extract base URL path for fuzzy matching (remove query params for Twitter)
    const getBaseUrl = (u: string): string => {
        try {
            const urlObj = new URL(u);
            // For Twitter images, use pathname as base
            if (urlObj.host.includes('twimg.com')) {
                return urlObj.pathname;
            }
            // For other URLs, use full URL without query
            return urlObj.origin + urlObj.pathname;
        } catch {
            return u;
        }
    };

    const targetBase = getBaseUrl(url);
    console.log('[imageFetcher] fetchFromLoadedImage: looking for base:', targetBase.substring(0, 60));

    // Find all images that match this URL
    const images = document.querySelectorAll('img');
    for (const img of images) {
        // Get all possible source URLs for this image
        const candidateUrls = [
            img.src,
            img.currentSrc,
            img.getAttribute('data-src'),
            img.getAttribute('data-original'),
            img.getAttribute('data-actualsrc'),
        ].filter(Boolean) as string[];

        // Check if any candidate matches our target
        const matchesUrl = candidateUrls.some(candidateUrl => {
            // Exact match
            if (candidateUrl === url) return true;
            // Fuzzy match (same base path)
            const candidateBase = getBaseUrl(candidateUrl);
            return candidateBase === targetBase;
        });

        if (matchesUrl && img.complete && img.naturalWidth > 0) {
            // Image is loaded, draw to canvas
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(img, 0, 0);
                    return new Promise((resolve) => {
                        canvas.toBlob((blob) => {
                            if (blob && blob.size > 0) {
                                console.log('[imageFetcher] fetchFromLoadedImage: success via canvas, size:', blob.size);
                            }
                            resolve(blob);
                        }, 'image/png');
                    });
                }
            } catch (e) {
                // Canvas tainted, skip
                console.log('[imageFetcher] fetchFromLoadedImage: canvas tainted for:', url.substring(0, 40));
            }
        }
    }
    return null;
}

/**
 * Fetch image via canvas (works for same-origin and some CORS images)
 */
async function fetchViaCanvas(url: string): Promise<Blob | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0);
                canvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/png');
            } catch (e) {
                console.log('[imageFetcher] fetchViaCanvas: canvas error:', e);
                resolve(null);
            }
        };

        img.onerror = () => {
            resolve(null);
        };

        // Set timeout
        setTimeout(() => resolve(null), 10000);

        img.src = url;
    });
}

/**
 * Convert Blob to base64 string
 */
export async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            // Remove data URL prefix if present (e.g., "data:image/png;base64,")
            const commaIdx = result.indexOf(',');
            if (commaIdx > 0) {
                resolve(result.substring(commaIdx + 1));
            } else {
                resolve(result);
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
