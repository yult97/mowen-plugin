---
description: 墨问 API 技能文档 - 完整的 API 集成指南
---

# 墨问 (Mowen) API 技能文档

## 概述

墨问 API 是一套用于程序化操作墨问笔记的开放接口，支持笔记创建、编辑、设置和文件上传。

### 基本信息

| 项目 | 值 |
|------|-------|
| **API 域名** | `https://open.mowen.cn` |
| **API 基础路径** | `/api/open/api/v1` |
| **会员要求** | 墨问 Pro 会员 |
| **认证方式** | Bearer Token (API-KEY) |

### 认证

所有 API 请求需要在 Header 中携带 API-KEY：

```http
Authorization: Bearer {YOUR_API_KEY}
```

> **获取 API-KEY**: 在墨问 App 或 Web 端的「设置」→「墨问 OpenAPI」中获取。
> **遗失处理**: 可通过 API 重置接口获取新的 API-KEY。

---

## API 端点

### 1. 笔记创建 (Note Create)

创建一篇新笔记。

| 属性 | 值 |
|------|-------|
| **路径** | `POST /api/open/api/v1/note/create` |
| **限频** | 1 次/秒 |
| **每日配额** | 100 次/天 |

#### 请求体 (NoteCreateRequest)

```json
{
  "body": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "这是笔记内容" }
        ]
      }
    ]
  },
  "settings": {
    "autoPublish": true,
    "tags": ["标签1", "标签2"]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `body` | NoteAtom | ✅ | 笔记内容（见 NoteAtom 结构） |
| `settings.autoPublish` | boolean | ❌ | 是否自动发布 |
| `settings.tags` | string[] | ❌ | 标签列表（≤10个，每个≤30字符） |

#### 响应 (NoteCreateReply)

```json
{
  "noteId": "xYzAbC123"
}
```

---

### 2. 笔记编辑 (Note Edit)

编辑已存在的笔记内容。

| 属性 | 值 |
|------|-------|
| **路径** | `POST /api/open/api/v1/note/edit` |
| **限频** | 1 次/秒 |

#### 请求体

```json
{
  "noteId": "xYzAbC123",
  "body": { ... }  // NoteAtom 格式
}
```

---

### 3. 笔记设置 (Note Set)

更新笔记的隐私设置。

| 属性 | 值 |
|------|-------|
| **路径** | `POST /api/open/api/v1/note/set` |
| **限频** | 1 次/秒 |
| **每日配额** | 100 次/天 |

#### 请求体 (NoteSetRequest)

```json
{
  "noteId": "xYzAbC123",
  "section": 1,
  "settings": {
    "privacy": {
      "type": "public",
      "rule": {
        "noShare": false,
        "expireAt": "0"
      }
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `noteId` | string | 笔记 ID |
| `section` | int | 设置类别：`1` = 隐私设置 |
| `settings.privacy.type` | string | `public` / `private` / `rule` |
| `settings.privacy.rule.noShare` | boolean | 是否禁止分享（默认 false） |
| `settings.privacy.rule.expireAt` | string | 公开截止时间戳（秒），0 = 永久 |

---

### 4. 基于 URL 上传文件 (Upload via URL)

通过远程 URL 上传文件到墨问。

| 属性 | 值 |
|------|-------|
| **路径** | `POST /api/open/api/v1/upload/url` |
| **限频** | 1 次/秒 |
| **每日配额** | 200 次/天 |

#### 文件限制

| 类型 | 最大大小 | 支持的 MIME |
|------|----------|-------------|
| 图片 | 30MB | image/gif, image/jpeg, image/png, image/webp |
| 音频 | 100MB | audio/mpeg, audio/mp4, audio/x-m4a |
| PDF | 50MB | application/pdf |

#### 请求体 (UploadViaURLRequest)

```json
{
  "fileType": 1,
  "url": "https://example.com/image.png",
  "fileName": "my-image.png"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fileType` | int | ✅ | `1` = 图片, `2` = 音频, `3` = PDF |
| `url` | string | ✅ | 文件的远程 URL |
| `fileName` | string | ❌ | 文件名（不填则自动生成） |

#### 响应 (UploadViaURLReply)

```json
{
  "file": {
    "fileId": "abc123",
    "url": "https://cdn.mowen.cn/...",
    "name": "my-image.png",
    "type": 1,
    "size": "102400",
    "mime": "image/png"
  }
}
```

> ⚠️ **注意**: URL 上传依赖远程服务器响应速度，可能因超时、防盗链等原因失败。不建议用于大文件。

---

## NoteAtom 结构

NoteAtom 是墨问笔记内容的数据结构，基于 ProseMirror 格式。

### 节点类型

| type | 类别 | 说明 |
|------|------|------|
| `doc` | 根节点 | 顶层必须是 doc |
| `paragraph` | block | 段落 |
| `text` | inline | 文本内容 |
| `quote` | block | 引用块 |
| `image` | block | 图片 |
| `audio` | block | 音频 |
| `pdf` | block | PDF 文件 |
| `note` | block | 内链笔记 |

### 标记类型 (marks)

| type | 说明 | attrs |
|------|------|-------|
| `bold` | 加粗 | - |
| `highlight` | 高亮 | - |
| `link` | 链接 | `{ href: "url" }` |

### 属性 (attrs)

| 属性 | 适用节点 | 说明 |
|------|----------|------|
| `uuid` | image, audio, pdf, note | 文件/笔记 ID |
| `href` | link (marks) | 链接地址 |
| `align` | image | 对齐方式: left/center/right |
| `alt` | image | 图片描述 |
| `show-note` | audio | 音频 ShowNote |

### 完整示例

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "普通文本" },
        { "type": "text", "text": "加粗文字", "marks": [{ "type": "bold" }] },
        { "type": "text", "text": "链接文字", "marks": [
          { "type": "link", "attrs": { "href": "https://example.com" } }
        ]}
      ]
    },
    {
      "type": "image",
      "attrs": {
        "uuid": "iLg8nJvIhexM-VxBHjXYZ",
        "align": "center",
        "alt": "图片描述"
      }
    },
    {
      "type": "quote",
      "content": [
        { "type": "text", "text": "这是引用内容" }
      ]
    }
  ]
}
```

---

## 错误码

### 错误响应结构

```json
{
  "code": 404,
  "reason": "NOT_FOUND",
  "message": "详细错误信息",
  "metadata": {}
}
```

### 常见错误

| reason | HTTP 状态码 | 说明 |
|--------|-------------|------|
| `LOGIN` | 400 | 缺少 API-KEY 或无法识别身份 |
| `PARAMS` | 400 | 参数错误 |
| `PERM` | 403 | 权限错误（如编辑他人笔记） |
| `NOT_FOUND` | 404 | 资源未找到 |
| `RATELIMIT` | 429 | 请求被限频 |
| `RISKY` | 403 | 有风险的请求 |
| `BLOCKED` | 403 | 账户或请求被封禁 |
| `Quota` | 403 | 配额不足 |

> 💡 **开发建议**: 使用 `reason` 字段进行错误适配，而非 `code`。

---

## 集成示例 (TypeScript)

```typescript
const API_BASE = 'https://open.mowen.cn/api/open/api/v1';

async function createNote(apiKey: string, content: string): Promise<string> {
  const response = await fetch(`${API_BASE}/note/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: content }]
          }
        ]
      },
      settings: { autoPublish: false }
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`API Error: ${error.reason} - ${error.message}`);
  }

  const data = await response.json();
  return data.noteId;
}

async function uploadImage(apiKey: string, imageUrl: string): Promise<string> {
  const response = await fetch(`${API_BASE}/upload/url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      fileType: 1,
      url: imageUrl,
      fileName: 'uploaded-image.png'
    }),
  });

  if (!response.ok) {
    throw new Error('Upload failed');
  }

  const data = await response.json();
  return data.file.fileId; // Use as uuid in NoteAtom
}
```

---

## 最佳实践

1. **限频处理**: 所有 API 限频 1 次/秒，请实现请求队列或重试机制。
2. **错误重试**: 对于 `RATELIMIT` 错误，建议指数退避重试。
3. **图片上传**: 优先使用 URL 上传；如失败，可降级为在笔记中使用外链 `<a href="...">`。
4. **配额管理**: 每日配额有限，合理规划调用频率。
5. **内容分割**: 单篇笔记内容建议控制在 19,000 字符以内，超出时分割成多篇。

---

## 参考链接

- [官方 API 文档](https://mowen.apifox.cn/)
- [NoteAtom 结构说明](https://mowen.apifox.cn/6682171m0)
- [错误码说明](https://mowen.apifox.cn/6688045m0)
