# ASR Proxy 中转服务

火山引擎流式 ASR 中转代理服务。

## 核心特性

- ✅ **多 ASR 提供商支持**：火山引擎、腾讯云、Mock
- ✅ **智能语义分段**：基于语义完整性的段落划分（NEW）
- ✅ **LLM 智能纠错**：集成豆包/DeepSeek 进行语义纠错
- ✅ **流式处理**：低延迟实时语音转文字
- ✅ **容器化部署**：Docker + Docker Compose

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入火山引擎凭证

# 启动服务
python -m asr_proxy.main
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| VOLC_APP_ID | 火山引擎 AppId | - |
| VOLC_ACCESS_TOKEN | 火山引擎 Access Token | - |
| VOLC_RESOURCE_ID | 火山引擎 Resource ID | volc.seedasr.sauc.duration |
| WS_HOST | WebSocket 监听地址 | 0.0.0.0 |
| WS_PORT | WebSocket 监听端口 | 8765 |
| ASR_PROVIDER | ASR 提供商 (mock/volcengine/tencent) | mock |
| ENABLE_SEMANTIC_SEGMENTATION | 启用语义分段 | true |
| ENABLE_LLM_CORRECTION | 启用 LLM 纠错 | true |

更多配置项请参考 `.env.example`。

## 语义分段功能（NEW）

智能段落划分功能，基于语义完整性判断，显著提升分段准确率。

**特性**：
- 识别语义完整性（主谓宾结构）
- 检测连接词、助词等不完整特征
- 支持疑问句、转折句的自动识别
- 可选的 BERT 深度学习模型增强

**使用方法**：

在 `.env` 中配置：
```bash
ENABLE_SEMANTIC_SEGMENTATION=true
SEMANTIC_CONFIDENCE_THRESHOLD=0.7
```

详细文档：[语义分段使用指南](docs/semantic_segmentation_guide.md)

## Docker 部署

### 使用 Docker Compose（推荐）

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填入火山引擎凭证

# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 使用 OrbStack 管理

1. 确保已安装 [OrbStack](https://orbstack.dev/)
2. 构建镜像：`docker compose build`
3. 在 OrbStack 中可以看到 `asr-proxy` 容器
4. 通过 GUI 进行启动/停止/查看日志等操作

### 手动构建镜像

```bash
# 构建镜像
docker build -t asr-proxy:latest .

# 运行容器
docker run -d \
  --name asr-proxy \
  -p 8765:8765 \
  --env-file .env \
  asr-proxy:latest
```

## 协议

详见 `docs/protocol.md`
