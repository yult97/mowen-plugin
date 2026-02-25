"""
DoubaoCorrector 纠错精准度测试

测试内容：
1. _validate_correction 多信号反幻觉验证
2. _select_examples 领域自适应选择
3. _quick_normalize 规则纠错
4. 热词注入
5. 端到端纠错精准度评估（需要 API Key，标记为 slow）
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from asr_proxy.doubao_corrector import (
    DoubaoCorrector,
    FEW_SHOT_EXAMPLES,
    _levenshtein,
    _edit_operations,
)


# ============ 辅助函数测试 ============


class TestLevenshtein:
    """编辑距离计算"""

    def test_identical(self):
        assert _levenshtein("abc", "abc") == 0

    def test_empty(self):
        assert _levenshtein("", "abc") == 3
        assert _levenshtein("abc", "") == 3

    def test_single_edit(self):
        assert _levenshtein("abc", "adc") == 1  # 替换
        assert _levenshtein("abc", "abcd") == 1  # 插入
        assert _levenshtein("abc", "ab") == 1  # 删除

    def test_chinese(self):
        assert _levenshtein("你好世界", "你好世界") == 0
        assert _levenshtein("你好世界", "你好时间") == 2

    def test_symmetry(self):
        assert _levenshtein("abc", "xyz") == _levenshtein("xyz", "abc")


# ============ ER 编辑操作分解测试 ============


class TestEditOperations:
    """ER = (S+D+I)/N 编辑操作分解"""

    def test_identical(self):
        s, d, i = _edit_operations("abc", "abc")
        assert (s, d, i) == (0, 0, 0)

    def test_pure_substitution(self):
        s, d, i = _edit_operations("abc", "axc")
        assert s == 1 and d == 0 and i == 0

    def test_pure_deletion(self):
        s, d, i = _edit_operations("abcd", "abd")
        assert d == 1 and i == 0

    def test_pure_insertion(self):
        s, d, i = _edit_operations("abc", "abxc")
        assert i == 1 and d == 0

    def test_sum_equals_levenshtein(self):
        """S+D+I 之和应等于 Levenshtein 距离"""
        pairs = [
            ("你好世界", "你好时间"),
            ("deep seek很好用", "DeepSeek很好用"),
            ("abc", "xyz"),
        ]
        for a, b in pairs:
            s, d, ins = _edit_operations(a, b)
            assert s + d + ins == _levenshtein(a, b), f"'{a}' → '{b}'"

    def test_chinese_filler_removal(self):
        """去除填充词：应为纯删除操作"""
        s, d, i = _edit_operations("嗯那个我觉得不错", "我觉得不错")
        assert d == 3 and i == 0  # 删除 嗯那个


# ============ 反幻觉验证测试 ============


class TestValidateCorrection:
    """多信号反幻觉验证"""

    @pytest.fixture
    def corrector(self):
        return DoubaoCorrector(api_key="test", endpoint_id="test")

    # --- 应该通过的纠错 ---

    def test_minor_correction_passes(self, corrector):
        """小幅纠错应通过"""
        assert corrector._validate_correction(
            "今天我们来聊一下chat GDP的区别",
            "今天我们来聊一下ChatGPT的区别",
        )

    def test_filler_removal_blocked(self, corrector):
        """去除句首填充词应被拦截（禁止删除口语词）"""
        assert not corrector._validate_correction(
            "嗯那个我觉得这个模型还不错",
            "我觉得这个模型还不错",
        )

    def test_no_change_passes(self, corrector):
        """无变化应通过"""
        text = "这段文本完全正确，不需要修改。"
        assert corrector._validate_correction(text, text)

    def test_tech_term_correction_passes(self, corrector):
        """技术术语纠错应通过"""
        assert corrector._validate_correction(
            "我们用的deep seek效果不错",
            "我们用的DeepSeek效果不错",
        )

    def test_short_text_term_replacement_handled_by_quick_normalize(self, corrector):
        """短文本术语替换由 _quick_normalize 规则处理，不经过 LLM 验证"""
        # "克劳德" → "Claude" 的 ER 过高，验证函数会拦截
        # 但实际流程中 _quick_normalize 会先命中规则直接替换，不走 LLM
        assert corrector._quick_normalize("试试克劳德吧") == "试试Claude吧"

    # --- 应该拒绝的纠错 ---

    def test_empty_corrected_rejected(self, corrector):
        """空纠错结果应拒绝"""
        assert not corrector._validate_correction("原始文本", "")

    def test_hallucination_length_increase_rejected(self, corrector):
        """大幅增长应拒绝（幻觉添加内容）"""
        assert not corrector._validate_correction(
            "这个模型不错",
            "这个模型不错，它的推理能力非常强大，在各种基准测试中都表现优异",
        )

    def test_hallucination_rewrite_rejected(self, corrector):
        """大幅改写应拒绝（编辑距离过大）"""
        assert not corrector._validate_correction(
            "今天天气很好，适合出去走走",
            "明天可能会下雨，建议带伞出门",
        )

    def test_content_words_lost_rejected(self, corrector):
        """关键实词丢失应拒绝"""
        assert not corrector._validate_correction(
            "患者的干细胞移植手术非常成功",
            "用户的数据迁移操作已经完成了",
        )

    def test_severe_truncation_rejected(self, corrector):
        """过度截断应拒绝"""
        assert not corrector._validate_correction(
            "嗯那个我觉得这个产品的用户体验还是需要继续优化的",
            "优化",
        )


# ============ 领域自适应选择测试 ============


class TestSelectExamples:
    """Few-Shot 示例选择"""

    def test_tech_domain_detected(self):
        """科技领域关键词应选择 tech 示例"""
        corrector = DoubaoCorrector(
            api_key="test", endpoint_id="test", few_shot_count=3
        )
        corrector._context_window = ["我们在训练一个GPT模型"]
        examples = corrector._select_examples("这个API的效果不错")
        domains = [e["domain"] for e in examples]
        assert "tech" in domains

    def test_medical_domain_detected(self):
        """医疗领域关键词应选择 medical 示例"""
        corrector = DoubaoCorrector(
            api_key="test", endpoint_id="test", few_shot_count=3
        )
        corrector._context_window = ["这个患者的诊断结果"]
        examples = corrector._select_examples("治疗方案需要调整")
        domains = [e["domain"] for e in examples]
        assert "medical" in domains

    def test_business_domain_detected(self):
        """商业领域关键词应选择 business 示例"""
        corrector = DoubaoCorrector(
            api_key="test", endpoint_id="test", few_shot_count=3
        )
        examples = corrector._select_examples("我们的GMV和ROI都在增长")
        domains = [e["domain"] for e in examples]
        assert "business" in domains

    def test_always_includes_no_change(self):
        """应始终包含 no_change 示例"""
        corrector = DoubaoCorrector(
            api_key="test", endpoint_id="test", few_shot_count=2
        )
        examples = corrector._select_examples("随便说点什么")
        domains = [e["domain"] for e in examples]
        assert "no_change" in domains

    def test_zero_few_shot_returns_empty(self):
        """few_shot_count=0 应返回空列表"""
        corrector = DoubaoCorrector(
            api_key="test", endpoint_id="test", few_shot_count=0
        )
        assert corrector._select_examples("任何文本") == []

    def test_respects_few_shot_count(self):
        """返回数量不超过 few_shot_count"""
        for count in [1, 2, 3, 5]:
            corrector = DoubaoCorrector(
                api_key="test", endpoint_id="test", few_shot_count=count
            )
            examples = corrector._select_examples("测试文本")
            assert len(examples) <= count


# ============ 规则纠错测试 ============


class TestQuickNormalize:
    """轻量规则纠错"""

    @pytest.fixture
    def corrector(self):
        return DoubaoCorrector(api_key="test", endpoint_id="test")

    def test_deepsek_variants(self, corrector):
        assert "DeepSeek" in corrector._quick_normalize("deep seek很好用")
        assert "DeepSeek" in corrector._quick_normalize("deep sick不错")

    def test_chatgpt_variants(self, corrector):
        assert "ChatGPT" in corrector._quick_normalize("chat gdp很强")

    def test_claude_variants(self, corrector):
        assert "Claude" in corrector._quick_normalize("克劳德不错")
        assert "Claude" in corrector._quick_normalize("科劳德很好")

    def test_no_false_positive(self, corrector):
        """正确文本不应被修改"""
        text = "今天天气很好，适合出去走走。"
        assert corrector._quick_normalize(text) == text


# ============ 热词注入测试 ============


class TestHotwords:
    """热词注入"""

    def test_set_hotwords_limits_to_50(self):
        corrector = DoubaoCorrector(api_key="test", endpoint_id="test")
        corrector.set_hotwords([f"word{i}" for i in range(100)])
        assert len(corrector._hotword_hints) == 50

    def test_hotwords_injected_into_prompt(self):
        corrector = DoubaoCorrector(api_key="test", endpoint_id="test")
        corrector.set_hotwords(["ChatGPT", "DeepSeek", "Claude"])
        messages = corrector._build_messages("测试文本")
        system_content = messages[0]["content"]
        assert "ChatGPT" in system_content
        assert "DeepSeek" in system_content
        assert "参考术语" in system_content

    def test_no_hotwords_no_injection(self):
        corrector = DoubaoCorrector(api_key="test", endpoint_id="test")
        messages = corrector._build_messages("测试文本")
        system_content = messages[0]["content"]
        assert "参考术语" not in system_content


# ============ Few-Shot 示例完整性 ============


class TestFewShotExamples:
    """Few-Shot 示例数据完整性"""

    def test_all_examples_have_required_keys(self):
        for i, ex in enumerate(FEW_SHOT_EXAMPLES):
            assert "domain" in ex, f"示例 {i} 缺少 domain"
            assert "context" in ex, f"示例 {i} 缺少 context"
            assert "input" in ex, f"示例 {i} 缺少 input"
            assert "output" in ex, f"示例 {i} 缺少 output"

    def test_has_no_change_examples(self):
        """必须包含 no_change 示例"""
        domains = [e["domain"] for e in FEW_SHOT_EXAMPLES]
        assert "no_change" in domains

    def test_no_change_examples_are_identical(self):
        """no_change 示例的 input 和 output 应完全相同"""
        for ex in FEW_SHOT_EXAMPLES:
            if ex["domain"] == "no_change":
                assert ex["input"] == ex["output"], (
                    f"no_change 示例 input/output 不一致: {ex['input'][:30]}"
                )

    def test_covers_multiple_domains(self):
        """应覆盖多个领域"""
        domains = set(e["domain"] for e in FEW_SHOT_EXAMPLES)
        assert len(domains) >= 4, f"仅覆盖 {domains}，应至少 4 个领域"


# ============ 端到端纠错评估（需要 API Key）============


# 测试用例：(ASR 原文, 期望纠错结果, 说明)
CORRECTION_TEST_CASES = [
    # --- 应该纠错的 ---
    (
        "嗯那个我觉得deep seek这个模型还是挺不错的",
        "DeepSeek",  # 期望包含
        "DeepSeek 谐音纠错",
    ),
    (
        "今天我们来聊一下chat GDP和克劳德的区别",
        "ChatGPT",
        "ChatGPT 谐音纠错",
    ),
    (
        "今天我们来聊一下chat GDP和克劳德的区别",
        "Claude",
        "Claude 谐音纠错",
    ),
    (
        "这个项目的技术栈主要是python加上react",
        "Python",
        "大小写修正",
    ),
    # --- 不应该纠错的 ---
    (
        "我觉得今天天气还不错，下午可以出去走走。",
        "我觉得今天天气还不错，下午可以出去走走。",
        "正确文本不应修改（完全匹配）",
    ),
    (
        "这个患者的干细胞移植手术非常成功",
        "干细胞",  # 期望保留
        "医疗术语不应被错误替换",
    ),
    (
        "我们团队最近在做一个新的项目，主要是面向企业客户的。",
        "我们团队最近在做一个新的项目",
        "普通句子不应被大幅修改",
    ),
]


@pytest.mark.slow
class TestEndToEndCorrection:
    """
    端到端纠错精准度评估

    需要配置环境变量：
      ARK_API_KEY=xxx
      ARK_ENDPOINT_ID=ep-xxx

    运行方式：
      cd asr-proxy
      pytest tests/test_doubao_corrector.py::TestEndToEndCorrection -v -m slow
    """

    @pytest.fixture
    def corrector(self):
        import os
        api_key = os.getenv("ARK_API_KEY", "")
        endpoint_id = os.getenv("ARK_ENDPOINT_ID", "")
        if not api_key or not endpoint_id:
            pytest.skip("需要 ARK_API_KEY 和 ARK_ENDPOINT_ID 环境变量")
        return DoubaoCorrector(
            api_key=api_key,
            endpoint_id=endpoint_id,
            fast_mode=True,
            max_context_items=3,
            few_shot_count=1,
            max_output_tokens=96,
            request_timeout_sec=5.0,
        )

    @pytest.mark.parametrize(
        "asr_text, expected_fragment, description",
        CORRECTION_TEST_CASES,
        ids=[c[2] for c in CORRECTION_TEST_CASES],
    )
    async def test_correction_case(
        self, corrector, asr_text, expected_fragment, description
    ):
        corrected, info = await corrector.correct(asr_text)
        assert expected_fragment in corrected, (
            f"[{description}]\n"
            f"  ASR 原文:   {asr_text}\n"
            f"  纠错结果:   {corrected}\n"
            f"  期望包含:   {expected_fragment}"
        )

    async def test_correction_summary(self, corrector):
        """汇总所有测试用例的纠错结果"""
        results = []
        for asr_text, expected, desc in CORRECTION_TEST_CASES:
            corrected, info = await corrector.correct(asr_text)
            passed = expected in corrected
            results.append({
                "desc": desc,
                "input": asr_text,
                "expected": expected,
                "actual": corrected,
                "passed": passed,
                "info": info,
            })

        total = len(results)
        passed = sum(1 for r in results if r["passed"])
        print(f"\n{'='*60}")
        print(f"纠错精准度评估: {passed}/{total} ({passed/total*100:.0f}%)")
        print(f"{'='*60}")
        for r in results:
            status = "✓" if r["passed"] else "✗"
            print(f"  {status} {r['desc']}")
            if not r["passed"]:
                print(f"    输入: {r['input'][:50]}")
                print(f"    期望: {r['expected']}")
                print(f"    实际: {r['actual'][:50]}")
        print(f"{'='*60}")
