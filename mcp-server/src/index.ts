#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { htmlToNoteAtom, escapeHtml } from './noteAtom.js';

const API_BASE_URL = 'https://open.mowen.cn/api/open/api/v1';

interface ApiResponse<T> {
  code: number;
  message: string;
  data?: T;
}

interface NoteCreateData {
  noteId: string;
}

interface NoteEditData {
  noteId: string;
}

interface UploadViaUrlData {
  assetUrl: string;
  fileId: string;
}

interface UploadPrepareData {
  uploadUrl: string;
  fileId: string;
  headers: Record<string, string>;
}

async function apiRequest<T>(
  endpoint: string,
  apiKey: string,
  body?: object
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('API Key 无效或已过期');
    }
    if (response.status === 429) {
      throw new Error('请求过于频繁，请稍后再试');
    }
    if (response.status === 503) {
      throw new Error('服务暂时不可用，请稍后再试');
    }
    throw new Error(`网络错误: HTTP ${response.status}`);
  }

  const result = await response.json() as ApiResponse<T>;

  // Normalize code to number for comparison (handle both string "0" and number 0)
  const hasCode = result.code !== undefined && result.code !== null;
  const normalizedCode = hasCode ? Number(result.code) : undefined;

  // Check if this is an error response
  // An error is when code is explicitly non-zero (not missing/undefined)
  const isErrorCode = hasCode && !Number.isNaN(normalizedCode) && normalizedCode !== 0;

  if (isErrorCode) {
    throw new Error(result.message || '未知错误');
  }

  // Return data (may be undefined for some endpoints like /note/set)
  return result.data as T;
}

// Get API key from environment
function getApiKey(): string {
  const apiKey = process.env.MOWEN_API_KEY;
  if (!apiKey) {
    throw new Error('MOWEN_API_KEY 环境变量未设置。请设置您的墨问 API Key。');
  }
  return apiKey;
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'mowen_create_note',
    description: '在墨问中创建一篇新笔记。支持 HTML 格式内容。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '笔记标题',
        },
        content: {
          type: 'string',
          description: '笔记内容，支持 HTML 格式',
        },
        isPublic: {
          type: 'boolean',
          description: '是否公开笔记，默认为 false（私密）',
          default: false,
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'mowen_edit_note',
    description: '编辑墨问中已存在的笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: '要编辑的笔记 ID',
        },
        title: {
          type: 'string',
          description: '新的笔记标题（可选）',
        },
        content: {
          type: 'string',
          description: '新的笔记内容，支持 HTML 格式（可选）',
        },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'mowen_set_note_privacy',
    description: '设置笔记的公开/私密状态。',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: '笔记 ID',
        },
        isPublic: {
          type: 'boolean',
          description: '是否公开笔记',
        },
      },
      required: ['noteId', 'isPublic'],
    },
  },
  {
    name: 'mowen_upload_image_url',
    description: '通过 URL 上传图片到墨问。返回可在笔记中使用的资源 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要上传的图片 URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'mowen_get_upload_auth',
    description: '获取本地文件上传的授权信息。返回上传 URL 和必要的 headers。',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: '文件名',
        },
        contentType: {
          type: 'string',
          description: '文件 MIME 类型，如 image/png, image/jpeg',
        },
        size: {
          type: 'number',
          description: '文件大小（字节）',
        },
      },
      required: ['filename', 'contentType', 'size'],
    },
  },
];

// Tool handlers
async function handleCreateNote(args: { title: string; content: string; isPublic?: boolean }) {
  const apiKey = getApiKey();

  // Build the complete HTML with title as a heading
  const fullHtml = `<h1>${escapeHtml(args.title)}</h1>${args.content}`;

  // Convert HTML to NoteAtom format
  const body = htmlToNoteAtom(fullHtml);

  const requestData = {
    body,
    settings: {
      autoPublish: args.isPublic || false,
    },
  };

  let noteId: string;

  try {
    const data = await apiRequest<NoteCreateData>('/note/create', apiKey, requestData);
    noteId = data.noteId;
  } catch (error) {
    // Even if the API returns an error, check if the note was actually created
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    // Try to extract noteId from error message if available
    const noteIdMatch = errorMsg.match(/noteId[:\s]+([a-zA-Z0-9_-]+)/);
    if (noteIdMatch) {
      noteId = noteIdMatch[1];
    } else {
      throw error;
    }
  }

  // Privacy is already set via autoPublish in the create request
  // No need to call /note/set endpoint separately

  // Build note URL from noteId
  const noteUrl = `https://note.mowen.cn/detail/${noteId}`;

  return {
    success: true,
    noteId,
    noteUrl,
    message: `笔记创建成功！查看：${noteUrl}`,
  };
}

async function handleEditNote(args: { noteId: string; title?: string; content?: string }) {
  const apiKey = getApiKey();

  // Build the request body with NoteAtom format if content is provided
  const requestData: Record<string, unknown> = {
    noteId: args.noteId,
  };

  if (args.content) {
    // Convert HTML content to NoteAtom format
    const body = htmlToNoteAtom(args.content);
    requestData.body = body;
  }

  // Note: Title editing is handled via content in NoteAtom format
  // If user provides title, we prepend it as a heading to the content
  if (args.title) {
    const titleHtml = `<h1>${escapeHtml(args.title)}</h1>`;
    const contentHtml = args.content || '';
    const fullHtml = titleHtml + contentHtml;
    requestData.body = htmlToNoteAtom(fullHtml);
  }

  const data = await apiRequest<NoteEditData>('/note/edit', apiKey, requestData);
  // Build note URL from noteId
  const noteUrl = `https://note.mowen.cn/detail/${data.noteId}`;
  return {
    success: true,
    noteId: data.noteId,
    noteUrl,
    message: `笔记编辑成功！查看：${noteUrl}`,
  };
}

async function handleSetNotePrivacy(args: { noteId: string; isPublic: boolean }) {
  const apiKey = getApiKey();
  await setNotePrivacy(apiKey, args.noteId, args.isPublic);
  return {
    success: true,
    message: `笔记已设置为${args.isPublic ? '公开' : '私密'}`,
  };
}

/**
 * Set note privacy using the correct API endpoint and structure
 */
async function setNotePrivacy(
  apiKey: string,
  noteId: string,
  isPublic: boolean
): Promise<void> {
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
}

async function handleUploadImageUrl(args: { url: string }) {
  const apiKey = getApiKey();
  const data = await apiRequest<UploadViaUrlData>('/upload/url', apiKey, {
    url: args.url,
  });
  return {
    success: true,
    assetUrl: data.assetUrl,
    fileId: data.fileId,
    message: `图片上传成功！资源 URL：${data.assetUrl}`,
  };
}

async function handleGetUploadAuth(args: { filename: string; contentType: string; size: number }) {
  const apiKey = getApiKey();
  const data = await apiRequest<UploadPrepareData>('/upload/prepare', apiKey, {
    filename: args.filename,
    contentType: args.contentType,
    size: args.size,
  });
  return {
    success: true,
    uploadUrl: data.uploadUrl,
    fileId: data.fileId,
    headers: data.headers,
    message: '获取上传授权成功，请使用返回的 uploadUrl 和 headers 进行文件上传',
  };
}

// Create and start server
const server = new Server(
  {
    name: 'mowen-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle call tool request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case 'mowen_create_note':
        result = await handleCreateNote(args as { title: string; content: string; isPublic?: boolean });
        break;
      case 'mowen_edit_note':
        result = await handleEditNote(args as { noteId: string; title?: string; content?: string });
        break;
      case 'mowen_set_note_privacy':
        result = await handleSetNotePrivacy(args as { noteId: string; isPublic: boolean });
        break;
      case 'mowen_upload_image_url':
        result = await handleUploadImageUrl(args as { url: string });
        break;
      case 'mowen_get_upload_auth':
        result = await handleGetUploadAuth(args as { filename: string; contentType: string; size: number });
        break;
      default:
        throw new Error(`未知的工具: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mowen MCP Server started');
}

main().catch(console.error);
