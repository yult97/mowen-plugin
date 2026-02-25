"""
火山引擎 ASR 客户端
实现火山引擎大模型流式语音识别的二进制 WebSocket 协议
"""

import asyncio
import json
import struct
import time
import uuid
import gzip
from typing import Callable, Optional, List

import websockets
from websockets.client import WebSocketClientProtocol

from .config import settings


# ============ 协议常量定义 ============

# 协议版本和 Header 大小
PROTOCOL_VERSION = 0b0001  # 协议版本 1
HEADER_SIZE = 0b0001       # Header 大小 = 1 个 4 字节单位

# 消息类型（Message Type）
MSG_FULL_CLIENT_REQUEST = 0b0001   # 客户端完整请求（含配置 JSON）
MSG_AUDIO_ONLY = 0b0010            # 仅音频数据
MSG_FULL_SERVER_RESPONSE = 0b1001  # 服务端完整响应
MSG_SERVER_ACK = 0b1011            # 服务端确认
MSG_SERVER_ERROR = 0b1111          # 服务端错误

# 消息类型特定标志
FLAG_NO_SEQUENCE = 0b0000  # 无序号
FLAG_POSITIVE_SEQUENCE = 0b0001  # 正序号
FLAG_NEGATIVE_SEQUENCE = 0b0010  # 负序号（结束）
FLAG_NEG_WITH_PAYLOAD = 0b0011   # 结束带结果

# 序列化方式
SERIAL_NONE = 0b0000  # 无序列化（原始字节）
SERIAL_JSON = 0b0001  # JSON

# 压缩方式
COMPRESS_NONE = 0b0000  # 无压缩
COMPRESS_GZIP = 0b0001  # Gzip


def build_header(
    msg_type: int,
    msg_type_flags: int = 0,
    serial_method: int = SERIAL_NONE,
    compression: int = COMPRESS_NONE
) -> bytes:
    """
    构建 4 字节二进制 header

    Header 结构（4 字节）：
    - Byte 0: [Protocol Version (4 bits)] [Header Size (4 bits)]
    - Byte 1: [Message Type (4 bits)] [Message Type Specific Flags (4 bits)]
    - Byte 2: [Serialization Method (4 bits)] [Compression (4 bits)]
    - Byte 3: Reserved (全 0)
    """
    byte0 = (PROTOCOL_VERSION << 4) | HEADER_SIZE
    byte1 = (msg_type << 4) | msg_type_flags
    byte2 = (serial_method << 4) | compression
    byte3 = 0  # Reserved

    return bytes([byte0, byte1, byte2, byte3])


def build_message(header: bytes, payload: bytes, sequence: int = None) -> bytes:
    """
    构建完整消息: 
    - Header (4 bytes)
    - [Sequence Number (4 bytes, big-endian)] (if sequence is provided)
    - Payload Size (4 bytes, big-endian)
    - Payload
    """
    msg = header
    
    if sequence is not None:
        msg += struct.pack(">i", sequence)
        
    payload_size = struct.pack(">I", len(payload))
    return msg + payload_size + payload


def parse_header(header: bytes) -> dict:
    """
    解析 4 字节 header
    """
    if len(header) < 4:
        raise ValueError(f"Header 长度不足: {len(header)}")

    byte0, byte1, byte2, byte3 = header[:4]

    return {
        "protocol_version": (byte0 >> 4) & 0x0F,
        "header_size": byte0 & 0x0F,
        "msg_type": (byte1 >> 4) & 0x0F,
        "msg_type_flags": byte1 & 0x0F,
        "serial_method": (byte2 >> 4) & 0x0F,
        "compression": byte2 & 0x0F,
        "reserved": byte3,
    }


class VolcengineClient:
    """
    火山引擎流式 ASR 客户端

    实现火山引擎大模型流式语音识别的二进制 WebSocket 协议
    接口地址: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
    默认 Resource ID: volc.seedasr.sauc.duration（Doubao-Seed-ASR-2.0）
    
    使用优化版双向流式模式：
    - 只在识别结果变化时返回数据，减少网络传输
    - RTF 更优，首尾字延迟更低
    """

    def __init__(
        self,
        on_partial: Optional[Callable[[str], None]] = None,
        on_final: Optional[Callable[[str], None]] = None,
        on_error: Optional[Callable[[str, str], None]] = None,
        hotwords: Optional[List[str]] = None,
    ):
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_error = on_error

        self._ws: Optional[WebSocketClientProtocol] = None
        self._running = False
        self._receive_task: Optional[asyncio.Task] = None
        self._session_id = ""
        self._first_result_time: Optional[float] = None
        self._start_time: Optional[float] = None
        self._sequence = 0
        # 用于等待服务器初始化确认
        self._init_ack_event: Optional[asyncio.Event] = None
        # 用于等待引擎处理完成（send_end 后的最终结果）
        self._completion_event: Optional[asyncio.Event] = None
        # 追踪已处理的 confirmed utterance 数量（用于避免重复发送）
        self._confirmed_count: int = 0
        # 热词列表
        self._hotwords = hotwords or []

    @property
    def ttfb_ms(self) -> Optional[int]:
        """首字延迟（毫秒）"""
        if self._first_result_time and self._start_time:
            return int((self._first_result_time - self._start_time) * 1000)
        return None

    async def connect(self) -> bool:
        """
        建立连接并发送初始化请求

        Returns:
            是否连接成功
        """
        print(f"[VolcengineClient] 连接中... 热词数量: {len(self._hotwords)}")
        if not settings.validate_volcengine_config():
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONFIG_MISSING",
                    "火山引擎配置不完整，请检查环境变量"
                )
            return False

        try:
            self._session_id = str(uuid.uuid4())
            self._start_time = time.time()
            resource_id = settings.volc_effective_resource_id

            # 构建连接 URL 和鉴权 Headers
            url = settings.volc_ws_url
            headers = {
                "X-Api-App-Key": settings.volc_app_id,
                "X-Api-Access-Key": settings.volc_access_token,
                "X-Api-Resource-Id": resource_id,
                "X-Api-Connect-Id": self._session_id,
            }
            if settings.has_legacy_volc_resource_id:
                print(
                    "[VolcengineClient] 检测到旧版 Resource ID，已自动迁移到 2.0: "
                    f"{resource_id}"
                )

            self._ws = await websockets.connect(
                url,
                additional_headers=headers,
                ping_interval=20,
                ping_timeout=10,
            )

            self._running = True
            
            # 创建 ACK 等待事件
            self._init_ack_event = asyncio.Event()
            # 创建完成等待事件（send_end 后等待引擎最终结果）
            self._completion_event = asyncio.Event()

            # 启动接收循环（需要先启动才能接收 ACK）
            self._receive_task = asyncio.create_task(self._receive_loop())
            
            # 发送初始化请求（full_client_request）
            await self._send_full_client_request()

            # 等待服务器返回 ACK，超时 3 秒
            try:
                await asyncio.wait_for(self._init_ack_event.wait(), timeout=3.0)
                print("[VolcengineClient] 收到初始化 ACK，服务就绪")
            except asyncio.TimeoutError:
                # Doubao-Seed-ASR-2.0 双向流式模式通常不发送 ACK，直接开始处理
                # 这是正常行为，不需要警告
                pass

            # 重置状态（新连接，清空已确认计数）
            self._confirmed_count = 0

            return True

        except Exception as e:
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONNECT_FAILED",
                    f"连接火山引擎失败: {str(e)}"
                )
            return False

    async def _send_full_client_request(self):
        """
        发送初始化请求（full_client_request）

        包含音频参数和识别配置
        """
        # 构建请求 JSON
        request_payload = {
            "user": {
                "uid": self._session_id,
            },
            "audio": {
                "format": "pcm",
                "sample_rate": 16000,
                "channel": 1,
                "bits": 16,
            },
            "request": {
                "model_name": "bigmodel",
                "enable_itn": True,             # 逆文本归一化（数字、日期等）
                "enable_punc": True,            # 自动标点
                "enable_ddc": True,             # 语义顺滑，去除语气词和重复词
                # result_type: "single" 返回当前 utterance 文本
                # 结合 show_utterances + definite 字段实现精确的分句追踪
                "result_type": "single",
                "show_utterances": True,        # 返回分句信息（含 definite 字段）
                # 注意：不设置 end_window_size，让引擎使用默认的 AI 语义分句
                # 设置 end_window_size 会屏蔽语义分句，改用静音时长判停，导致断句不自然
                # 默认行为：引擎根据语义完整性智能判断句子边界
            },
        }

        # 热词支持：corpus 作为顶层字段（与 user/audio/request 同级）
        if self._hotwords:
            request_payload["corpus"] = {
                "context": json.dumps({
                    "hotwords": [{"word": w} for w in self._hotwords[:500]]
                })
            }
            print(f"[VolcengineClient] 热词已注入: {len(self._hotwords[:500])} 个")

        payload_json = json.dumps(request_payload).encode("utf-8")

        # 构建 header: full_client_request + JSON 序列化
        header = build_header(
            msg_type=MSG_FULL_CLIENT_REQUEST,
            msg_type_flags=FLAG_NO_SEQUENCE,
            serial_method=SERIAL_JSON,
            compression=COMPRESS_NONE,
        )

        message = build_message(header, payload_json)
        await self._ws.send(message)

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
        发送音频数据（audio_only）

        Args:
            audio_data: PCM 音频数据（16kHz, 16bit, 单声道）
        """
        if not self._ws or not self._running:
            return

        try:
            # 构建 header: audio_only + 无序号（服务端自动分配）
            header = build_header(
                msg_type=MSG_AUDIO_ONLY,
                msg_type_flags=FLAG_NO_SEQUENCE,
                serial_method=SERIAL_NONE,
                compression=COMPRESS_NONE,
            )

            message = build_message(header, audio_data)
            await self._ws.send(message)

        except Exception as e:
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "SEND_FAILED",
                    f"发送音频失败: {str(e)}"
                )

    async def send_end(self):
        """
        发送结束信号

        使用 msg_type_flags=0b0010 表示结束标志（不带 sequence）
        这会告知服务端音频已结束，请处理剩余缓冲并返回最终结果
        """
        if not self._ws or not self._running:
            return

        try:
            # 重置完成事件（可能在 connect 时已创建）
            if self._completion_event:
                self._completion_event.clear()
            else:
                self._completion_event = asyncio.Event()

            # 构建 header: audio_only + 结束标志 (0b0010)
            # 注意：0b0010 表示结束且不带 sequence
            header = build_header(
                msg_type=MSG_AUDIO_ONLY,
                msg_type_flags=0b0010,  # 结束标志，不带 sequence
                serial_method=SERIAL_NONE,
                compression=COMPRESS_NONE,
            )

            # 结束帧无 payload
            message = build_message(header, b"")
            await self._ws.send(message)
            print("[VolcengineClient] 已发送结束信号")

        except Exception as e:
            print(f"[VolcengineClient] 发送结束信号失败: {e}")

    async def wait_completion(self, timeout: float = 2.0) -> bool:
        """
        等待引擎处理完成（send_end 后的最终结果）

        Args:
            timeout: 最大等待时间（秒）

        Returns:
            是否在超时前收到完成信号
        """
        if not self._completion_event:
            return False
        try:
            await asyncio.wait_for(self._completion_event.wait(), timeout=timeout)
            print(f"[VolcengineClient] 引擎处理完成")
            return True
        except asyncio.TimeoutError:
            print(f"[VolcengineClient] 等待引擎完成超时({timeout}s)")
            return False

    async def _receive_loop(self):
        """接收消息循环"""
        if not self._ws:
            return

        try:
            async for message in self._ws:
                if not self._running:
                    break

                # 处理二进制消息
                if isinstance(message, bytes):
                    await self._handle_binary_message(message)
                else:
                    # 文本消息（不应该发生）
                    print(f"[VolcengineClient] 收到意外的文本消息: {message}")

        except websockets.exceptions.ConnectionClosed:
            if self._running and self.on_error:
                await self._call_callback(
                    self.on_error,
                    "CONNECTION_CLOSED",
                    "连接已关闭"
                )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            if self._running and self.on_error:
                await self._call_callback(
                    self.on_error,
                    "RECEIVE_ERROR",
                    f"接收消息失败: {str(e)}"
                )

    async def _handle_binary_message(self, data: bytes):
        """
        处理火山返回的二进制消息

        服务端响应格式：
        - Header (4 bytes)
        - [Sequence (4 bytes)] - 当 msg_type_flags 指示有序号时存在
        - Payload size (4 bytes, big-endian)
        - Payload
        """
        try:
            if len(data) < 8:  # 至少需要 header (4) + payload_size (4)
                return

            # 解析 header
            header_info = parse_header(data[:4])
            offset = 4

            # 根据 msg_type_flags 判断是否包含 sequence number
            # 0b0001 = 正序号，0b0010 = 负序号，0b0011 = 结束带结果
            msg_type_flags = header_info["msg_type_flags"]
            if msg_type_flags in (FLAG_POSITIVE_SEQUENCE, FLAG_NEGATIVE_SEQUENCE, FLAG_NEG_WITH_PAYLOAD):
                # 跳过 4 字节的 sequence number
                offset += 4

            # 获取 payload size
            if len(data) < offset + 4:
                return
            payload_size = struct.unpack(">I", data[offset:offset + 4])[0]
            offset += 4

            # 获取 payload
            if len(data) < offset + payload_size:
                return
            payload = data[offset:offset + payload_size]

            # 解压缩（如果需要）
            if header_info["compression"] == COMPRESS_GZIP:
                payload = gzip.decompress(payload)

            # 根据消息类型处理
            msg_type = header_info["msg_type"]

            if msg_type == MSG_FULL_SERVER_RESPONSE:
                await self._handle_server_response(header_info, payload)
                # 结束标志（负序号）表示引擎已处理完所有音频
                if msg_type_flags in (FLAG_NEGATIVE_SEQUENCE, FLAG_NEG_WITH_PAYLOAD):
                    if self._completion_event and not self._completion_event.is_set():
                        self._completion_event.set()
            elif msg_type == MSG_SERVER_ACK:
                # 服务端确认消息，触发初始化完成事件
                if self._init_ack_event and not self._init_ack_event.is_set():
                    self._init_ack_event.set()
            elif msg_type == MSG_SERVER_ERROR:
                await self._handle_server_error(payload)
            else:
                print(f"[VolcengineClient] 未知消息类型: {msg_type}")

        except Exception as e:
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "PARSE_ERROR",
                    f"解析消息失败: {str(e)}"
                )

    async def _handle_server_response(self, header_info: dict, payload: bytes):
        """
        处理服务端响应

        根据序列化方式解析 payload
        """
        # 记录首次收到结果的时间
        if self._first_result_time is None:
            self._first_result_time = time.time()

        serial_method = header_info["serial_method"]

        if serial_method == SERIAL_JSON:
            try:
                result = json.loads(payload.decode("utf-8"))
                await self._process_asr_result(result)
            except json.JSONDecodeError as e:
                print(f"[VolcengineClient] JSON 解析失败: {e}")
        else:
            print(f"[VolcengineClient] 未支持的序列化方式: {serial_method}")

    async def _process_asr_result(self, result: dict):
        """
        处理 ASR 识别结果

        火山返回格式:
        {
            "result": {
                "text": "识别文本",
                "is_final": false/true,
                "utterances": [{
                    "text": "分句文本",
                    "definite": true/false  # 真正的最终确认标志
                }]
            }
        }
        
        注意：
        - is_final=true 表示当前 utterance 结束
        - utterances[].definite=true 表示该分句已最终确定，不会再变动
        """
        asr_result = result.get("result", {})
        text = asr_result.get("text", "")
        is_final = asr_result.get("is_final", False)
        utterances = asr_result.get("utterances", [])

        # 调试日志
        definite_info = ""
        if utterances:
            definite_flags = [u.get("definite", False) for u in utterances]
            definite_info = f", definite={definite_flags}"
        print(f"[ASR Result] is_final={is_final}{definite_info}, text='{text[:50]}{'...' if len(text) > 50 else ''}'")

        # 空 utterances 直接返回
        if not utterances:
            # 如果没有 utterances 但有 text，作为 partial 发送
            if text and self.on_partial:
                await self._call_callback(self.on_partial, text)
            return

        # result_type: "single" 模式下的处理逻辑：
        # - utterances 数组中 confirmed (definite=true) 从头部累积增长
        # - 用 _confirmed_count 记录已发送的 confirmed 数量，只发送新增的
        # - 最后一个 unconfirmed 作为 partial 发送

        # 分离 confirmed 和 unconfirmed
        confirmed_utterances = []
        last_unconfirmed = None
        for u in utterances:
            if u.get("definite", False):
                confirmed_utterances.append(u)
            else:
                last_unconfirmed = u

        # 检测 utterances 重置（新 utterance 开始，confirmed 数量减少）
        if len(confirmed_utterances) < self._confirmed_count:
            self._confirmed_count = 0

        # 发送新增的 confirmed utterances（跳过已发送的）
        for i in range(self._confirmed_count, len(confirmed_utterances)):
            confirmed_text = confirmed_utterances[i].get("text", "")
            if confirmed_text and self.on_final:
                print(f"[ASR] 发送 final: '{confirmed_text[:30]}{'...' if len(confirmed_text) > 30 else ''}'")
                await self._call_callback(self.on_final, confirmed_text)
        self._confirmed_count = len(confirmed_utterances)

        # 发送未确认的 utterance 作为 partial
        if last_unconfirmed:
            partial_text = last_unconfirmed.get("text", "")
            if partial_text and self.on_partial:
                await self._call_callback(self.on_partial, partial_text)
        elif confirmed_utterances and self.on_partial:
            # 只有确认的，没有未确认的，清空 partial
            await self._call_callback(self.on_partial, "")

    async def _handle_server_error(self, payload: bytes):
        """处理服务端错误"""
        try:
            error_info = json.loads(payload.decode("utf-8"))
            code = error_info.get("code", "UNKNOWN")
            message = error_info.get("message", "未知错误")

            if self.on_error:
                await self._call_callback(self.on_error, str(code), message)
        except Exception:
            if self.on_error:
                await self._call_callback(
                    self.on_error,
                    "UNKNOWN_ERROR",
                    payload.decode("utf-8", errors="ignore")
                )

    async def _call_callback(self, callback: Callable, *args):
        """调用回调函数（支持同步和异步）"""
        result = callback(*args)
        if asyncio.iscoroutine(result):
            await result
