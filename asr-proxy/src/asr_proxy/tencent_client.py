"""
腾讯云实时语音识别客户端
实现腾讯云 ASR WebSocket 协议 v2
文档: https://cloud.tencent.com/document/product/1093/52554
"""

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Callable, Optional
from urllib.parse import quote

import websockets
from websockets.client import WebSocketClientProtocol

from .config import settings


def _generate_signature(params: dict, secret_key: str) -> str:
    """
    生成腾讯云 ASR 签名

    签名步骤:
    1. 按参数名字母排序拼接 URL
    2. 用 HmacSha1 + SecretKey 加密
    3. Base64 编码
    """
    # 按字母排序拼接参数
    sorted_params = sorted(params.items())
    query_str = "&".join(f"{k}={v}" for k, v in sorted_params)

    # 拼接签名原文
    sign_str = f"asr.cloud.tencent.com/asr/v2/{settings.tencent_appid}?{query_str}"

    # HmacSha1 签名
    hmac_digest = hmac.new(
        secret_key.encode("utf-8"),
        sign_str.encode("utf-8"),
        hashlib.sha1,
    ).digest()

    return base64.b64encode(hmac_digest).decode("utf-8")


class TencentClient:
    """
    腾讯云实时语音识别客户端

    协议: wss://asr.cloud.tencent.com/asr/v2/<appid>?{params}
    音频: 直接发送 PCM 二进制帧
    结果: JSON 文本消息, slice_type 区分 partial/final
    结束: 发送 {"type": "end"} 文本消息
    """

    def __init__(
        self,
        on_partial: Optional[Callable[[str], None]] = None,
        on_final: Optional[Callable[[str], None]] = None,
        on_error: Optional[Callable[[str, str], None]] = None,
    ):
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_error = on_error

        self._ws: Optional[WebSocketClientProtocol] = None
        self._running = False
        self._receive_task: Optional[asyncio.Task] = None
        self._voice_id = ""
        self._first_result_time: Optional[float] = None
        self._start_time: Optional[float] = None

    @property
    def ttfb_ms(self) -> Optional[int]:
        """首字延迟（毫秒）"""
        if self._first_result_time and self._start_time:
            return int((self._first_result_time - self._start_time) * 1000)
        return None

    def _build_ws_url(self) -> str:
        """构建带签名的 WebSocket URL"""
        now = int(time.time())
        self._voice_id = uuid.uuid4().hex[:16]

        params = {
            "secretid": settings.tencent_secret_id,
            "timestamp": str(now),
            "expired": str(now + 86400),
            "nonce": str(now),
            "engine_model_type": settings.tencent_engine_type,
            "voice_id": self._voice_id,
            "voice_format": "1",  # 1=pcm
            "needvad": "1",
            "filter_dirty": "1",
            "filter_modal": "1",
            "filter_punc": "0",
            "convert_num_mode": "1",
            "word_info": "0",
        }

        # 生成签名（用原始参数值）
        signature = _generate_signature(params, settings.tencent_secret_key)

        # 构建最终 URL，所有参数值和签名都需要 URL encode
        encoded_parts = []
        for k, v in sorted(params.items()):
            encoded_parts.append(f"{quote(k, safe='')}={quote(v, safe='')}")
        encoded_parts.append(f"signature={quote(signature, safe='')}")

        query_str = "&".join(encoded_parts)
        return f"wss://asr.cloud.tencent.com/asr/v2/{settings.tencent_appid}?{query_str}"

    async def connect(self) -> bool:
        """建立连接"""
        if not settings.validate_tencent_config():
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONFIG_MISSING",
                    "腾讯云配置不完整，请检查环境变量",
                )
            return False

        try:
            self._start_time = time.time()
            url = self._build_ws_url()

            self._ws = await websockets.connect(
                url,
                ping_interval=20,
                ping_timeout=10,
            )

            self._running = True

            # 等待握手响应
            handshake_msg = await asyncio.wait_for(self._ws.recv(), timeout=10)
            handshake = json.loads(handshake_msg)

            if handshake.get("code") != 0:
                msg = handshake.get("message", "握手失败")
                # 握手失败，清理连接
                self._running = False
                await self._ws.close()
                self._ws = None
                if self.on_error:
                    await self._call_callback(self.on_error, "HANDSHAKE_FAILED", msg)
                return False

            print(f"[TencentClient] 握手成功, voice_id={self._voice_id}")

            # 启动接收循环
            self._receive_task = asyncio.create_task(self._receive_loop())
            return True

        except Exception as e:
            # 连接异常，确保清理
            self._running = False
            if self._ws:
                try:
                    await self._ws.close()
                except Exception:
                    pass
                self._ws = None
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONNECT_FAILED",
                    f"连接腾讯云失败: {str(e)}",
                )
            return False

    async def disconnect(self):
        """断开连接"""
        self._running = False

        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None

        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    async def send_audio(self, audio_data: bytes):
        """
        发送音频数据

        Args:
            audio_data: PCM 音频数据（16kHz, 16bit, 单声道）
        """
        if not self._ws or not self._running:
            return

        try:
            await self._ws.send(audio_data)
        except Exception as e:
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "SEND_FAILED",
                    f"发送音频失败: {str(e)}",
                )

    async def send_end(self, wait_completion: bool = False):
        """
        发送结束信号
        
        Args:
            wait_completion: 是否等待服务端返回最后的识别结果
        """
        if not self._ws or not self._running:
            return

        try:
            await self._ws.send(json.dumps({"type": "end"}))
            # stop 场景：等待服务端处理剩余音频并返回最后结果
            # pause 场景：不等待，直接断开
            if wait_completion and self._receive_task:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._receive_task), timeout=5.0
                    )
                except (asyncio.TimeoutError, Exception):
                    pass
        except Exception:
            pass

    async def _receive_loop(self):
        """接收消息循环"""
        if not self._ws:
            return

        try:
            async for message in self._ws:
                if not self._running:
                    break

                if isinstance(message, str):
                    await self._handle_message(message)

        except websockets.exceptions.ConnectionClosed:
            # 仅在非主动断开时报错
            if self._running and self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONNECTION_CLOSED",
                    "连接已关闭",
                )
        except asyncio.CancelledError:
            # disconnect() 取消任务，正常退出
            pass
        except Exception as e:
            if self._running and self.on_error:
                await self._call_callback(
                    self.on_error,
                    "RECEIVE_ERROR",
                    f"接收消息失败: {str(e)}",
                )

    async def _handle_message(self, raw: str):
        """处理腾讯云返回的 JSON 消息"""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            print(f"[TencentClient] JSON 解析失败: {raw[:100]}")
            return

        code = data.get("code", 0)
        if code != 0:
            msg = data.get("message", "未知错误")
            if self.on_error:
                await self._call_callback(self.on_error, str(code), msg)
            return

        # final=1 表示整个音频流识别完成
        if data.get("final") == 1:
            print("[TencentClient] 识别完成 (final=1)")
            return

        result = data.get("result")
        if not result:
            return

        # 记录首次收到结果的时间
        if self._first_result_time is None:
            self._first_result_time = time.time()

        slice_type = result.get("slice_type", -1)
        text = result.get("voice_text_str", "")

        print(
            f"[ASR Result] slice_type={slice_type}, "
            f"text='{text[:50]}{'...' if len(text) > 50 else ''}'"
        )

        if not text:
            return

        if slice_type == 2:
            # 句子结束 — 稳态结果
            if self.on_final:
                await self._call_callback(self.on_final, text)
        elif slice_type in (0, 1):
            # 句子开始 / 识别中 — 非稳态结果
            if self.on_partial:
                await self._call_callback(self.on_partial, text)

    async def _call_callback(self, callback: Callable, *args):
        """调用回调函数（支持同步和异步）"""
        result = callback(*args)
        if asyncio.iscoroutine(result):
            await result
