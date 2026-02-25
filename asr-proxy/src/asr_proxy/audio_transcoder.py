"""
音频转码器
将浏览器录制的 WebM/Opus 音频转换为火山引擎所需的 PCM 16kHz 格式
"""

import subprocess
import tempfile
import os
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class AudioTranscoder:
    """
    使用 ffmpeg 进行音频格式转换
    
    输入: WebM/Opus (浏览器 MediaRecorder 输出)
    输出: PCM 16kHz 16bit 单声道 (火山引擎 ASR 要求)
    """
    
    def __init__(self):
        self._ffmpeg_available = self._check_ffmpeg()
        self._buffer = bytearray()  # 累积输入数据
        self._min_chunk_size = 4096  # 最小处理块大小
    
    def _check_ffmpeg(self) -> bool:
        """检查 ffmpeg 是否可用"""
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                timeout=5
            )
            available = result.returncode == 0
            if available:
                logger.info("[AudioTranscoder] ffmpeg 可用")
            else:
                logger.warning("[AudioTranscoder] ffmpeg 不可用")
            return available
        except Exception as e:
            logger.warning(f"[AudioTranscoder] ffmpeg 检查失败: {e}")
            return False
    
    @property
    def is_available(self) -> bool:
        return self._ffmpeg_available
    
    def convert_webm_to_pcm(self, webm_data: bytes) -> Optional[bytes]:
        """
        将 WebM 音频数据转换为 PCM 16kHz
        
        Args:
            webm_data: WebM/Opus 格式的音频数据
            
        Returns:
            PCM 16kHz 16bit 单声道数据，或 None（如果转换失败）
        """
        if not self._ffmpeg_available:
            logger.error("[AudioTranscoder] ffmpeg 不可用，无法转码")
            return None
        
        if not webm_data or len(webm_data) < 100:
            # 数据太小，可能不完整
            return None
        
        try:
            # 使用临时文件（ffmpeg 需要可 seek 的输入来处理 webm）
            with tempfile.NamedTemporaryFile(
                suffix=".webm", delete=False
            ) as input_file:
                input_file.write(webm_data)
                input_path = input_file.name
            
            with tempfile.NamedTemporaryFile(
                suffix=".pcm", delete=False
            ) as output_file:
                output_path = output_file.name
            
            try:
                # 使用 ffmpeg 转换
                # -f webm: 输入格式
                # -ar 16000: 采样率 16kHz
                # -ac 1: 单声道
                # -f s16le: 输出格式（16bit 小端 PCM）
                result = subprocess.run(
                    [
                        "ffmpeg",
                        "-y",  # 覆盖输出
                        "-i", input_path,  # 输入文件
                        "-ar", "16000",  # 采样率
                        "-ac", "1",  # 单声道
                        "-f", "s16le",  # 输出格式
                        output_path
                    ],
                    capture_output=True,
                    timeout=10
                )
                
                if result.returncode != 0:
                    logger.error(
                        f"[AudioTranscoder] ffmpeg 转换失败: {result.stderr.decode()}"
                    )
                    return None
                
                # 读取输出
                with open(output_path, "rb") as f:
                    pcm_data = f.read()
                
                if pcm_data:
                    logger.debug(
                        f"[AudioTranscoder] 转换成功: {len(webm_data)} → {len(pcm_data)} bytes"
                    )
                    return pcm_data
                else:
                    return None
                    
            finally:
                # 清理临时文件
                try:
                    os.unlink(input_path)
                    os.unlink(output_path)
                except Exception:
                    pass
                    
        except subprocess.TimeoutExpired:
            logger.error("[AudioTranscoder] ffmpeg 转换超时")
            return None
        except Exception as e:
            logger.error(f"[AudioTranscoder] 转换异常: {e}")
            return None
    
    def add_chunk(self, chunk: bytes) -> Optional[bytes]:
        """
        添加音频块到缓冲区，当积累足够数据时返回转换后的 PCM
        
        Args:
            chunk: WebM 音频块
            
        Returns:
            转换后的 PCM 数据，或 None（如果数据不足）
        """
        self._buffer.extend(chunk)
        
        # 累积到一定大小再转换（WebM 需要完整的帧）
        if len(self._buffer) >= self._min_chunk_size:
            data = bytes(self._buffer)
            self._buffer.clear()
            return self.convert_webm_to_pcm(data)
        
        return None
    
    def flush(self) -> Optional[bytes]:
        """
        刷新缓冲区，处理剩余数据
        """
        if self._buffer:
            data = bytes(self._buffer)
            self._buffer.clear()
            if len(data) > 100:  # 只处理足够大的数据
                return self.convert_webm_to_pcm(data)
        return None
    
    def reset(self):
        """重置缓冲区"""
        self._buffer.clear()


# 单例实例
_transcoder: Optional[AudioTranscoder] = None


def get_transcoder() -> AudioTranscoder:
    """获取音频转码器单例"""
    global _transcoder
    if _transcoder is None:
        _transcoder = AudioTranscoder()
    return _transcoder
