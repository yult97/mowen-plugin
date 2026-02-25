"""
数据模型定义
使用 Pydantic 定义前后端通信协议
"""

from typing import Literal, Optional
from pydantic import BaseModel


# ============ 前端 → 中转服务 ============

class AudioConfig(BaseModel):
    """音频配置"""
    sample_rate: int = 16000
    encoding: Literal["pcm", "opus"] = "pcm"
    channels: int = 1


class StartMessage(BaseModel):
    """开始会话消息"""
    type: Literal["start"] = "start"
    audio_config: AudioConfig = AudioConfig()


class AudioMessage(BaseModel):
    """音频数据消息"""
    type: Literal["audio"] = "audio"
    seq: int
    payload: str  # Base64 编码的音频数据


class ControlMessage(BaseModel):
    """控制消息"""
    type: Literal["pause", "resume", "stop"]


# ============ 中转服务 → 前端 ============

class ReadyEvent(BaseModel):
    """会话就绪事件"""
    type: Literal["ready"] = "ready"
    session_id: str


class PartialEvent(BaseModel):
    """临时识别结果"""
    type: Literal["event_partial"] = "event_partial"
    text: str


class FinalEvent(BaseModel):
    """最终识别结果"""
    type: Literal["event_final"] = "event_final"
    text: str


class ReviseEvent(BaseModel):
    """修订事件"""
    type: Literal["event_revise"] = "event_revise"
    block_index: int
    text: str


class ErrorEvent(BaseModel):
    """错误事件"""
    type: Literal["error"] = "error"
    code: str
    message: str
    retriable: bool = False


class MetricsEvent(BaseModel):
    """指标事件"""
    type: Literal["metrics"] = "metrics"
    ttfb_ms: Optional[int] = None
    partial_count: int = 0
    final_count: int = 0


class CorrectedEvent(BaseModel):
    """纠错结果事件（LLM 智能纠错后返回）"""
    type: Literal["event_corrected"] = "event_corrected"
    original: str      # 原始识别文本
    corrected: str     # 纠错后文本


# ============ 内部使用 ============

class ReviseResult(BaseModel):
    """修订检测结果"""
    is_revise: bool
    deduplicated_text: str
