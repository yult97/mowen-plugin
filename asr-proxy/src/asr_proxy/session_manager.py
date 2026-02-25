"""
会话管理器
管理单个客户端会话的生命周期
"""

import asyncio
import base64
import re
import uuid
import time
from typing import Optional, Callable, Any, List, Tuple

from .config import settings
from .result_adapter import ResultAdapter
from .mock_transcriber import MockTranscriber
from .volcengine_client import VolcengineClient
from .tencent_client import TencentClient
from .audio_transcoder import get_transcoder
from .llm_corrector import LLMCorrector
from .doubao_corrector import DoubaoCorrector
from .semantic_segmenter import SemanticSegmenter


class SessionManager:
    """
    会话管理器

    职责：
    1. 管理客户端会话生命周期
    2. 根据配置选择 Mock 或 Volcengine 转写器
    3. 处理音频数据和事件转发

    数据流策略（火山引擎 result_type: "single"）：
    - partial: 每个 utterance 内累积增长，直接转发给前端显示
    - final (is_final=true): utterance 结束的完整文本，追加到 finalTextBlocks
    - 不做分句切换猜测，完全信任火山引擎的 is_final 信号
    - 暂停时若有未确认的 partial，保存为 final（唯一手动保存场景）

    LLM 纠错策略（滑动窗口批量纠错）：
    - final 事件不再立即触发纠错，而是累积到缓冲区
    - 当缓冲区达到 window_size 或静默超时后，批量发送给 LLM
    - 批量纠错提供更充分的上下文，纠错精度更高
    - DeepSeek 回退到逐句纠错模式
    """

    def __init__(self, send_callback: Callable[[dict], Any]):
        """
        Args:
            send_callback: 向客户端发送消息的回调函数
        """
        self.send_callback = send_callback
        self.session_id = str(uuid.uuid4())

        self._adapter = ResultAdapter()
        self._transcriber: Optional[MockTranscriber] = None
        self._volc_client: Optional[VolcengineClient] = None
        self._tencent_client: Optional[TencentClient] = None
        self._start_time: Optional[float] = None
        self._is_active = False
        self._is_preconnected = False
        # 记录最新的 partial 文本（用于暂停时保存）
        self._last_partial_text: str = ""
        # LLM 纠错器（支持豆包或 DeepSeek）
        self._corrector = None  # LLMCorrector 或 DoubaoCorrector
        # 后台任务集合（防止 asyncio.create_task 创建的任务被 GC 回收）
        self._pending_tasks: set = set()
        # 滑动窗口纠错缓冲区：[(block_index, text), ...]
        self._correction_buffer: List[Tuple[int, str]] = []
        # 静默超时定时器句柄
        self._flush_timer: Optional[asyncio.TimerHandle] = None
        # 噪音文本过滤：记录最近的 final 文本用于重复检测
        self._recent_finals: List[str] = []
        # 语义分段器（可选）
        self._semantic_segmenter: Optional[SemanticSegmenter] = None
        # 语义分段缓冲区：累积 final 文本，等待语义完整后再发送
        self._segment_buffer: List[str] = []
        if settings.enable_semantic_segmentation:
            self._semantic_segmenter = SemanticSegmenter(
                min_segment_length=settings.semantic_min_segment_length,
                max_segment_length=settings.semantic_max_segment_length,
                confidence_threshold=settings.semantic_confidence_threshold,
                enable_bert=settings.semantic_enable_bert,
            )

    # ============ 噪音文本过滤 (Agent 4.1) ============

    # 无意义短文本模式：常见的噪音误识别结果
    _NOISE_PATTERNS = re.compile(
        r'^[\s，。、！？,.!?\s]*$'  # 纯标点/空白
        r'|^(嗯+|啊+|呃+|哦+|噢+|唔+|哎+|嘿+|呀+|哈+)[，。！？\s]*$'  # 纯语气词
    )

    # 重复文本检测：同一短语重复出现（如"听见，近期听见"）
    _REPEAT_PATTERN = re.compile(r'^(.{1,6})[，,、\s]*(?:近期|最近|刚才|然后)?\1[，。！？\s]*$')

    def _is_noise_text(self, text: str) -> bool:
        """
        检测 final 文本是否为噪音产生的无意义文本

        过滤规则：
        1. 纯标点/空白
        2. 纯语气词（嗯、啊、呃等）
        3. 常见噪音误识别词（听见、听到等）
        4. 短文本重复模式（如"听见，近期听见"）
        5. 与最近 final 完全重复的短文本
        """
        stripped = text.strip()

        # 过短文本（去除标点后 <= 1 个字符）
        content_only = re.sub(r'[，。、！？,.!?\s]', '', stripped)
        if len(content_only) <= 1:
            print(f"[NoiseFilter] 过滤过短文本: '{stripped}'")
            return True

        # 匹配噪音模式
        if self._NOISE_PATTERNS.match(stripped):
            print(f"[NoiseFilter] 过滤噪音模式: '{stripped}'")
            return True

        # 重复文本检测
        if self._REPEAT_PATTERN.match(stripped):
            print(f"[NoiseFilter] 过滤重复文本: '{stripped}'")
            return True

        # 与最近 final 完全重复（短文本才检查，长文本可能是合理重复）
        if len(content_only) <= 8 and stripped in self._recent_finals:
            print(f"[NoiseFilter] 过滤重复 final: '{stripped}'")
            return True

        return False

    def _track_recent_final(self, text: str):
        """记录最近的 final 文本（保留最近 5 条）"""
        self._recent_finals.append(text.strip())
        if len(self._recent_finals) > 5:
            self._recent_finals.pop(0)

    async def _process_semantic_segmentation(self, text: str):
        """
        处理语义分段

        将文本加入分段缓冲区，使用语义分段器判断是否应该分段。
        只有在语义完整时才发送 final 事件。

        Args:
            text: 新到达的 final 文本
        """
        # 添加到分段缓冲区
        self._segment_buffer.append(text)

        # 判断是否应该分段
        should_segment, confidence, reason = self._semantic_segmenter.should_segment(
            self._segment_buffer
        )

        print(f"[SemanticSegmentation] 缓冲区: {len(self._segment_buffer)} 句, "
              f"分段判断: {should_segment} (置信度: {confidence:.2f}, 原因: {reason})")

        if should_segment:
            # 语义完整，发送段落
            segment_text = ' '.join(self._segment_buffer)
            event = self._adapter.process_final(segment_text)
            await self._send(event)

            print(f"[SemanticSegmentation] 发送段落: '{segment_text[:50]}...' "
                  f"({len(segment_text)} 字符)")

            # 清空缓冲区
            self._segment_buffer = []
        else:
            # 语义不完整，继续累积
            print(f"[SemanticSegmentation] 继续累积，当前缓冲区: "
                  f"{' '.join(self._segment_buffer)[:50]}...")

    @property
    def is_preconnected(self) -> bool:
        """是否已完成预连接"""
        return self._is_preconnected

    async def preconnect(self):
        """
        预连接 ASR 引擎

        仅建立到 ASR 引擎的连接，不启动完整会话。
        当后续收到 start 消息时，可以跳过连接步骤直接开始。
        """
        if settings.asr_provider == "volcengine":
            from .hotwords import hotword_manager
            self._volc_client = VolcengineClient(
                on_partial=self._on_partial,
                on_final=self._on_final,
                on_error=self._on_error,
                hotwords=hotword_manager.get_hotwords(),
            )
            success = await self._volc_client.connect()
            if success:
                self._is_preconnected = True
                print(f"[SessionManager] 预连接火山引擎成功: {self.session_id}")
            else:
                self._volc_client = None
                print(f"[SessionManager] 预连接火山引擎失败: {self.session_id}")
        elif settings.asr_provider == "tencent":
            self._tencent_client = TencentClient(
                on_partial=self._on_partial,
                on_final=self._on_final,
                on_error=self._on_error,
            )
            success = await self._tencent_client.connect()
            if success:
                self._is_preconnected = True
                print(f"[SessionManager] 预连接腾讯云成功: {self.session_id}")
            else:
                self._tencent_client = None
                print(f"[SessionManager] 预连接腾讯云失败: {self.session_id}")

    async def start_with_preconnect(self, audio_config: Optional[dict] = None):
        """
        使用已预连接的 ASR 引擎启动会话

        跳过 ASR 连接步骤，直接初始化会话状态并发送 ready。
        """
        self._start_time = time.time()
        self._is_active = True
        self._adapter.reset()
        self._last_partial_text = ""
        self._correction_buffer = []
        self._segment_buffer = []
        self._cancel_flush_timer()
        self._recent_finals = []
        if self._corrector and hasattr(self._corrector, 'reset_context'):
            self._corrector.reset_context()

        # ASR 引擎已在 preconnect 中连接，无需重复连接
        # 如果预连接的引擎不可用，降级到普通 start
        if not self._volc_client and not self._tencent_client:
            print(f"[SessionManager] 预连接引擎不可用，降级到普通启动")
            await self.start(audio_config)
            return

        # 预初始化 LLM 纠错器
        if settings.enable_llm_correction and self._has_llm_config():
            self._ensure_corrector()

        # 发送 ready 事件
        await self._send({
            "type": "ready",
            "sessionId": self.session_id,
        })
        print(f"[SessionManager] 会话就绪(预连接): {self.session_id}")

    async def start(self, audio_config: Optional[dict] = None):
        """
        开始会话
        
        Args:
            audio_config: 音频配置（可选）
        """
        self._start_time = time.time()
        self._is_active = True
        self._adapter.reset()
        self._last_partial_text = ""  # 重置分句检测状态
        self._correction_buffer = []  # 重置纠错缓冲区
        self._segment_buffer = []  # 重置语义分段缓冲区
        self._cancel_flush_timer()  # 取消可能残留的定时器
        self._recent_finals = []  # 重置噪音过滤状态
        # 重置纠错器上下文（新会话/补录时清空前文缓存）
        if self._corrector and hasattr(self._corrector, 'reset_context'):
            self._corrector.reset_context()
        
        if settings.asr_provider == "volcengine":
            await self._start_volcengine()
        elif settings.asr_provider == "tencent":
            await self._start_tencent()
        else:
            await self._start_mock()

        # 预初始化 LLM 纠错器（避免首次纠错时冷启动导致超时）
        if settings.enable_llm_correction and self._has_llm_config():
            self._ensure_corrector()

        # 发送 ready 事件
        await self._send({
            "type": "ready",
            "sessionId": self.session_id,
        })
    
    async def _start_mock(self):
        """启动 Mock 转写器"""
        self._transcriber = MockTranscriber(
            on_partial=self._on_partial,
            on_final=self._on_final,
        )
        await self._transcriber.start()
    
    async def _start_volcengine(self):
        """启动火山引擎客户端"""
        from .hotwords import hotword_manager
        self._volc_client = VolcengineClient(
            on_partial=self._on_partial,
            on_final=self._on_final,
            on_error=self._on_error,
            hotwords=hotword_manager.get_hotwords(),
        )
        success = await self._volc_client.connect()
        if not success:
            self._volc_client = None  # 清空失败的客户端引用
            # 降级到 Mock
            await self._send({
                "type": "error",
                "code": "VOLCENGINE_UNAVAILABLE",
                "message": "火山引擎不可用，已降级到 Mock 模式",
                "retriable": False,
            })
            await self._start_mock()
    
    async def _start_tencent(self):
        """启动腾讯云客户端"""
        self._tencent_client = TencentClient(
            on_partial=self._on_partial,
            on_final=self._on_final,
            on_error=self._on_error,
        )
        success = await self._tencent_client.connect()
        if not success:
            self._tencent_client = None  # 清空失败的客户端引用
            # 降级到 Mock
            await self._send({
                "type": "error",
                "code": "TENCENT_UNAVAILABLE",
                "message": "腾讯云不可用，已降级到 Mock 模式",
                "retriable": False,
            })
            await self._start_mock()
    
    async def stop(self):
        """停止会话"""
        self._cancel_flush_timer()

        # 第一步：通知 ASR 引擎音频结束，等待引擎处理剩余缓冲区
        # 此时 _on_partial/_on_final 回调仍在工作，会更新 _last_partial_text
        if self._volc_client:
            await self._volc_client.send_end()
            await self._volc_client.wait_completion(timeout=2.0)

        if self._tencent_client:
            await self._tencent_client.send_end(wait_completion=True)

        # 第二步：标记会话结束，停止接收新数据
        self._is_active = False

        # 刷新语义分段缓冲区中的剩余内容
        if settings.enable_semantic_segmentation and self._segment_buffer:
            segment_text = ' '.join(self._segment_buffer)
            final_event = self._adapter.process_final(segment_text)
            await self._send(final_event)
            print(f"[SemanticSegmentation] 停止时刷新剩余段落: '{segment_text[:50]}...'")
            self._segment_buffer = []

        # 停止时保存未确认的 partial 文本（与 pause 逻辑一致）
        if self._last_partial_text:
            final_event = self._adapter.process_final(self._last_partial_text)
            await self._send(final_event)
            has_llm_config = self._has_llm_config()
            if settings.enable_llm_correction and has_llm_config and len(self._last_partial_text) >= settings.llm_min_text_len:
                block_index = self._adapter._block_index
                self._correction_buffer.append((block_index, self._last_partial_text))
                print(f"[DEBUG] 停止时保存 partial 到纠错缓冲区: block {block_index}, 长度 {len(self._last_partial_text)}")
            self._last_partial_text = ""

        # 刷新纠错缓冲区中的剩余内容（stop 时兜底）
        has_llm_config = self._has_llm_config()
        if settings.enable_llm_correction and has_llm_config and self._correction_buffer:
            await self._flush_correction_buffer()

        # 等待所有进行中的纠错任务完成
        if self._pending_tasks:
            print(f"[SessionManager] 等待 {len(self._pending_tasks)} 个纠错任务完成...")
            done, pending = await asyncio.wait(
                self._pending_tasks, timeout=15.0
            )
            if pending:
                print(f"[SessionManager] {len(pending)} 个纠错任务超时，跳过")

        # 收集指标
        metrics = self._adapter.get_metrics()
        if self._volc_client and self._volc_client.ttfb_ms:
            metrics["ttfb_ms"] = self._volc_client.ttfb_ms
        if self._tencent_client and self._tencent_client.ttfb_ms:
            metrics["ttfb_ms"] = self._tencent_client.ttfb_ms

        if self._transcriber:
            await self._transcriber.stop()
            self._transcriber = None

        # 第三步：断开 ASR 引擎连接（send_end 已在第一步完成）
        if self._volc_client:
            await self._volc_client.disconnect()
            self._volc_client = None

        if self._tencent_client:
            await self._tencent_client.disconnect()
            self._tencent_client = None

        # 关闭 LLM 纠错器的 httpx 客户端
        if self._corrector:
            await self._corrector.close()
            self._corrector = None

        await self._send(metrics)
    
    async def _perform_correction(self):
        """执行 LLM 纠错（stop 时触发，刷新缓冲区剩余内容）"""
        if self._correction_buffer:
            await self._flush_correction_buffer()
    
    async def pause(self):
        """暂停"""
        self._cancel_flush_timer()

        # 刷新语义分段缓冲区中的剩余内容
        if settings.enable_semantic_segmentation and self._segment_buffer:
            segment_text = ' '.join(self._segment_buffer)
            final_event = self._adapter.process_final(segment_text)
            await self._send(final_event)
            print(f"[SemanticSegmentation] 暂停时刷新剩余段落: '{segment_text[:50]}...'")
            self._segment_buffer = []

        if self._transcriber:
            self._transcriber.pause()
        
        # 火山引擎模式：断开连接，保存最后的 partial 状态
        if self._volc_client:
            # 如果有未保存的 partial，保存它并加入纠错缓冲区
            if self._last_partial_text:
                final_event = self._adapter.process_final(self._last_partial_text)
                await self._send(final_event)
                # 将暂停时保存的 partial 也加入纠错缓冲区
                has_llm_config = self._has_llm_config()
                if settings.enable_llm_correction and has_llm_config and len(self._last_partial_text) >= settings.llm_min_text_len:
                    block_index = self._adapter._block_index
                    self._correction_buffer.append((block_index, self._last_partial_text))
                    print(f"[DEBUG] 暂停时保存 partial 到纠错缓冲区: block {block_index}, 长度 {len(self._last_partial_text)}")
                self._last_partial_text = ""
            
            await self._volc_client.send_end()
            await self._volc_client.disconnect()
            self._volc_client = None
        
        # 腾讯云模式：断开连接，保存最后的 partial 状态
        if self._tencent_client:
            if self._last_partial_text:
                final_event = self._adapter.process_final(self._last_partial_text)
                await self._send(final_event)
                has_llm_config = self._has_llm_config()
                if settings.enable_llm_correction and has_llm_config and len(self._last_partial_text) >= settings.llm_min_text_len:
                    block_index = self._adapter._block_index
                    self._correction_buffer.append((block_index, self._last_partial_text))
                    print(f"[DEBUG] 暂停时保存 partial 到纠错缓冲区: block {block_index}, 长度 {len(self._last_partial_text)}")
                self._last_partial_text = ""
            
            await self._tencent_client.send_end()
            await self._tencent_client.disconnect()
            self._tencent_client = None

        # 刷新纠错缓冲区（暂停时兜底，确保 partial 保存后的文本能被纠错）
        # 注意：不阻塞等待纠错完成，避免阻塞 WebSocket 消息循环导致 resume 消息延迟处理
        if settings.enable_llm_correction and self._has_llm_config() and self._correction_buffer:
            print(f"[DEBUG] 暂停时刷新纠错缓冲区: {len(self._correction_buffer)} 条")
            await self._flush_correction_buffer()
            # 纠错任务在后台继续执行，不等待完成

    async def resume(self):
        """恢复"""
        if self._transcriber:
            self._transcriber.resume()
        
        # 火山引擎模式：重新连接
        if settings.asr_provider == "volcengine" and not self._volc_client:
            # 清除尾部缓存，避免新会话与旧尾部进行重叠检测
            self._adapter.clear_tail()
            self._last_partial_text = ""  # 也清除 partial 状态
            await self._start_volcengine()
        
        # 腾讯云模式：重新连接
        if settings.asr_provider == "tencent" and not self._tencent_client:
            self._adapter.clear_tail()
            self._last_partial_text = ""
            await self._start_tencent()
    
    async def process_audio(self, audio_base64: str):
        """
        处理 Base64 编码的音频数据（兼容旧版 JSON 格式）

        Args:
            audio_base64: Base64 编码的 PCM 音频数据（16kHz 16bit 小端）
        """
        if not self._is_active:
            return

        try:
            pcm_data = base64.b64decode(audio_base64)
        except Exception as e:
            print(f"[SessionManager] Base64 解码失败: {e}")
            return

        await self._send_audio_to_engine(pcm_data)

    async def process_audio_bytes(self, pcm_data: bytes):
        """
        处理原始二进制 PCM 音频数据（WebSocket Binary Frame）

        Args:
            pcm_data: 原始 PCM 音频数据（16kHz 16bit 小端）
        """
        if not self._is_active:
            return

        await self._send_audio_to_engine(pcm_data)

    async def _send_audio_to_engine(self, pcm_data: bytes):
        """
        将 PCM 数据发送到 ASR 引擎

        Args:
            pcm_data: 原始 PCM 音频数据
        """
        if self._volc_client:
            try:
                await self._volc_client.send_audio(pcm_data)
            except Exception as e:
                print(f"[SessionManager] 处理音频失败: {e}")

        if self._tencent_client:
            try:
                await self._tencent_client.send_audio(pcm_data)
            except Exception as e:
                print(f"[SessionManager] 处理音频失败: {e}")
        # Mock 模式不需要处理音频，自动生成
    
    async def _on_partial(self, text: str):
        """
        处理 partial 事件

        火山引擎 result_type: "single" 模式下，每个 utterance 内 partial 累积增长。
        is_final=true 时会触发 _on_final，这里只负责转发 partial 实时结果。

        注意：volcengine_client 已过滤空文本，这里不会收到空字符串。
        """
        # Partial 阶段规则纠错（快速路径，<1ms）
        corrected_text = text
        if self._corrector and hasattr(self._corrector, '_quick_normalize'):
            corrected_text = self._corrector._quick_normalize(text)
            if corrected_text != text:
                text = corrected_text

        # 记录最新 partial（用于暂停时保存）
        self._last_partial_text = text

        # 转发当前 partial
        if text:
            event = self._adapter.process_partial(text)
            await self._send(event)
    
    async def _on_final(self, text: str):
        """
        处理 final 事件（火山引擎 is_final=true）

        这是引擎确认的完整 utterance，直接追加到 finalTextBlocks。
        清空 partial 记录，因为该 utterance 已结束。

        如果启用了语义分段：
        - 将文本加入分段缓冲区
        - 使用语义分段器判断是否应该分段
        - 只有在语义完整时才发送 final 事件

        然后将文本加入纠错缓冲区，达到窗口大小或静默超时后批量纠错。
        """
        if not text:
            return

        # 噪音文本过滤（Agent 4.1）：拦截噪音产生的无意义文本
        if self._is_noise_text(text):
            self._last_partial_text = ""
            return

        # 记录有效 final 文本（用于重复检测）
        self._track_recent_final(text)

        # 清空 partial 记录（该 utterance 已结束）
        self._last_partial_text = ""

        # 语义分段处理
        if settings.enable_semantic_segmentation and self._semantic_segmenter:
            await self._process_semantic_segmentation(text)
        else:
            # 不启用语义分段，直接发送
            event = self._adapter.process_final(text)
            await self._send(event)

        # 检查 LLM 纠错配置
        has_llm_config = self._has_llm_config()
        if not settings.enable_llm_correction or not has_llm_config:
            return
        if len(text) < settings.llm_min_text_len:
            return

        # 将当前 block 加入纠错缓冲区
        block_index = self._adapter._block_index
        self._correction_buffer.append((block_index, text))

        print(f"[DEBUG] 纠错缓冲区: +block {block_index}, 当前 {len(self._correction_buffer)}/{settings.llm_batch_window_size}")

        # 动态窗口：满足以下任一条件立即触发
        should_flush_now = False
        if len(self._correction_buffer) >= settings.llm_batch_window_size:
            should_flush_now = True
        elif self._correction_buffer:
            last_text = self._correction_buffer[-1][1]
            total_len = sum(len(text) for _, text in self._correction_buffer)
            # 长句（>30字）或累积文本较多（>80字）时立即触发
            if len(last_text) > 30 or total_len > 80:
                should_flush_now = True
                print(f"[DEBUG] 动态窗口触发: 最后一句长度={len(last_text)}, 累积长度={total_len}")

        if should_flush_now:
            self._cancel_flush_timer()
            self._schedule_flush_now()
        else:
            # 未达到窗口大小，重置静默超时定时器
            self._schedule_flush_delayed()
    
    async def _on_error(self, code: str, message: str):
        """处理错误事件"""
        await self._send({
            "type": "error",
            "code": code,
            "message": message,
            "retriable": code in ["CONNECTION_CLOSED", "SEND_FAILED"],
        })
    
    async def _correct_final(self, block_index: int, text: str):
        """
        对单句 final 文本进行 LLM 纠错（DeepSeek 回退模式）
        纠错完成后发送 event_corrected 事件，前端用纠正后文本替换对应 block
        """
        print(f"[DEBUG] _correct_final 开始执行: block_index={block_index}")
        try:
            self._ensure_corrector()
            if not self._corrector:
                return

            corrected_text, reasoning = await asyncio.wait_for(
                self._corrector.correct(text),
                timeout=settings.llm_correction_timeout_sec,
            )
            print(f"[DEBUG] corrector.correct() 返回: corrected='{corrected_text[:30] if corrected_text else 'None'}...'")

            if corrected_text and corrected_text != text:
                await self._send({
                    "type": "event_corrected",
                    "blockIndex": block_index,
                    "original": text,
                    "corrected": corrected_text,
                })
                print(f"[LLM纠错] block {block_index}: {text[:30]}... → {corrected_text[:30]}...")
            else:
                print(f"[DEBUG] 无需纠正或纠正结果相同: block_index={block_index}")
        except asyncio.TimeoutError:
            print(f"[LLM纠错] 单句纠错超时({settings.llm_correction_timeout_sec}s)，跳过: block_index={block_index}")
        except Exception as e:
            import traceback
            print(f"[LLM纠错] 逐句纠错失败: {e}")
            print(f"[DEBUG] 错误堆栈: {traceback.format_exc()}")

    # ============ 滑动窗口批量纠错 ============

    def _has_llm_config(self) -> bool:
        """检查 LLM 纠错配置是否完整"""
        if settings.llm_provider == "doubao":
            return bool(settings.ark_api_key and settings.ark_endpoint_id)
        elif settings.llm_provider == "deepseek":
            return bool(settings.deepseek_api_key)
        return False

    def _ensure_corrector(self):
        """确保纠错器已初始化"""
        if self._corrector:
            return
        if settings.llm_provider == "doubao" and settings.ark_api_key and settings.ark_endpoint_id:
            print(f"[DEBUG] 初始化 DoubaoCorrector (推荐，低延迟)...")
            self._corrector = DoubaoCorrector(
                api_key=settings.ark_api_key,
                endpoint_id=settings.ark_endpoint_id,
                fast_mode=settings.llm_fast_mode,
                max_context_items=settings.llm_max_context_items,
                few_shot_count=settings.llm_few_shot_count,
                max_output_tokens=settings.llm_max_output_tokens,
                request_timeout_sec=settings.llm_correction_timeout_sec,
            )
            from .hotwords import hotword_manager
            self._corrector.set_hotwords(hotword_manager.get_hotwords())
            print(f"[DEBUG] DoubaoCorrector 初始化完成")
        elif settings.deepseek_api_key:
            print(f"[DEBUG] 初始化 LLMCorrector (DeepSeek)...")
            self._corrector = LLMCorrector(
                api_key=settings.deepseek_api_key,
                api_base=settings.deepseek_api_base,
                model=settings.deepseek_model,
                request_timeout_sec=settings.llm_correction_timeout_sec,
                max_output_tokens=settings.llm_max_output_tokens,
            )
            print(f"[DEBUG] LLMCorrector 初始化完成")

    def _cancel_flush_timer(self):
        """取消静默超时定时器"""
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None

    def _schedule_flush_delayed(self):
        """重置静默超时定时器（用户停顿后触发）"""
        self._cancel_flush_timer()
        loop = asyncio.get_event_loop()
        self._flush_timer = loop.call_later(
            settings.llm_batch_flush_delay_sec,
            self._on_flush_timer_fired,
        )

    def _schedule_flush_now(self):
        """立即调度一次缓冲区刷新（异步任务）"""
        if not self._correction_buffer:
            return
        if len(self._pending_tasks) >= settings.llm_max_pending_tasks:
            print(f"[DEBUG] LLM纠错任务积压({len(self._pending_tasks)})，跳过本次批量纠错")
            return
        # 取出当前缓冲区内容，清空缓冲区
        batch = list(self._correction_buffer)
        self._correction_buffer = []
        print(f"[DEBUG] 触发批量纠错: {len(batch)} 句")
        task = asyncio.create_task(self._correct_batch(batch))
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    def _on_flush_timer_fired(self):
        """静默超时回调（在 event loop 中触发）"""
        if self._correction_buffer:
            print(f"[DEBUG] 静默超时({settings.llm_batch_flush_delay_sec}s)，触发缓冲区刷新")
            self._schedule_flush_now()

    async def _flush_correction_buffer(self):
        """同步刷新缓冲区（stop/pause 时调用，阻塞等待结果）"""
        if not self._correction_buffer:
            return
        batch = list(self._correction_buffer)
        self._correction_buffer = []
        print(f"[DEBUG] 同步刷新纠错缓冲区: {len(batch)} 句")
        await self._correct_batch(batch)

    async def _correct_batch(self, batch: List[Tuple[int, str]]):
        """
        对一批 final 文本进行 LLM 纠错

        DoubaoCorrector: 使用 correct_batch 批量纠错（一次 LLM 调用）
        LLMCorrector (DeepSeek): 回退到逐句纠错
        """
        try:
            self._ensure_corrector()
            if not self._corrector:
                return

            block_indices = [idx for idx, _ in batch]
            texts = [text for _, text in batch]

            # DoubaoCorrector 支持批量纠错
            if isinstance(self._corrector, DoubaoCorrector):
                results = await asyncio.wait_for(
                    self._corrector.correct_batch(
                        texts,
                        max_output_tokens=settings.llm_batch_max_output_tokens,
                        enable_detection=settings.enable_llm_detection,
                        detection_timeout_sec=settings.llm_detection_timeout_sec,
                    ),
                    timeout=settings.llm_correction_timeout_sec + settings.llm_detection_timeout_sec + 2.0,  # 检测+纠错+余量
                )
                for i, (corrected_text, reasoning) in enumerate(results):
                    if corrected_text and corrected_text != texts[i]:
                        await self._send({
                            "type": "event_corrected",
                            "blockIndex": block_indices[i],
                            "original": texts[i],
                            "corrected": corrected_text,
                        })
                        print(f"[LLM纠错·batch] block {block_indices[i]}: {texts[i][:25]}... → {corrected_text[:25]}...")
            else:
                # DeepSeek 回退：逐句纠错
                for i, (block_index, text) in enumerate(batch):
                    try:
                        corrected_text, reasoning = await asyncio.wait_for(
                            self._corrector.correct(text),
                            timeout=settings.llm_correction_timeout_sec,
                        )
                        if corrected_text and corrected_text != text:
                            await self._send({
                                "type": "event_corrected",
                                "blockIndex": block_index,
                                "original": text,
                                "corrected": corrected_text,
                            })
                            print(f"[LLM纠错·fallback] block {block_index}: {text[:25]}... → {corrected_text[:25]}...")
                    except asyncio.TimeoutError:
                        print(f"[LLM纠错·fallback] 超时，跳过 block {block_index}")
                    except Exception as e:
                        print(f"[LLM纠错·fallback] 失败: {e}")

        except asyncio.TimeoutError:
            print(f"[LLM纠错·batch] 批量纠错超时，跳过")
        except Exception as e:
            import traceback
            print(f"[LLM纠错·batch] 批量纠错失败: {e}")
            print(f"[DEBUG] 错误堆栈: {traceback.format_exc()}")

    async def _send(self, data: dict):
        """发送消息到客户端"""
        result = self.send_callback(data)
        if asyncio.iscoroutine(result):
            await result
