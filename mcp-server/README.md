# 墨问 MCP Server

墨问笔记 MCP (Model Context Protocol) 服务器，允许 AI 助手通过 MCP 协议与墨问笔记 API 进行交互。

## 功能

- **mowen_create_note** - 创建新笔记
- **mowen_edit_note** - 编辑已有笔记
- **mowen_set_note_privacy** - 设置笔记公开/私密状态
- **mowen_upload_image_url** - 通过 URL 上传图片
- **mowen_get_upload_auth** - 获取本地文件上传授权

## 安装

```bash
cd mcp-server
npm install
npm run build
```

## 配置

### 1. 设置环境变量

在运行 MCP 服务器之前，需要设置墨问 API Key：

```bash
export MOWEN_API_KEY="your-api-key-here"
```

### 2. 配置 Claude Desktop

将以下配置添加到 Claude Desktop 的配置文件中：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mowen": {
      "command": "node",
      "args": ["/path/to/mowen-plugin/mcp-server/dist/index.js"],
      "env": {
        "MOWEN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

或者使用 npx（需要先发布到 npm）：

```json
{
  "mcpServers": {
    "mowen": {
      "command": "npx",
      "args": ["@mowen/mcp-server"],
      "env": {
        "MOWEN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## 使用示例

配置完成后，在 Claude Desktop 中可以使用以下工具：

### 创建笔记

```
请帮我在墨问中创建一篇笔记，标题是「今日待办」，内容是：
<ul>
  <li>完成项目报告</li>
  <li>回复客户邮件</li>
  <li>准备会议材料</li>
</ul>
```

### 上传图片

```
请帮我把这张图片上传到墨问：https://example.com/image.png
```

### 设置笔记公开

```
请把笔记 ID 为 abc123 的笔记设置为公开
```

## API 参考

### mowen_create_note

创建新笔记。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 笔记标题 |
| content | string | 是 | 笔记内容（HTML 格式） |
| isPublic | boolean | 否 | 是否公开，默认 false |

### mowen_edit_note

编辑已有笔记。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| noteId | string | 是 | 笔记 ID |
| title | string | 否 | 新标题 |
| content | string | 否 | 新内容（HTML 格式） |

### mowen_set_note_privacy

设置笔记隐私状态。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| noteId | string | 是 | 笔记 ID |
| isPublic | boolean | 是 | 是否公开 |

### mowen_upload_image_url

通过 URL 上传图片。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 图片 URL |

### mowen_get_upload_auth

获取本地文件上传授权。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filename | string | 是 | 文件名 |
| contentType | string | 是 | MIME 类型 |
| size | number | 是 | 文件大小（字节） |

## 许可证

MIT
