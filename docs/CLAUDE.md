# Mowen Plugin

墨问笔记助手 Chrome 扩展项目。

## 开发命令

```bash
npm run dev      # 开发模式
npm run build    # 生产构建
npm run lint     # 代码检查
```

## 项目结构

- `src/popup/` - 弹窗 UI (React)
- `src/background/` - Service Worker
- `src/content/` - Content Script
- `src/services/api.ts` - Mowen API 封装
- `src/utils/noteAtom.ts` - NoteAtom 格式转换

## Mowen API 集成指南

### 认证
```http
Authorization: Bearer {API_KEY}
```

### API 端点

| 端点 | 路径 | 限频 |
|------|------|------|
| 笔记创建 | `POST /api/open/api/v1/note/create` | 1次/秒, 100次/天 |
| 笔记设置 | `POST /api/open/api/v1/note/set` | 1次/秒, 100次/天 |
| URL上传 | `POST /api/open/api/v1/upload/url` | 1次/秒, 200次/天 |

### NoteAtom 结构

笔记内容使用 ProseMirror 兼容的 JSON 格式：

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "内容" }]
    },
    {
      "type": "image",
      "attrs": { "uuid": "fileId", "align": "center" }
    }
  ]
}
```

**节点类型**: `doc` | `paragraph` | `text` | `quote` | `image` | `audio` | `pdf` | `note`

**标记类型**: `bold` | `highlight` | `link` (attrs: `{ href }`)

### 文件上传

```json
POST /upload/url
{
  "fileType": 1,  // 1=图片, 2=音频, 3=PDF
  "url": "https://...",
  "fileName": "name.png"
}
```

响应中 `file.fileId` 用作 NoteAtom 的 `uuid`。

### 错误处理

使用 `reason` 字段适配：
- `LOGIN` - 认证失败
- `PARAMS` - 参数错误
- `RATELIMIT` - 限频
- `NOT_FOUND` - 资源不存在
- `Quota` - 配额不足

## 重要提醒

- 单篇笔记内容控制在 **19,000 字符**以内
- 图片上传失败时应降级为外链
- 所有 API 需要墨问 Pro 会员
