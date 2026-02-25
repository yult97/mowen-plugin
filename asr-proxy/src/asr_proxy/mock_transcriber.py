"""
Mock 转写器
用于本地开发测试，模拟 ASR 的 partial/final 事件
"""

import asyncio
import random
from typing import Callable, Optional


# 模拟文本库
MOCK_SENTENCES = [
    "今天的天气非常好，阳光明媚。",
    "我正在测试语音笔记功能，感觉体验很流畅。",
    "这个功能可以帮助用户快速记录想法。",
    "实时转写让沟通变得更加高效。",
    "墨问笔记助手是一个很棒的工具。",
]


class MockTranscriber:
    """
    Mock 转写器
    
    模拟 ASR 的 partial/final 事件流，用于：
    1. 本地开发时无需连接火山引擎
    2. UI 调试和演示
    """
    
    def __init__(
        self,
        on_partial: Optional[Callable[[str], None]] = None,
        on_final: Optional[Callable[[str], None]] = None,
        partial_interval: float = 0.2,
        final_interval: float = 3.0,
    ):
        self.on_partial = on_partial
        self.on_final = on_final
        self.partial_interval = partial_interval
        self.final_interval = final_interval
        
        self._running = False
        self._paused = False
        self._task: Optional[asyncio.Task] = None
        self._current_sentence_index = 0
    
    async def start(self):
        """开始模拟转写"""
        if self._running:
            return
        
        self._running = True
        self._paused = False
        self._task = asyncio.create_task(self._run())
    
    async def stop(self):
        """停止模拟转写"""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
    
    def pause(self):
        """暂停"""
        self._paused = True
    
    def resume(self):
        """恢复"""
        self._paused = False
    
    async def _run(self):
        """主循环：模拟 partial 吐字和 final 确认"""
        while self._running:
            sentence = MOCK_SENTENCES[self._current_sentence_index]
            
            # 模拟逐字吐出 partial
            for i in range(1, len(sentence) + 1):
                if not self._running:
                    break
                
                # 暂停时等待
                while self._paused and self._running:
                    await asyncio.sleep(0.1)
                
                if not self._running:
                    break
                
                partial_text = sentence[:i]
                if self.on_partial:
                    await self._call_callback(self.on_partial, partial_text)
                
                await asyncio.sleep(self.partial_interval)
            
            if not self._running:
                break
            
            # 发送 final
            if self.on_final:
                await self._call_callback(self.on_final, sentence)
            
            # 切换到下一句
            self._current_sentence_index = (self._current_sentence_index + 1) % len(MOCK_SENTENCES)
            
            # 等待一小段时间再开始下一句
            await asyncio.sleep(0.5)
    
    async def _call_callback(self, callback: Callable, *args):
        """调用回调函数（支持同步和异步）"""
        result = callback(*args)
        if asyncio.iscoroutine(result):
            await result
