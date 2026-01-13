import { ExtractResult, ContentBlock, ImageCandidate } from '../types';
import { generateId, isWeixinArticle, getDomain, stripHtml } from '../utils/helpers';

// Cache for extracted content
let cachedExtractResult: ExtractResult | null = null;
let isExtracting = false;
let extractScheduled = false;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[墨问 Content] Received message:', message.type);

  // Handle PING message for health check (synchronous response)
  if (message.type === 'PING') {
    sendResponse({ success: true, status: 'ready' });
    return false; // Synchronous response, no need to keep channel open
  }

  if (message.type === 'GET_CACHED_CONTENT') {
    console.log('[墨问 Content] 💾 GET_CACHED_CONTENT request received');
    console.log('[墨问 Content] Cache status:', {
      hasCache: !!cachedExtractResult,
      isExtracting,
      extractScheduled,
    });

    // Return cached content if available (synchronous)
    if (cachedExtractResult) {
      console.log('[墨问 Content] ✅ Returning cached content');
      sendResponse({ success: true, data: cachedExtractResult, fromCache: true });
      return false; // Synchronous response
    } else if (isExtracting) {
      // Currently extracting, tell popup to wait (synchronous)
      console.log('[墨问 Content] ⏳ Extraction in progress, telling popup to wait');
      sendResponse({ success: true, data: null, extracting: true });
      return false; // Synchronous response
    } else {
      // No cache, trigger extraction (asynchronous)
      console.log('[墨问 Content] 🔄 No cache available, triggering extraction');
      extractContent()
        .then((result) => {
          console.log('[墨问 Content] ✅ Extraction completed, sending result');
          sendResponse({ success: true, data: result, fromCache: false });
        })
        .catch((error) => {
          console.error('[墨问 Content] ❌ Extraction failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async response
    }
  }

  if (message.type === 'EXTRACT_CONTENT') {
    extractContent()
      .then((result) => {
        console.log('[墨问 Content] Extraction successful, word count:', result.wordCount);
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        console.error('[墨问 Content] Extraction failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.type === 'FETCH_IMAGE') {
    console.log('[墨问 Content] 🖼️ FETCH_IMAGE request:', message.payload?.url?.substring(0, 60));
    fetchImageAsBase64(message.payload.url)
      .then((result) => {
        if (result) {
          console.log('[墨问 Content] ✅ FETCH_IMAGE success, size:', result.base64.length);
          sendResponse({ success: true, data: result });
        } else {
          console.log('[墨问 Content] ❌ FETCH_IMAGE failed: no result');
          sendResponse({ success: false, error: 'Failed to fetch image' });
        }
      })
      .catch((error) => {
        console.log('[墨问 Content] ❌ FETCH_IMAGE error:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Debug logging proxy
  if (message.type === 'LOG_DEBUG') {
    console.log(`[🔍 Extension Log] ${message.payload}`);
    sendResponse({ success: true });
    return false;
  }

  // Unknown message types - don't respond, don't keep channel open
  return false;
});

async function extractContent(): Promise<ExtractResult> {
  // Set extracting flag
  isExtracting = true;
  console.log('[墨问 Content] 🚀 Starting content extraction...');

  const url = window.location.href;
  const domain = getDomain(url);

  const startTime = Date.now();

  try {
    let result: ExtractResult;

    // Use specific extractor for WeChat articles
    if (isWeixinArticle(url)) {
      console.log('[墨问 Content] 📱 Detected WeChat article, using WeChat extractor');
      result = extractWeixinContent(url, domain);
    } else {
      console.log('[墨问 Content] 📄 Using general page extractor');
      // Use Readability for general pages
      result = extractWithReadability(url, domain);
    }

    // Cache the result
    cachedExtractResult = result;

    const elapsed = Date.now() - startTime;

    console.log('[墨问 Content] ✅ Content extracted and cached successfully!');
    console.log(`[cs] extracted: title=${result.title}, words=${result.wordCount}, images=${result.images.length}`);
    console.log('[墨问 Content] 📊 Extraction summary:', {
      title: result.title,
      wordCount: result.wordCount,
      images: result.images.length,
      blocks: result.blocks.length,
      author: result.author,
      domain: result.domain,
      timeElapsed: `${elapsed}ms`,
      cacheStatus: 'CACHED',
    });

    return result;
  } finally {
    isExtracting = false;
    console.log('[墨问 Content] Extraction flag cleared');
  }
}

function extractWeixinContent(url: string, domain: string): ExtractResult {
  // WeChat article specific selectors
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
    // Clone content to avoid modifying the page
    const contentClone = contentEl.cloneNode(true) as HTMLElement;

    // Process and clean content
    cleanContent(contentClone);

    contentHtml = contentClone.innerHTML;
    blocks = parseBlocks(contentClone);
  }

  // Extract images
  const images = extractImages(contentEl || document.body);

  // Calculate word count
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

function extractWithReadability(url: string, domain: string): ExtractResult {
  // Create a clone of the document for Readability
  const documentClone = document.cloneNode(true) as Document;

  // Try to use Readability-like extraction
  const article = extractArticle(documentClone);

  const title = article.title || document.title;
  const contentHtml = article.content || '';

  // Extract images from original content BEFORE cleaning
  // This preserves images that might be in containers removed by cleanContent
  const imageEl = article.imageElement || article.contentElement || document.body;
  const images = extractImages(imageEl);

  // Parse blocks
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = contentHtml;
  const blocks = parseBlocks(tempDiv);

  // Calculate word count
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

function extractArticle(doc: Document): {
  title: string;
  content: string;
  author?: string;
  publishTime?: string;
  contentElement?: HTMLElement;
  imageElement?: HTMLElement;  // For image extraction before cleaning
} {
  // Common article selectors
  const articleSelectors = [
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

  // Fallback to body if no article found
  if (!contentElement) {
    contentElement = doc.body;
  }

  // Clone for image extraction BEFORE cleaning (to preserve all images)
  const imageClone = contentElement.cloneNode(true) as HTMLElement;

  // Clone and clean for content extraction
  const clone = contentElement.cloneNode(true) as HTMLElement;
  cleanContent(clone);

  // Extract title from original document
  // Clone the title element to avoid modifying the original DOM
  const titleEl = doc.querySelector('h1') || doc.querySelector('title');
  let title = '';
  if (titleEl) {
    const titleClone = titleEl.cloneNode(true) as HTMLElement;
    // Remove anchor links (# symbols) from title
    titleClone.querySelectorAll('a.header-anchor, a.heading-anchor, a.anchor, .header-anchor').forEach(el => el.remove());
    title = titleClone.textContent?.trim() || '';
  }

  // Remove ALL h1 elements from cloned content to avoid title duplication
  // (api.ts will add the title as a separate h1 heading)
  const clonedH1s = clone.querySelectorAll('h1');
  clonedH1s.forEach(h1 => {
    // Clean anchor links from h1 for comparison
    const h1Clone = h1.cloneNode(true) as HTMLElement;
    h1Clone.querySelectorAll('a.header-anchor, a.heading-anchor, a.anchor, .header-anchor').forEach(el => el.remove());
    const h1Text = h1Clone.textContent?.trim() || '';
    // Remove if matches title (or if it's empty after cleaning)
    if (h1Text === title || h1Text === '') {
      h1.remove();
    }
  });

  // Try to extract author
  const authorSelectors = [
    '[rel="author"]',
    '.author',
    '.byline',
    '[itemprop="author"]',
    '.post-author',
  ];
  let author: string | undefined;
  for (const selector of authorSelectors) {
    const el = doc.querySelector(selector) as HTMLElement;
    if (el?.innerText) {
      author = el.innerText.trim();
      break;
    }
  }

  // Try to extract publish time
  const timeSelectors = [
    'time[datetime]',
    '[itemprop="datePublished"]',
    '.published',
    '.post-date',
    '.date',
  ];
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

function cleanContent(element: HTMLElement): void {
  // Remove unwanted elements
  const removeSelectors = [
    'script',
    'style',
    'nav',
    'header',
    'footer',
    'aside',
    '.advertisement',
    '.ads',
    '.social-share',
    '.comments',
    '.related-posts',
    '[aria-hidden="true"]',
    'iframe[src*="ads"]',
    // Comment sections (various comment plugins)
    '.vssue',
    '.vssue-container',
    '.gitalk-container',
    '.gitalk',
    '.giscus',
    '.giscus-frame',
    '.utterances',
    '.disqus_thread',
    '#disqus_thread',
    '.comment-section',
    '#comments',
    '[class*="comment"]',
    // VuePress/VitePress specific
    '.page-edit',
    '.page-nav',
    '.page-meta',
    '.last-updated',
    // Header anchor links (the # links before headings)
    'a.header-anchor',
    'a.heading-anchor',
    'a.anchor',
    '.header-anchor',
    // Twitter/X specific - profile info, subscribe buttons, engagement stats
    '[data-testid="User-Name"]',
    '[data-testid="UserName"]',
    '[data-testid="User-Names"]',
    '[data-testid="subscribe"]',
    '[data-testid="reply"]',
    '[data-testid="retweet"]',
    '[data-testid="like"]',
    '[data-testid="bookmark"]',
    '[data-testid="share"]',
    '[data-testid="analyticsButton"]',
    '[data-testid="app-text-transition-container"]',  // Engagement numbers
    // Note: Removed [role="group"] as it's too broad and removes images on Twitter
    // Social media engagement stats patterns (more specific)
    '[class*="engagement-bar"]',
    '[class*="reactions-bar"]',
    '[class*="like-count"]',
    '[class*="retweet-count"]',
    '[class*="reply-count"]',
    '[class*="share-count"]',
    '[class*="view-count"]',
    // Subscribe/follow buttons
    '[class*="subscribe-button"]',
    '[class*="follow-button"]',
  ];

  for (const selector of removeSelectors) {
    const elements = element.querySelectorAll(selector);
    elements.forEach((el) => el.remove());
  }

  // Remove hidden elements
  const allElements = element.querySelectorAll('*');
  allElements.forEach((el) => {
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden') {
      el.remove();
    }
  });
}

function parseBlocks(element: HTMLElement): ContentBlock[] {
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

    // Skip empty blocks
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

function extractImages(container: HTMLElement): ImageCandidate[] {
  const images: ImageCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;

  // 1. Extract from <img> elements
  const imgElements = container.querySelectorAll('img');
  imgElements.forEach((img) => {
    const urls = getImageUrls(img);
    urls.forEach((urlInfo) => {
      if (!seen.has(urlInfo.url)) {
        seen.add(urlInfo.url);
        images.push({
          id: generateId(),
          url: urlInfo.url,
          kind: urlInfo.kind,
          order: order++,
          inMainContent: true,
          width: img.naturalWidth || img.width || undefined,
          height: img.naturalHeight || img.height || undefined,
          alt: img.alt || undefined,
        });
      }
    });
  });

  // 2. Extract from <picture> elements
  const pictureElements = container.querySelectorAll('picture source');
  pictureElements.forEach((source) => {
    const srcset = source.getAttribute('srcset');
    if (srcset) {
      const url = parseSrcset(srcset);
      if (url && !seen.has(url)) {
        seen.add(url);
        images.push({
          id: generateId(),
          url,
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
      if (urlMatch && urlMatch[1] && !seen.has(urlMatch[1])) {
        seen.add(urlMatch[1]);
        images.push({
          id: generateId(),
          url: urlMatch[1],
          kind: 'background',
          order: order++,
          inMainContent: true,
        });
      }
    }
  });

  // 4. Extract og:image
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  if (ogImage && !seen.has(ogImage)) {
    seen.add(ogImage);
    images.push({
      id: generateId(),
      url: ogImage,
      kind: 'og',
      order: order++,
      inMainContent: false,
    });
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
        kind: 'preload',
        order: order++,
        inMainContent: false,
      });
    }
  });

  // Log image candidates summary
  console.log(`[cs] img candidates total=${images.length}, planned=${images.length}, overflow=0`);

  return images;
}

function getImageUrls(img: HTMLImageElement): Array<{ url: string; kind: ImageCandidate['kind'] }> {
  const urls: Array<{ url: string; kind: ImageCandidate['kind'] }> = [];

  // Lazy loading attributes
  const lazyAttrs = [
    'data-src',
    'data-original',
    'data-url',
    'data-lazy',
    'data-srcset',
    'data-actualsrc',
    'data-hires',
    'data-lazy-src',
  ];

  // Check lazy loading attributes first (usually higher quality)
  for (const attr of lazyAttrs) {
    const value = img.getAttribute(attr);
    if (value && isValidImageUrl(value)) {
      urls.push({ url: resolveUrl(value), kind: 'lazy' });
    }
  }

  // currentSrc (actual loaded image)
  if (img.currentSrc && isValidImageUrl(img.currentSrc)) {
    urls.push({ url: img.currentSrc, kind: 'img' });
  }

  // src attribute
  if (img.src && isValidImageUrl(img.src)) {
    urls.push({ url: img.src, kind: 'img' });
  }

  // srcset - get highest resolution
  if (img.srcset) {
    const url = parseSrcset(img.srcset);
    if (url) {
      urls.push({ url, kind: 'srcset' });
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return urls.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function parseSrcset(srcset: string): string | null {
  const parts = srcset.split(',').map((s) => s.trim());
  let maxWidth = 0;
  let bestUrl = '';

  for (const part of parts) {
    const [url, descriptor] = part.split(/\s+/);
    if (!url) continue;

    const width = parseInt(descriptor?.replace('w', '') || '0', 10);
    if (width > maxWidth || !bestUrl) {
      maxWidth = width;
      bestUrl = url;
    }
  }

  return bestUrl ? resolveUrl(bestUrl) : null;
}

function isValidImageUrl(url: string): boolean {
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

function resolveUrl(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http')) {
    return url;
  }
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/**
 * Fetch image as base64 encoded string for message passing
 * This is needed because Blob objects cannot be passed through chrome.runtime.sendMessage
 * 
 * Enhanced for WeChat (mmbiz.qpic.cn) images with multiple fallback strategies
 */
async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  console.log('[墨问 Content] fetchImageAsBase64 start:', url.substring(0, 80));

  // Check if this is a WeChat image
  const isWeixinImage = url.includes('mmbiz.qpic.cn') || url.includes('mmbiz.qlogo.cn');

  try {
    let blob: Blob | null = null;

    // Strategy 1: For WeChat images, try canvas approach first (it can capture loaded images)
    if (isWeixinImage) {
      console.log('[墨问 Content] WeChat image detected, trying canvas first');
      try {
        blob = await fetchViaCanvas(url);
        if (blob && blob.size > 0) {
          console.log('[墨问 Content] fetchImageAsBase64: WeChat canvas fetch ok, size:', blob.size);
        } else {
          blob = null;
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: WeChat canvas fetch failed:', e);
      }
    }

    // Strategy 2: Try without credentials first (better for CDNs like Twitter pbs.twimg.com)
    // This avoids CORS errors when servers don't support credentials mode
    if (!blob || blob.size === 0) {
      try {
        const response = await fetch(url, {
          mode: 'cors',
          credentials: 'omit',
        });
        if (response.ok) {
          blob = await response.blob();
          console.log('[墨问 Content] fetchImageAsBase64: no-cred fetch ok, size:', blob.size);
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: no-cred fetch failed:', e);
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
          console.log('[墨问 Content] fetchImageAsBase64: with-cred fetch ok, size:', blob.size);
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: with-cred fetch failed:', e);
      }
    }

    // Strategy 4: Try XHR approach (sometimes works better for cross-origin)
    if (!blob || blob.size === 0) {
      try {
        blob = await fetchViaXHR(url);
        if (blob && blob.size > 0) {
          console.log('[墨问 Content] fetchImageAsBase64: XHR fetch ok, size:', blob.size);
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: XHR fetch failed:', e);
      }
    }

    // Strategy 5: Canvas approach for non-WeChat images (already tried for WeChat above)
    if (!isWeixinImage && (!blob || blob.size === 0)) {
      console.log('[墨问 Content] fetchImageAsBase64: trying canvas approach');
      try {
        blob = await fetchViaCanvas(url);
        if (blob && blob.size > 0) {
          console.log('[墨问 Content] fetchImageAsBase64: canvas fetch ok, size:', blob.size);
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: canvas fetch failed:', e);
      }
    }

    // Strategy 6: Try to find the image already loaded on the page
    if (!blob || blob.size === 0) {
      console.log('[墨问 Content] fetchImageAsBase64: trying to find loaded image');
      try {
        blob = await fetchFromLoadedImage(url);
        if (blob && blob.size > 0) {
          console.log('[墨问 Content] fetchImageAsBase64: loaded image fetch ok, size:', blob.size);
        }
      } catch (e) {
        console.log('[墨问 Content] fetchImageAsBase64: loaded image fetch failed:', e);
      }
    }

    if (!blob || blob.size === 0) {
      console.log('[墨问 Content] fetchImageAsBase64: all strategies failed for:', url.substring(0, 60));
      return null;
    }

    // Convert blob to base64
    const base64 = await blobToBase64(blob);
    const mimeType = blob.type || 'image/jpeg';

    console.log('[墨问 Content] fetchImageAsBase64: success, base64 length:', base64.length);
    return { base64, mimeType };
  } catch (error) {
    console.error('[墨问 Content] fetchImageAsBase64 error:', error);
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
 */
async function fetchFromLoadedImage(url: string): Promise<Blob | null> {
  // Find all images that match this URL
  const images = document.querySelectorAll('img');
  for (const img of images) {
    // Check if this image matches our URL (src, data-src, currentSrc, etc.)
    const matchesUrl =
      img.src === url ||
      img.currentSrc === url ||
      img.getAttribute('data-src') === url ||
      img.getAttribute('data-original') === url ||
      img.getAttribute('data-actualsrc') === url;

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
              resolve(blob);
            }, 'image/png');
          });
        }
      } catch (e) {
        // Canvas tainted, skip
        console.log('[墨问 Content] fetchFromLoadedImage: canvas tainted for:', url.substring(0, 40));
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
        console.log('[墨问 Content] fetchViaCanvas: canvas error:', e);
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
async function blobToBase64(blob: Blob): Promise<string> {
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

/**
 * Schedule content extraction with debouncing
 */
function scheduleExtraction() {
  if (extractScheduled) {
    console.log('[墨问 Content] ⏸️ Extraction already scheduled, skipping');
    return;
  }

  extractScheduled = true;
  console.log('[墨问 Content] 📅 Scheduling extraction in 1.5s (waiting for page to stabilize)');

  // Wait for page to stabilize before extracting
  setTimeout(() => {
    extractScheduled = false;
    console.log('[墨问 Content] ⏰ Scheduled extraction triggered');
    extractContent().catch((err) => {
      console.error('[墨问 Content] ❌ Auto-extraction failed:', err);
    });
  }, 1500); // 1.5 second delay to let page stabilize
}

/**
 * Initialize auto-extraction on page load
 */
function initializeAutoExtraction() {
  console.log('[墨问 Content] 🎯 Initializing auto-extraction system');
  console.log('[墨问 Content] Current document.readyState:', document.readyState);

  // Check if page is ready
  if (document.readyState === 'complete') {
    // Page already loaded, extract after a short delay
    console.log('[墨问 Content] ✅ Page already loaded, scheduling extraction in 2s');
    setTimeout(() => {
      console.log('[墨问 Content] ⏰ Initial extraction timer triggered');
      extractContent().catch((err) => {
        console.error('[墨问 Content] ❌ Initial extraction failed:', err);
      });
    }, 2000);
  } else {
    // Wait for page to load
    console.log('[墨问 Content] ⏳ Waiting for page load event...');
    window.addEventListener('load', () => {
      console.log('[墨问 Content] ✅ Page load event fired, scheduling extraction in 2s');
      setTimeout(() => {
        console.log('[墨问 Content] ⏰ Post-load extraction timer triggered');
        extractContent().catch((err) => {
          console.error('[墨问 Content] ❌ Initial extraction failed:', err);
        });
      }, 2000);
    });
  }

  // Watch for dynamic content changes using MutationObserver
  console.log('[墨问 Content] 👁️ Setting up MutationObserver for page changes');
  const observer = new MutationObserver((mutations) => {
    // Check if significant content changes occurred
    const hasSignificantChanges = mutations.some((mutation) => {
      if (mutation.type !== 'childList') return false;

      // Check if new content was added
      return mutation.addedNodes.length > 0 &&
        Array.from(mutation.addedNodes).some((node) => {
          // Only consider significant changes (not script/style/tiny elements)
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            return !['SCRIPT', 'STYLE', 'IFRAME'].includes(el.tagName) &&
              (el.children.length > 0 || (el.textContent?.length || 0) > 50);
          }
          return false;
        });
    });

    if (hasSignificantChanges) {
      // Invalidate cache and schedule re-extraction
      console.log('[墨问 Content] 🔄 Significant page change detected, invalidating cache');
      console.log('[墨问 Content] 🗑️ Cache cleared:', {
        previousCache: cachedExtractResult ? {
          title: cachedExtractResult.title,
          wordCount: cachedExtractResult.wordCount,
        } : null,
      });
      cachedExtractResult = null;
      scheduleExtraction();
    }
  });

  // Start observing the document
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[墨问 Content] ✅ Auto-extraction initialized with page change detection');
}

// Initialize
console.log('[墨问笔记助手] Content script loaded');
console.log('[墨问 Content] Page URL:', window.location.href);
console.log('[墨问 Content] Page ready state:', document.readyState);
console.log('[墨问 Content] Initializing auto-extraction...');
initializeAutoExtraction();
