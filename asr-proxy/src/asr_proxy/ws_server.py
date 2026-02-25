"""
WebSocket 服务端
面向浏览器扩展的 WebSocket 服务
"""

import asyncio
import json
import logging
from typing import Set

import websockets
from websockets.server import WebSocketServerProtocol

from .config import settings
from .session_manager import SessionManager


# 抑制 websockets 库的 handshake 失败日志（健康检查探针等非 WS 连接）
_ws_logger = logging.getLogger("websockets")
_ws_logger.setLevel(logging.CRITICAL)
for _name in ("websockets.server", "websockets.asyncio.server"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)


# 活跃连接集合
active_connections: Set[WebSocketServerProtocol] = set()


async def handle_connection(websocket: WebSocketServerProtocol):
    """
    处理单个 WebSocket 连接

    协议：
    - 前端 → 服务：preconnect, start, audio, pause, resume, stop
    - 服务 → 前端：ready, event_partial, event_final, event_revise, error, metrics
    """
    active_connections.add(websocket)
    session: SessionManager | None = None
    preconnect_task: asyncio.Task | None = None

    async def send_to_client(data: dict):
        """发送消息到客户端"""
        try:
            await websocket.send(json.dumps(data))
        except Exception:
            pass

    try:
        print(f"[WS] 新连接: {websocket.remote_address}")

        while True:
            try:
                # decode=False 返回原始 bytes，避免二进制帧被 UTF-8 解码报错
                message = await websocket.recv(decode=False)
            except websockets.exceptions.ConnectionClosed:
                break

            try:
                # 二进制帧 = 音频数据，直接转发（无需 Base64 解码）
                if isinstance(message, bytes):
                    # 尝试判断是否为 JSON 文本（兼容文本帧也被当 bytes 返回的情况）
                    try:
                        text = message.decode('utf-8')
                        data = json.loads(text)
                        # 成功解析为 JSON，按控制消息处理
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        # 不是 JSON，是纯二进制音频数据
                        if session:
                            await session.process_audio_bytes(message)
                        continue
                else:
                    # 文本帧（str 类型）
                    data = json.loads(message)
                msg_type = data.get("type", "")

                if msg_type == "preconnect":
                    # 预连接：提前建立到 ASR 引擎的连接
                    if not session:
                        session = SessionManager(send_callback=send_to_client)
                        preconnect_task = asyncio.create_task(session.preconnect())
                        print(f"[WS] 预连接已触发: {session.session_id}")

                elif msg_type == "start":
                    # 等待预连接完成（如果有的话）
                    if preconnect_task:
                        try:
                            await preconnect_task
                        except Exception as e:
                            print(f"[WS] 预连接失败，将重新连接: {e}")
                            session = None
                        preconnect_task = None

                    if session and session.is_preconnected:
                        # 复用预连接的会话
                        audio_config = data.get("audioConfig", {})
                        await session.start_with_preconnect(audio_config)
                        print(f"[WS] 会话开始(预连接): {session.session_id}")
                    else:
                        # 无预连接，走原有流程
                        if session:
                            await session.stop()
                        session = SessionManager(send_callback=send_to_client)
                        audio_config = data.get("audioConfig", {})
                        await session.start(audio_config)
                        print(f"[WS] 会话开始: {session.session_id}")

                elif msg_type == "audio":
                    # 兼容旧版 Base64 JSON 格式
                    if session:
                        payload = data.get("payload", "")
                        await session.process_audio(payload)

                elif msg_type == "pause":
                    # 暂停
                    if session:
                        await session.pause()
                        print(f"[WS] 会话暂停: {session.session_id}")

                elif msg_type == "resume":
                    # 恢复
                    if session:
                        await session.resume()
                        print(f"[WS] 会话恢复: {session.session_id}")

                elif msg_type == "stop":
                    # 停止
                    if session:
                        await session.stop()
                        print(f"[WS] 会话停止: {session.session_id}")
                        session = None

                else:
                    print(f"[WS] 未知消息类型: {msg_type}")

            except json.JSONDecodeError:
                await send_to_client({
                    "type": "error",
                    "code": "INVALID_JSON",
                    "message": "无效的 JSON 格式",
                    "retriable": False,
                })
            except Exception as e:
                print(f"[WS] 处理消息错误: {e}")
                await send_to_client({
                    "type": "error",
                    "code": "INTERNAL_ERROR",
                    "message": str(e),
                    "retriable": False,
                })

    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.ConnectionClosedError):
        print(f"[WS] 连接关闭: {websocket.remote_address}")

    finally:
        # 清理
        if preconnect_task and not preconnect_task.done():
            preconnect_task.cancel()
        if session:
            await session.stop()
        active_connections.discard(websocket)


async def start_server():
    """启动 WebSocket 服务"""
    host = settings.ws_host
    port = settings.ws_port
    
    print(f"[ASR Proxy] 启动中...")
    print(f"[ASR Proxy] ASR Provider: {settings.asr_provider}")
    print(f"[ASR Proxy] 监听地址: ws://{host}:{port}")
    
    if settings.asr_provider == "volcengine":
        if settings.validate_volcengine_config():
            print(f"[ASR Proxy] 火山引擎配置: ✓")
            print(
                f"[ASR Proxy] 火山 Resource ID: "
                f"{settings.volc_effective_resource_id}"
            )
            if settings.has_legacy_volc_resource_id:
                print("[ASR Proxy] 检测到旧版 Resource ID，运行时已自动迁移到 2.0")
        else:
            print(f"[ASR Proxy] 火山引擎配置: ✗ (将降级到 Mock)")
    
    if settings.asr_provider == "tencent":
        if settings.validate_tencent_config():
            print(f"[ASR Proxy] 腾讯云配置: ✓")
        else:
            print(f"[ASR Proxy] 腾讯云配置: ✗ (将降级到 Mock)")
    
    async with websockets.serve(
        handle_connection,
        host,
        port,
        ping_interval=20,
        ping_timeout=10,
    ):
        print(f"[ASR Proxy] 服务已启动，等待连接...")
        await asyncio.Future()  # 永久运行


def run():
    """运行服务（同步入口）"""
    try:
        asyncio.run(start_server())
    except KeyboardInterrupt:
        print("\n[ASR Proxy] 服务已停止")
