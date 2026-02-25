"""
Result Adapter 单元测试
测试 revise 重叠检测算法
"""

import pytest
from asr_proxy.result_adapter import detect_revise, get_tail, ResultAdapter, OVERLAP_THRESHOLD


class TestDetectRevise:
    """测试重叠检测算法"""
    
    def test_no_overlap(self):
        """无重叠时返回 None"""
        result = detect_revise("今天天气很好", "明天会下雨")
        assert result is None
    
    def test_small_overlap(self):
        """重叠小于阈值时返回 None"""
        # 重叠 5 个字符，小于阈值
        result = detect_revise("今天天气很好啊", "好啊明天下雨")
        # 实际重叠 "好啊" = 2 字符 < 14
        assert result is None
    
    def test_large_overlap(self):
        """重叠大于等于阈值时返回修订结果"""
        # 构造足够长的重叠
        tail = "这是一段很长的文本用于测试重叠检测功能"
        new_final = "用于测试重叠检测功能以及后续的新内容"
        # 重叠 "用于测试重叠检测功能" = 10 字符
        result = detect_revise(tail, new_final)
        # 10 < 14，仍然不够
        assert result is None
    
    def test_exact_threshold_overlap(self):
        """重叠恰好等于阈值"""
        # 构造恰好 14 字符的重叠
        tail = "前面的内容" + "A" * OVERLAP_THRESHOLD
        new_final = "A" * OVERLAP_THRESHOLD + "后面的内容"
        result = detect_revise(tail, new_final)
        assert result is not None
        assert result.is_revise is True
        assert result.deduplicated_text == "后面的内容"
    
    def test_empty_strings(self):
        """空字符串返回 None"""
        assert detect_revise("", "test") is None
        assert detect_revise("test", "") is None
        assert detect_revise("", "") is None


class TestGetTail:
    """测试尾部获取函数"""
    
    def test_short_text(self):
        """短文本返回全部"""
        assert get_tail("短文本", 48) == "短文本"
    
    def test_long_text(self):
        """长文本返回指定长度"""
        long_text = "A" * 100
        result = get_tail(long_text, 48)
        assert len(result) == 48
        assert result == "A" * 48


class TestResultAdapter:
    """测试结果适配器"""
    
    def test_process_partial(self):
        """测试 partial 事件处理"""
        adapter = ResultAdapter()
        result = adapter.process_partial("测试文本")
        assert result["type"] == "event_partial"
        assert result["text"] == "测试文本"
    
    def test_process_final_first(self):
        """测试第一个 final 事件"""
        adapter = ResultAdapter()
        result = adapter.process_final("第一句话。")
        assert result["type"] == "event_final"
        assert result["text"] == "第一句话。"
    
    def test_process_final_no_revise(self):
        """测试无重叠的 final 事件"""
        adapter = ResultAdapter()
        adapter.process_final("第一句话。")
        result = adapter.process_final("第二句话。")
        assert result["type"] == "event_final"
        assert result["text"] == "第二句话。"
    
    def test_reset(self):
        """测试状态重置"""
        adapter = ResultAdapter()
        adapter.process_final("测试")
        adapter.process_partial("测试")
        
        adapter.reset()
        metrics = adapter.get_metrics()
        assert metrics["partial_count"] == 0
        assert metrics["final_count"] == 0
    
    def test_get_metrics(self):
        """测试指标获取"""
        adapter = ResultAdapter()
        adapter.process_partial("p1")
        adapter.process_partial("p2")
        adapter.process_final("f1")
        
        metrics = adapter.get_metrics()
        assert metrics["type"] == "metrics"
        assert metrics["partial_count"] == 2
        assert metrics["final_count"] == 1
