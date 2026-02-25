# ASR Proxy Docker 镜像
# 基于 Python 3.11 slim 镜像，体积更小

FROM python:3.11-slim AS builder

WORKDIR /app

# 安装构建依赖
RUN pip install --no-cache-dir --upgrade pip

# 复制依赖文件
COPY requirements.txt pyproject.toml ./

# 安装依赖到独立目录
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ============ 生产镜像 ============
FROM python:3.11-slim

WORKDIR /app

# 从 builder 阶段复制已安装的依赖
COPY --from=builder /install /usr/local

# 复制源代码
COPY src/ ./src/

# 设置 Python 路径
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

# 暴露端口
EXPOSE 8765

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import socket; s=socket.socket(); s.connect(('localhost', 8765)); s.close()" || exit 1

# 启动命令
CMD ["python", "-m", "asr_proxy.main"]
