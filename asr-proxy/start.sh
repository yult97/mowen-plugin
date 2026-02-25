#!/bin/bash
# ASR Proxy 启动脚本
# 使用方法: ./start.sh

set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔄 检查端口 8765..."

# 杀死占用端口 8765 的进程
if lsof -ti:8765 > /dev/null 2>&1; then
    echo "  → 发现端口 8765 被占用，正在释放..."
    lsof -ti:8765 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

echo "✅ 端口 8765 可用"

# 激活虚拟环境
echo "🔄 激活虚拟环境..."
source .venv/bin/activate

# 启动服务
echo ""
echo "🚀 启动 ASR Proxy..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python -m asr_proxy.main
