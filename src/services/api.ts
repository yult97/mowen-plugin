import { NoteCreateResult } from '../types';
import { formatDate, formatErrorForLog, parseErrorCode } from '../utils/helpers';
import { htmlToNoteAtom } from '../utils/noteAtom';

const API_BASE_URL = 'https://open.mowen.cn/api/open/api/v1';

// Rate limiting: 1000ms between upload API calls (per official docs: 1 req/sec)
const UPLOAD_RATE_LIMIT_MS = 1000;
let lastUploadApiTime = 0;

interface ApiResponse<T> {
  code?: number | string;
  message?: string;
  data?: T;
}

interface NoteCreateData {
  noteId: string;
}

// Official API response per https://mowen.apifox.cn/304984752e0
// Response: { "file": { "uid": "string", "fileId": "string", "url": "string", ... } }
interface UploadedFile {
  uid: string;
  fileId: string;
  name: string;
  path: string;
  type: number;
  format: string;
  extra: string;
  size: string;
  mime: string;
  hash: string;
  url: string;
  styleUrls?: Record<string, string>;
  risky?: boolean;
}

interface UploadViaUrlResponse {
  file: UploadedFile;
}

// Note: /upload/prepare API returns { form: { endpoint, callback, key, ... } }
// The endpoint is INSIDE form, not at root level

// Image upload result with full tracking
export interface ImageUploadResult {
  success: boolean;
  uploadMethod?: 'remote' | 'local' | 'degraded';
  uuid?: string;
  url?: string;
  fileId?: string;
  uid?: string;
  error?: string;
  degradeReason?: string;
}

class ApiRequestError extends Error {
  status: number;
  code?: number | string;
  data?: unknown;
  rawBody?: string;

  constructor(
    message: string,
    options: { status: number; code?: number | string; data?: unknown; rawBody?: string }
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.code = options.code;
    this.data = options.data;
    this.rawBody = options.rawBody;
  }
}

async function apiRequest<T>(
  endpoint: string,
  apiKey: string,
  body?: object
): Promise<T> {
  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  const fullUrl = `${API_BASE_URL}${endpoint}`;

  let responseStatus = 0;
  let responseBody = '';
  const responseHeaders: Record<string, string> = {};

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    responseStatus = response.status;

    // Capture response headers
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // ALWAYS read response body, even for errors
    try {
      responseBody = await response.text();
    } catch (readErr) {
      responseBody = `[ERROR reading body: ${readErr instanceof Error ? readErr.message : String(readErr)}]`;
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new ApiRequestError('UNAUTHORIZED: Invalid API key', { status: response.status, rawBody: responseBody });
      }
      if (response.status === 429) {
        throw new ApiRequestError('RATE_LIMIT: Too many requests', { status: response.status, rawBody: responseBody });
      }
      // 403: 解析服务端返回的 reason 字段，区分权限不足等具体原因
      if (response.status === 403) {
        let permMessage = '权限不足，请检查账户状态';
        try {
          const errorBody = JSON.parse(responseBody);
          if (errorBody?.reason === 'PERM') {
            console.warn('[apiRequest] 403 PERM');
            // 为用户提供友好的中文提示，而非服务端的英文技术信息
            permMessage = '该功能仅限 Pro 会员使用，请升级后再试';
          }
        } catch {
          // JSON 解析失败，使用默认消息
        }
        throw new ApiRequestError(permMessage, {
          status: response.status,
          code: 403,
          rawBody: responseBody,
        });
      }
      if (response.status === 503) {
        throw new ApiRequestError('SERVICE_UNAVAILABLE: 服务暂时不可用，请稍后再试', {
          status: response.status,
          rawBody: responseBody,
        });
      }
      // For 500 and other errors
      throw new ApiRequestError(`NETWORK: HTTP ${response.status}`, { status: response.status, rawBody: responseBody });
    }

    // Use already-captured responseBody (response.text() can only be read once)
    const rawText = responseBody;
    let parsed: ApiResponse<T> | null = null;

    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as ApiResponse<T>;
      } catch {
        throw new ApiRequestError('INVALID_RESPONSE', {
          status: responseStatus,
          rawBody: rawText,
        });
      }
    }

    // Debug log: Log API response for debugging
    console.log(`[apiRequest] ${endpoint} response:`, {
      status: response.status,
      rawText,
      parsed,
      code: parsed?.code,
      message: parsed?.message,
      hasData: !!parsed?.data,
      data: parsed?.data,
    });

    // If response is empty or parsed is null, and status is OK, treat as success
    if (!parsed && response.ok) {
      console.warn(`[apiRequest] ${endpoint} returned empty response with status ${response.status}`);
      return undefined as T;
    }

    // If code is missing/undefined and status is OK, treat as success
    // This handles API responses that don't follow the standard {code, data} format
    if (parsed?.code === undefined && response.ok) {
      // Check if response has data directly
      if (parsed?.data !== undefined) {
        return parsed.data as T;
      }
      // Return the whole parsed object if it has properties
      if (parsed && Object.keys(parsed).length > 0) {
        // For responses like {noteId: "xxx"} directly
        return parsed as T;
      }
      return undefined as T;
    }

    // Normalize code to number for comparison (handle both string "0" and number 0)
    const hasCode = parsed?.code !== undefined && parsed?.code !== null;
    const normalizedCode = hasCode ? Number(parsed?.code) : undefined;

    // Check if this is an error response
    // An error is when code is explicitly non-zero (not missing/undefined)
    const isErrorCode = hasCode && !Number.isNaN(normalizedCode) && normalizedCode !== 0;

    if (isErrorCode) {
      console.error(
        `[apiRequest] ${endpoint} error response: code=${String(parsed?.code ?? 'unknown')}, message=${formatErrorForLog(parsed?.message ?? 'unknown')}`
      );
      throw new ApiRequestError(parsed?.message || 'Unknown error', {
        status: response.status,
        code: parsed?.code,
        data: parsed?.data,
        rawBody: rawText,
      });
    }

    // Return data (may be undefined for some endpoints)
    return parsed?.data as T;
  } catch (error) {
    clearTimeout(timeoutId);

    // Handle abort error (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiRequestError('TIMEOUT: 请求超时，请检查网络连接', { status: 0 });
    }
    throw error;
  }
}

// Document emoji for original link source line
const ORIGINAL_LINK_ICON = '📄';

/**
 * Create original link HTML section with icon
 * Format: 📄 来源：🔗查看原文
 */
function createOriginalLinkHtml(sourceUrl?: string): string {
  if (!sourceUrl) return '';
  return `<p>${ORIGINAL_LINK_ICON} 来源：<a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">查看原文</a></p>`;
}

export async function createNote(
  apiKey: string,
  title: string,
  content: string,
  isPublic: boolean = false,
  logger?: (msg: string) => Promise<void>,
  sourceUrl?: string,
  enableAutoTag?: boolean
): Promise<NoteCreateResult> {
  const log = (msg: string) => {
    console.log(`[sw] ${msg}`);
    if (logger) logger(msg)?.catch(() => { });
  };

  log(`createNote start: "${title.substring(0, 30)}..." (${content.length} chars)`);

  try {
    // 移除 content 开头与标题重复的内容
    const cleanedContent = removeDuplicateTitleFromContent(content, title);
    if (cleanedContent !== content) {
      log('createNote: removed duplicate title from content');
    }

    // Build the complete HTML with title as a heading, original link, and content
    const originalLinkHtml = createOriginalLinkHtml(sourceUrl);
    const fullHtml = `<h1>${escapeHtml(title)}</h1>${originalLinkHtml}${cleanedContent}`;
    log(`createNote: fullHtml length = ${fullHtml.length}`);

    // Convert HTML to NoteAtom format
    log('createNote: converting to NoteAtom...');
    let body;
    try {
      // Safe Mode Parser used, should be fast and non-blocking
      body = htmlToNoteAtom(fullHtml);
      log(`createNote: NoteAtom conversion done, content items = ${body?.content?.length || 0}`);
      // Log full object depth for debugging
    } catch (convErr) {
      console.error(`[sw] createNote: NoteAtom conversion failed: ${formatErrorForLog(convErr)}`);
      log(`❌ NoteAtom conversion FAILED: ${convErr}`);
      return {
        success: false,
        error: `NoteAtom 转换失败: ${convErr instanceof Error ? convErr.message : 'Unknown'}`,
        errorCode: 'UNKNOWN',
      };
    }

    const requestData = {
      body,
      settings: {
        autoPublish: isPublic,
        ...(enableAutoTag ? { tags: ["墨问剪藏"] } : {}),
      },
    };

    log('createNote: calling /note/create API...');

    const data = await apiRequest<NoteCreateData>('/note/create', apiKey, requestData);

    log('createNote: API response received');

    // Check if data and noteId exist (safe access)
    const noteId = data?.noteId;
    if (!noteId) {
      console.error('[sw] createNote: Missing noteId in response');
      log('❌ createNote: Missing noteId in response');
      return {
        success: false,
        error: 'API 返回数据格式异常，缺少 noteId',
        errorCode: 'UNKNOWN',
      };
    }

    // Privacy is already set via autoPublish in the create request
    // No need to call /note/set endpoint separately

    // Build note URLs from noteId
    // noteUrl: for direct access (editor for private, detail for public)
    // shareUrl: always detail for sharing/collection links
    const shareUrl = `https://note.mowen.cn/detail/${noteId}`;
    const noteUrl = isPublic ? shareUrl : `https://note.mowen.cn/editor/${noteId}`;

    return {
      success: true,
      noteId,
      noteUrl,
      shareUrl,
    };
  } catch (error) {
    // Even if the API returns an error, check if the note was actually created
    // Some error responses still include the noteId, indicating success
    if (error instanceof ApiRequestError) {
      // Try to extract noteId from error data
      const errorData = error.data as { noteId?: string } | undefined;
      const fallbackNoteId = errorData?.noteId;

      if (fallbackNoteId) {
        // Note was created successfully despite error response
        const shareUrl = `https://note.mowen.cn/detail/${fallbackNoteId}`;
        const noteUrl = isPublic ? shareUrl : `https://note.mowen.cn/editor/${fallbackNoteId}`;
        return {
          success: true,
          noteId: fallbackNoteId,
          noteUrl,
          shareUrl,
        };
      }

      // Log for debugging
      console.error(
        `[createNote] API Error: status=${error.status}, code=${String(error.code ?? 'unknown')}, message=${formatErrorForLog(error)}`
      );
      log(`❌ API Error: Status=${error.status}, Msg=${error.message}`);
      if (error.rawBody) {
        log(`❌ Server Response Body: ${error.rawBody.substring(0, 500)}`);
      }
    } else {
      log(`❌ Unknown Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // No noteId in error response - this is a real failure
    const errorCode = getErrorCode(error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode,
    };
  }
}

/**
 * 直接使用 NoteAtom body 创建笔记（跳过 HTML 转换）
 * 适用于合集笔记等需要使用内链笔记（note block）格式的场景
 */
export async function createNoteWithBody(
  apiKey: string,
  body: Record<string, unknown>,
  isPublic: boolean = false,
  enableAutoTag?: boolean
): Promise<NoteCreateResult> {
  console.log(`[sw] createNoteWithBody: starting with body type=${body?.type}`);

  try {
    const requestData = {
      body,
      settings: {
        autoPublish: isPublic,
        ...(enableAutoTag ? { tags: ["墨问剪藏"] } : {}),
      },
    };

    const data = await apiRequest<NoteCreateData>('/note/create', apiKey, requestData);

    const noteId = data?.noteId;
    if (!noteId) {
      console.error('[sw] createNoteWithBody: Missing noteId in response');
      return {
        success: false,
        error: 'API 返回数据格式异常，缺少 noteId',
        errorCode: 'UNKNOWN',
      };
    }

    const shareUrl = `https://note.mowen.cn/detail/${noteId}`;
    const noteUrl = isPublic ? shareUrl : `https://note.mowen.cn/editor/${noteId}`;

    console.log(`[sw] createNoteWithBody: success noteId=${noteId}`);
    return {
      success: true,
      noteId,
      noteUrl,
      shareUrl,
    };
  } catch (error) {
    // 与 createNote 保持一致的 fallback 逻辑：
    // 即使 API 返回错误，也检查 error.data 中是否有 noteId
    if (error instanceof ApiRequestError) {
      const errorData = error.data as { noteId?: string } | undefined;
      const fallbackNoteId = errorData?.noteId;

      if (fallbackNoteId) {
        // 笔记实际已创建成功
        const shareUrl = `https://note.mowen.cn/detail/${fallbackNoteId}`;
        const noteUrl = isPublic ? shareUrl : `https://note.mowen.cn/editor/${fallbackNoteId}`;
        console.log(`[sw] createNoteWithBody: success via fallback noteId=${fallbackNoteId}`);
        return {
          success: true,
          noteId: fallbackNoteId,
          noteUrl,
          shareUrl,
        };
      }
    }

    console.error(`[sw] createNoteWithBody: error: ${formatErrorForLog(error)}`);
    const errorCode = getErrorCode(error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode,
    };
  }
}

/**
 * 移除 content 开头与标题重复的内容
 * 某些网站（如纽约时报中文网）的 Readability 输出会在正文开头包含与标题相同的内容，
 * 这会导致最终笔记中标题出现两次。
 * 
 * 检测并移除以下情况：
 * 1. content 以 <h1>标题</h1> 开头
 * 2. content 以 <p>标题</p> 或类似块级元素开头，且内容与标题完全匹配
 */
function removeDuplicateTitleFromContent(content: string, title: string): string {
  if (!content || !title) return content;

  const trimmedContent = content.trim();
  const normalizedTitle = title.trim();

  // 辅助函数：比较两个字符串是否相同（忽略标点符号和空白差异）
  const normalize = (s: string) => s.replace(/[\s.,;:!?。，；：！？\u200B]/g, '').toLowerCase();
  const normalizedTitleClean = normalize(normalizedTitle);

  // 情况 1: content 以 <h1>标题</h1> 开头
  const h1Regex = /^\s*<h1[^>]*>([\s\S]*?)<\/h1>\s*/i;
  const h1Match = trimmedContent.match(h1Regex);
  if (h1Match) {
    const h1Content = h1Match[1].replace(/<[^>]*>/g, '').trim(); // 去除内部 HTML 标签
    if (normalize(h1Content) === normalizedTitleClean) {
      console.log('[api] Removing duplicate h1 title from content:', h1Content.substring(0, 30));
      return trimmedContent.replace(h1Regex, '');
    }
  }

  // 情况 2: content 以 <p>标题</p>、<div>标题</div> 等块级元素开头
  const blockRegex = /^\s*<(p|div|section|header)[^>]*>([\s\S]*?)<\/\1>\s*/i;
  const blockMatch = trimmedContent.match(blockRegex);
  if (blockMatch) {
    const blockContent = blockMatch[2].replace(/<[^>]*>/g, '').trim();
    // 只有当内容长度接近标题长度时才移除，避免误删正文段落
    if (blockContent.length <= normalizedTitle.length * 1.5 &&
      normalize(blockContent) === normalizedTitleClean) {
      console.log('[api] Removing duplicate block title from content:', blockContent.substring(0, 30));
      return trimmedContent.replace(blockRegex, '');
    }
  }

  return content;
}

/**
 * Escape HTML special characters (Service Worker compatible)
 */
function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
}

export async function setNotePublic(
  apiKey: string,
  noteId: string,
  isPublic: boolean
): Promise<boolean> {
  return setNotePrivacy(apiKey, noteId, isPublic);
}

/**
 * Set note privacy using the correct API endpoint and structure
 */
async function setNotePrivacy(
  apiKey: string,
  noteId: string,
  isPublic: boolean
): Promise<boolean> {
  try {
    await apiRequest('/note/set', apiKey, {
      noteId,
      section: 1, // 1 = privacy settings section
      settings: {
        privacy: {
          type: 'normal',
          rule: {
            noShare: !isPublic,
          },
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload image via URL per official docs: https://mowen.apifox.cn/304984752e0
 * Request: { fileType: 1, url: string, fileName: string }
 * Response: { file: { url: string, fileId: string, ... } }
 */
export async function uploadImageViaUrl(
  apiKey: string,
  imageUrl: string
): Promise<{ success: boolean; assetUrl?: string; fileId?: string; uid?: string; error?: string }> {
  console.log(`[sw] uploadImageViaUrl start url=${imageUrl.substring(0, 80)}...`);

  try {
    // Extract filename from URL
    const fileName = extractFileName(imageUrl);

    console.log(`[img] remote calling API fileType=image fileName=${fileName}`);

    // Per API: fileType should be 1 (Image), 2 (Audio), 3 (PDF)
    const data = await apiRequest<UploadViaUrlResponse>('/upload/url', apiKey, {
      fileType: 1,
      url: imageUrl,
      fileName: fileName,
    });

    // Response is { file: { url, fileId, uid, ... } }
    const uploadedUrl = data?.file?.url;
    const fileId = data?.file?.fileId;
    const uid = data?.file?.uid;

    if (!uploadedUrl) {
      console.log(`[img] remote fail: no url in response`, data);
      return {
        success: false,
        error: 'No URL in response',
      };
    }

    console.log(`[img] remote ok fileId=${fileId} uid=${uid} url=${uploadedUrl.substring(0, 60)}...`);
    return {
      success: true,
      assetUrl: uploadedUrl,
      fileId: fileId,
      uid: uid,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Upload failed';
    console.log(`[img] remote fail: ${errMsg}`);
    return {
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Wait for rate limit before making upload API call
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastCall = now - lastUploadApiTime;
  if (timeSinceLastCall < UPLOAD_RATE_LIMIT_MS) {
    const waitTime = UPLOAD_RATE_LIMIT_MS - timeSinceLastCall;
    console.log(`[img] rate limit wait ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastUploadApiTime = Date.now();
}

/**
 * Fetch WeChat image using no-referrer policy to bypass anti-hotlinking
 * This works in Service Worker context where we can control the referrer policy
 * 
 * WeChat CDN (mmbiz.qpic.cn) blocks requests with non-WeChat referrers,
 * but allows requests with no referrer at all.
 */
async function fetchWeixinImageNoReferrer(imageUrl: string): Promise<Blob | null> {
  console.log(`[img] weixin fetch no-referrer: ${imageUrl.substring(0, 60)}...`);

  try {
    // Strategy 1: Use no-referrer policy
    const response = await fetch(imageUrl, {
      method: 'GET',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 0) {
        console.log(`[img] weixin fetch ok: size=${blob.size}, type=${blob.type}`);
        return blob;
      }
    }

    console.log(`[img] weixin fetch fail: status=${response.status}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[img] weixin fetch exception: ${errMsg}`);
  }

  // Strategy 2: Try with different Accept header (some CDNs behave differently)
  try {
    const response2 = await fetch(imageUrl, {
      method: 'GET',
      referrerPolicy: 'no-referrer',
      mode: 'no-cors', // Try no-cors as last resort
      credentials: 'omit',
    });

    // With no-cors, we get an opaque response, but blob() still works
    const blob = await response2.blob();
    if (blob.size > 0) {
      console.log(`[img] weixin no-cors fetch ok: size=${blob.size}`);
      return blob;
    }
  } catch (error) {
    console.log(`[img] weixin no-cors fetch also failed`);
  }

  return null;
}

/**
 * Fetch image directly from Service Worker using no-referrer policy
 * This bypasses CORS restrictions that Content Script cannot circumvent
 * 
 * Works for domains like s.baoyu.io that block cross-origin requests
 * but allow requests with no referrer from Chrome extension Service Workers.
 */
async function fetchImageDirectFromSW(imageUrl: string): Promise<Blob | null> {
  console.log(`[img] SW direct fetch: ${imageUrl.substring(0, 60)}...`);

  // Skip data/blob URLs - they need special handling
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
    console.log(`[img] SW direct fetch: skipping data/blob URL`);
    return null;
  }

  try {
    // Strategy 1: Use no-referrer policy with CORS mode
    const response = await fetch(imageUrl, {
      method: 'GET',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 0) {
        console.log(`[img] SW direct fetch ok: size=${blob.size}, type=${blob.type}`);
        return blob;
      }
    }

    console.log(`[img] SW direct fetch fail: status=${response.status}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[img] SW direct fetch cors exception: ${errMsg}`);
  }

  // Strategy 2: Try no-cors mode (opaque response, but blob() still works)
  try {
    const response2 = await fetch(imageUrl, {
      method: 'GET',
      referrerPolicy: 'no-referrer',
      mode: 'no-cors',
      credentials: 'omit',
    });

    const blob = await response2.blob();
    if (blob.size > 0) {
      console.log(`[img] SW direct no-cors fetch ok: size=${blob.size}`);
      return blob;
    }
  } catch (error) {
    console.log(`[img] SW direct no-cors fetch also failed`);
  }

  return null;
}

/**
 * Local upload step 1: Get upload authorization info
 * Per official docs: https://mowen.apifox.cn/304801589e0
 * 
 * Request: POST /upload/prepare
 * Body: { fileType: 0, fileName: "string" }
 * 
 * ACTUAL Response structure from API:
 * { form: { endpoint, callback, key, policy, ... } }
 * 
 * Note: endpoint is INSIDE form object, not at root level
 */
export async function uploadPrepare(
  apiKey: string,
  fileName: string
): Promise<{ success: boolean; endpoint?: string; form?: Record<string, string>; error?: string }> {
  console.log(`[img] local prepare start fileName=${fileName}`);

  try {
    // Acquire rate limit before API call
    await waitForRateLimit();

    const data = await apiRequest<{ form: Record<string, string> }>('/upload/prepare', apiKey, {
      fileType: 1,  // API expects 1 for image
      fileName: fileName,
    });

    // Log the response structure
    const form = data?.form;
    const formKeys = form ? Object.keys(form) : [];
    console.log(`[img] local prepare response formKeys=[${formKeys.join(',')}]`);

    if (!form) {
      console.log(`[img] local prepare fail: missing form object`, data);
      return {
        success: false,
        error: 'Missing form in response',
      };
    }

    // Extract endpoint from form object (API puts it inside form, not at root)
    const endpoint = form.endpoint;
    if (!endpoint) {
      console.log(`[img] local prepare fail: missing endpoint in form`, form);
      return {
        success: false,
        error: 'Missing endpoint in form',
      };
    }

    console.log(`[img] local prepare ok endpoint=${endpoint.substring(0, 50)}... formKeys=[${formKeys.join(',')}]`);
    return {
      success: true,
      endpoint: endpoint,
      form: form,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Prepare failed';
    console.log(`[img] local prepare fail: ${errMsg}`);
    return {
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Local upload step 2: Deliver file to the endpoint
 * Per official docs: https://mowen.apifox.cn/306385915e0
 * 
 * Request: POST {endpoint}
 * Body: multipart/form-data with all form fields from prepare + file
 * 
 * The file field name is "file" per the example curl command in docs
 */
export async function uploadLocalFile(
  endpoint: string,
  form: Record<string, string>,
  fileBlob: Blob,
  fileName: string
): Promise<{ success: boolean; uploadedFile?: UploadedFile; error?: string }> {
  console.log(`[img] local deliver start size=${fileBlob.size} mime=${fileBlob.type} fileName=${fileName}`);

  try {
    // Build FormData with all form fields from prepare response
    const formData = new FormData();

    // Append all form fields first (order matters for some OSS implementations)
    for (const [key, value] of Object.entries(form)) {
      formData.append(key, value);
    }

    // Append file last with the name "file" per docs
    // The docs show: --form 'file=@""'
    const FILE_FIELD_NAME = 'file';
    formData.append(FILE_FIELD_NAME, fileBlob, fileName);

    console.log(`[img] local deliver sending to ${endpoint.substring(0, 50)}... formFieldCount=${Object.keys(form).length} fileFieldName=${FILE_FIELD_NAME}`);

    // POST to the endpoint - DON'T set Content-Type, let browser set boundary
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for file upload

    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Always read response body for debugging
    let responseBody = '';
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '[unable to read body]';
    }

    console.log(`[img] local deliver response status=${response.status} body=${responseBody.substring(0, 200)}...`);

    if (!response.ok) {
      console.log(`[img] local deliver fail status=${response.status} body=${responseBody}`);
      return {
        success: false,
        error: `HTTP ${response.status}: ${responseBody.substring(0, 100)}`,
      };
    }

    // Try to parse response as JSON (OSS callback should return file info)
    let uploadedFile: UploadedFile | undefined;
    try {
      const parsed = JSON.parse(responseBody);
      // The response structure may be: { file: {...} } or { data: { file: {...} } } or direct file object
      if (parsed.file) {
        uploadedFile = parsed.file;
      } else if (parsed.data?.file) {
        uploadedFile = parsed.data.file;
      } else if (parsed.uid && parsed.url) {
        // Direct file object
        uploadedFile = parsed;
      }
    } catch {
      console.log(`[img] local deliver: response not JSON, may still be ok`);
    }

    // Extract UUID for NoteAtom - prefer uid, fallback to fileId
    const uuid = uploadedFile?.uid || uploadedFile?.fileId;
    if (uuid) {
      console.log(`[img] local deliver ok uuid=${uuid} url=${uploadedFile?.url?.substring(0, 60) || 'N/A'}`);
    } else {
      console.log(`[img] local deliver ok (no uuid in response)`);
    }

    return {
      success: true,
      uploadedFile,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Deliver failed';
    if (error instanceof Error && error.name === 'AbortError') {
      console.log(`[img] local deliver fail: timeout`);
      return { success: false, error: 'Upload timeout' };
    }
    console.log(`[img] local deliver fail: ${errMsg}`);
    return {
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Upload image using local upload method only.
 * Flow: browser downloads image -> /upload/prepare -> upload to OSS
 * 
 * Special handling for WeChat images using Service Worker no-referrer fetch.
 *
 * @param apiKey - Mowen API key
 * @param imageUrl - Original image URL
 * @param imageIndex - 1-based index for logging
 * @param fetchBlobFn - Function to fetch image blob from Content Script (required)
 */
export async function uploadImageWithFallback(
  apiKey: string,
  imageUrl: string,
  imageIndex: number,
  fetchBlobFn?: () => Promise<{ blob: Blob; mimeType: string } | null>
): Promise<ImageUploadResult> {
  console.log(`[img] idx=${imageIndex} candidateUrl=${imageUrl.substring(0, 80)}...`);

  // Validate URL type
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
    console.log(`[img] idx=${imageIndex} skip: data/blob URL not supported for remote upload`);
    // For data/blob URLs, try local upload directly if we have fetchBlobFn
    if (!fetchBlobFn) {
      return {
        success: false,
        uploadMethod: 'degraded',
        degradeReason: 'data_or_blob_url_no_blob_fn',
      };
    }
  }

  // Check if fetchBlobFn is provided (required for local upload)
  if (!fetchBlobFn) {
    console.log(`[img] idx=${imageIndex} fail: no blob fetch function provided`);
    return {
      success: false,
      uploadMethod: 'degraded',
      degradeReason: 'no_blob_fetch_function',
    };
  }

  // ===== Step 1.5: For WeChat images, try direct fetch with no-referrer =====
  // WeChat images have strict Referer checking, but Service Worker can bypass it
  const isWeixinImage = imageUrl.includes('mmbiz.qpic.cn') || imageUrl.includes('mmbiz.qlogo.cn');
  if (isWeixinImage && !imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:')) {
    console.log(`[img] idx=${imageIndex} weixin no-referrer start`);
    try {
      const weixinBlob = await fetchWeixinImageNoReferrer(imageUrl);
      if (weixinBlob && weixinBlob.size > 0) {
        console.log(`[img] idx=${imageIndex} weixin no-referrer fetch ok, size=${weixinBlob.size}`);

        // Check size limit
        const MAX_LOCAL_SIZE = 50 * 1024 * 1024;
        if (weixinBlob.size > MAX_LOCAL_SIZE) {
          console.log(`[img] idx=${imageIndex} weixin skip: size ${weixinBlob.size} exceeds 50MB`);
        } else {
          // Generate filename and upload
          const fileName = generateFileName(imageUrl, weixinBlob.type);
          await waitForRateLimit();
          const prepareResult = await uploadPrepare(apiKey, fileName);

          if (prepareResult.success && prepareResult.endpoint && prepareResult.form) {
            const deliverResult = await uploadLocalFile(
              prepareResult.endpoint,
              prepareResult.form,
              weixinBlob,
              fileName
            );

            if (deliverResult.success) {
              const uploadedFile = deliverResult.uploadedFile;
              const uuid = uploadedFile?.fileId || uploadedFile?.uid;
              console.log(`[img] idx=${imageIndex} weixin no-referrer upload success uuid=${uuid}`);
              return {
                success: true,
                uploadMethod: 'local',
                uuid: uuid,
                url: uploadedFile?.url,
                fileId: uploadedFile?.fileId,
                uid: uploadedFile?.uid,
              };
            }
            console.log(`[img] idx=${imageIndex} weixin deliver fail: ${deliverResult.error}`);
          } else {
            console.log(`[img] idx=${imageIndex} weixin prepare fail: ${prepareResult.error}`);
          }
        }
      } else {
        console.log(`[img] idx=${imageIndex} weixin no-referrer fetch returned empty`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[img] idx=${imageIndex} weixin no-referrer exception: ${errMsg}`);
    }
  }

  // ===== Step 2: Try Local Upload =====
  if (fetchBlobFn) {
    console.log(`[img] idx=${imageIndex} local start (fallback)`);

    try {
      // Fetch blob from Content Script
      const blobResult = await fetchBlobFn();
      if (!blobResult) {
        console.log(`[img] idx=${imageIndex} local fail: could not fetch blob`);
      } else {
        const { blob, mimeType } = blobResult;

        // Check size limit: 50MB for local upload per docs
        const MAX_LOCAL_SIZE = 50 * 1024 * 1024;
        if (blob.size > MAX_LOCAL_SIZE) {
          console.log(`[img] idx=${imageIndex} local fail: size ${blob.size} exceeds 50MB limit`);
          return {
            success: false,
            uploadMethod: 'degraded',
            degradeReason: 'size_exceeds_50mb',
          };
        }

        // Generate filename
        const fileName = generateFileName(imageUrl, mimeType);

        // Step 2a: Get upload authorization
        const prepareResult = await uploadPrepare(apiKey, fileName);
        if (!prepareResult.success || !prepareResult.endpoint || !prepareResult.form) {
          console.log(`[img] idx=${imageIndex} local prepare fail: ${prepareResult.error}`);
        } else {
          // Step 2b: Upload file
          const deliverResult = await uploadLocalFile(
            prepareResult.endpoint,
            prepareResult.form,
            blob,
            fileName
          );

          if (deliverResult.success) {
            const uploadedFile = deliverResult.uploadedFile;
            // Use fileId as uuid, same as remote upload
            const uuid = uploadedFile?.fileId || uploadedFile?.uid;
            console.log(`[img] idx=${imageIndex} local success uuid=${uuid}`);
            return {
              success: true,
              uploadMethod: 'local',
              uuid: uuid,
              url: uploadedFile?.url,
              fileId: uploadedFile?.fileId,
              uid: uploadedFile?.uid,
            };
          }

          console.log(`[img] idx=${imageIndex} local deliver fail: ${deliverResult.error}`);
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[img] idx=${imageIndex} local exception: ${errMsg}`);
    }
  } else {
    console.log(`[img] idx=${imageIndex} local skip: no blob fetch function provided`);
  }

  // ===== Step 2.5: Try Service Worker Direct Fetch (bypasses CORS) =====
  // This is a fallback for domains like s.baoyu.io that block Content Script fetches
  // but allow Service Worker fetches with no-referrer policy
  console.log(`[img] idx=${imageIndex} SW direct fetch start`);
  try {
    const swBlob = await fetchImageDirectFromSW(imageUrl);
    if (swBlob && swBlob.size > 0) {
      console.log(`[img] idx=${imageIndex} SW direct fetch ok, size=${swBlob.size}`);

      // Check size limit
      const MAX_LOCAL_SIZE = 50 * 1024 * 1024;
      if (swBlob.size > MAX_LOCAL_SIZE) {
        console.log(`[img] idx=${imageIndex} SW direct skip: size ${swBlob.size} exceeds 50MB`);
      } else {
        // Generate filename and upload
        const fileName = generateFileName(imageUrl, swBlob.type);
        await waitForRateLimit();
        const prepareResult = await uploadPrepare(apiKey, fileName);

        if (prepareResult.success && prepareResult.endpoint && prepareResult.form) {
          const deliverResult = await uploadLocalFile(
            prepareResult.endpoint,
            prepareResult.form,
            swBlob,
            fileName
          );

          if (deliverResult.success) {
            const uploadedFile = deliverResult.uploadedFile;
            const uuid = uploadedFile?.fileId || uploadedFile?.uid;
            console.log(`[img] idx=${imageIndex} SW direct upload success uuid=${uuid}`);
            return {
              success: true,
              uploadMethod: 'local',
              uuid: uuid,
              url: uploadedFile?.url,
              fileId: uploadedFile?.fileId,
              uid: uploadedFile?.uid,
            };
          }
          console.log(`[img] idx=${imageIndex} SW direct deliver fail: ${deliverResult.error}`);
        } else {
          console.log(`[img] idx=${imageIndex} SW direct prepare fail: ${prepareResult.error}`);
        }
      }
    } else {
      console.log(`[img] idx=${imageIndex} SW direct fetch returned empty`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[img] idx=${imageIndex} SW direct exception: ${errMsg}`);
  }

  // ===== Step 3: Degrade to Link =====
  console.log(`[img] idx=${imageIndex} degrade_to_link reason=all_upload_methods_failed`);
  return {
    success: false,
    uploadMethod: 'degraded',
    degradeReason: 'all_upload_methods_failed',
  };
}

/**
 * Generate filename from URL and MIME type
 */
function generateFileName(url: string, mimeType?: string): string {
  // Try to extract from URL first
  const extracted = extractFileName(url);
  if (extracted !== 'image.jpg') {
    return extracted;
  }

  // Generate from MIME type
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
  };

  const ext = mimeType ? mimeToExt[mimeType] || '.jpg' : '.jpg';
  return `image_${Date.now()}${ext}`;
}

/**
 * Extract filename from URL, used for upload API
 */
function extractFileName(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/');
    const lastPart = parts[parts.length - 1];

    // If has extension, use it
    if (lastPart && lastPart.includes('.')) {
      // Clean query params from filename
      return lastPart.split('?')[0];
    }

    // Default to image.jpg
    return 'image.jpg';
  } catch {
    return 'image.jpg';
  }
}

/**
 * 编辑笔记内容（用于划线追加）
 * API: POST /note/edit
 * 文档: https://mowen.apifox.cn/296486093e0
 * 
 * 注意：此 API 会替换整个笔记内容，需要先获取原内容再追加
 */
export async function editNote(
  apiKey: string,
  noteId: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; noteId?: string; error?: string; errorCode?: string }> {
  console.log(`[sw] editNote start: noteId=${noteId}`);

  try {
    const requestData = {
      noteId,
      body,
    };

    const data = await apiRequest<{ noteId: string }>('/note/edit', apiKey, requestData);

    console.log(`[sw] editNote success: noteId=${data?.noteId || noteId}`);
    return {
      success: true,
      noteId: data?.noteId || noteId,
    };
  } catch (error) {
    console.error(`[sw] editNote error: ${formatErrorForLog(error)}`);

    // 检查是否为笔记不存在的错误
    if (error instanceof ApiRequestError) {
      const errorCode = getErrorCode(error);
      return {
        success: false,
        error: error.message,
        errorCode,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: 'UNKNOWN',
    };
  }
}

// getNote 函数已删除（不再使用，优化为仅使用本地缓存）

export async function testConnection(apiKey: string): Promise<NoteCreateResult> {
  const testTitle = `【墨问笔记助手】连接测试（${formatDate()}）`;
  const testContent = `
<p>这是一条由墨问笔记助手创建的测试笔记。</p>
<p>测试时间：${formatDate()}</p>
<p>如果您能看到这条笔记，说明 API Key 配置正确。</p>
<p>您可以安全删除此笔记。</p>
`;

  return createNote(apiKey, testTitle, testContent, false);
}

function getErrorCode(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const codeString = typeof error.code === 'string' ? error.code.toUpperCase() : '';

    if (
      error.status === 401 ||
      error.code === 401 ||
      codeString.includes('UNAUTHORIZED')
    ) {
      return 'UNAUTHORIZED';
    }

    if (
      error.status === 429 ||
      error.code === 429 ||
      codeString.includes('RATE')
    ) {
      return 'RATE_LIMIT';
    }

    if (
      error.status === 503 ||
      error.code === 503 ||
      codeString.includes('SERVICE')
    ) {
      return 'SERVICE_UNAVAILABLE';
    }

    // 403 权限不足（Pro 会员限制等）
    if (
      error.status === 403 ||
      error.code === 403 ||
      codeString.includes('PERM') ||
      error.message?.includes('仅限 Pro 会员')
    ) {
      return 'PERMISSION_DENIED';
    }

    if (error.status === 413 || codeString.includes('TOO LARGE')) {
      return 'CONTENT_TOO_LONG';
    }
  }

  return parseErrorCode(error);
}
