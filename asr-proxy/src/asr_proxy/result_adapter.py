"""
结果适配器
将火山引擎返回结果映射为统一事件格式，并实现 revise 重叠检测
"""

from typing import Optional
from .models import ReviseResult


# 重叠检测配置
TAIL_LENGTH = 48        # 保存上一段尾部字符数
OVERLAP_THRESHOLD = 14  # 重叠判定阈值


def detect_revise(last_final_tail: str, new_final: str) -> Optional[ReviseResult]:
    """
    检测是否为修订（回改）事件
    
    通过比较新 final 的前缀与上一段尾部的后缀重叠程度，
    判断是否为 ASR 引擎的回改行为。
    
    Args:
        last_final_tail: 上一个 final 片段的尾部（最后 TAIL_LENGTH 个字符）
        new_final: 新收到的 final 片段
        
    Returns:
        如果检测到修订，返回 ReviseResult；否则返回 None
    """
    if not last_final_tail or not new_final:
        return None
    
    max_overlap = 0
    max_len = min(len(last_final_tail), len(new_final))
    
    # 查找最大重叠长度
    for i in range(1, max_len + 1):
        if last_final_tail[-i:] == new_final[:i]:
            max_overlap = i
    
    if max_overlap >= OVERLAP_THRESHOLD:
        return ReviseResult(
            is_revise=True,
            deduplicated_text=new_final[max_overlap:]
        )
    
    return None


def get_tail(text: str, length: int = TAIL_LENGTH) -> str:
    """获取文本尾部片段"""
    return text[-length:] if len(text) > length else text


class ResultAdapter:
    """
    火山引擎结果适配器
    
    职责：
    1. 解析火山返回的识别结果
    2. 维护上一个 final 的尾部用于重叠检测
    3. 生成统一的事件格式
    """
    
    def __init__(self):
        self._last_final_tail = ""
        self._block_index = -1
        self._partial_count = 0
        self._final_count = 0
        self._final_texts: list[str] = []  # 收集所有 final 文本用于纠错
    
    def reset(self):
        """重置状态"""
        self._last_final_tail = ""
        self._block_index = -1
        self._partial_count = 0
        self._final_count = 0
        self._final_texts = []
    
    def clear_tail(self):
        """清除尾部缓存, 用于暂停后继续的场景"""
        self._last_final_tail = ""
    
    def process_partial(self, text: str) -> dict:
        """处理 partial 结果"""
        self._partial_count += 1
        return {
            "type": "event_partial",
            "text": text,
        }
    
    def process_final(self, text: str) -> dict:
        """
        处理 final 结果
        
        直接追加新 block，不做重叠检测。
        火山引擎 result_type: "single" 模式下每个 utterance 独立返回，
        不需要 revise 功能。
        """
        self._final_count += 1
        self._block_index += 1
        
        # 收集 final 文本用于 LLM 纠错
        self._final_texts.append(text)
        
        result = {
            "type": "event_final",
            "text": text,
        }
        
        # 更新尾部缓存（保留用于未来可能的需求）
        self._last_final_tail = get_tail(text)
        
        return result
    
    def get_full_text(self) -> str:
        """获取完整的识别文本（用于 LLM 纠错）"""
        return "".join(self._final_texts)
    
    def get_metrics(self) -> dict:
        """获取当前指标"""
        return {
            "type": "metrics",
            "partial_count": self._partial_count,
            "final_count": self._final_count,
        }

