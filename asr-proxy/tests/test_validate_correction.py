"""验证 _validate_correction 阈值优化后的行为

验证函数的职责是拦截 LLM 幻觉（大幅改写），
而非微小的过度纠错（那由 Prompt 约束来防止）。
"""
from src.asr_proxy.doubao_corrector import DoubaoCorrector


def test_validate_correction_thresholds():
    corrector = DoubaoCorrector()

    test_cases = [
        # (原文, 纠错后, 期望通过验证, 说明)

        # === 应通过的合法纠错 ===
        ("音为这个原因", "因为这个原因", True, "同音字纠错"),
        ("deep seek很好", "DeepSeek很好", True, "技术名词"),
        ("今天天气不错", "今天天气不错。", True, "补标点"),
        ("然后我们发现用那个优内特的效果比较好", "然后我们发现用那个U-Net的效果比较好", True, "技术名词替换"),
        ("我记得我从小的时候我们没有像西方有一个叫做青春", "我记得我从小的时候，我们没有像西方有一个叫做青春", True, "补逗号"),
        ("泰勒公式的核心思想就是用多项式来逼近一个复杂的含数", "泰勒公式的核心思想就是用多项式来逼近一个复杂的函数", True, "同音字纠错"),
        ("旅行合同义务不符合约定的", "履行合同义务不符合约定的", True, "同音字纠错"),
        ("分割的精度能到百分之九十五以上", "分割的精度能到95%以上", True, "数字格式化"),
        ("我觉得今天天气还不错", "我觉得今天天气还不错。", True, "只补句号"),
        ("你觉得这个方案怎么样", "你觉得这个方案怎么样？", True, "只补问号"),

        # === 应被拦截的 LLM 幻觉（大幅改写）===
        ("今天天气不错", "明天会下雨所以要带伞出门", False, "完全改写应被拦截"),
        ("我觉得这个方案还不错", "这个方案非常优秀值得推广", False, "语义改变应被拦截"),

        # === 微小的过度纠错（验证函数无法拦截，由 Prompt 约束）===
        # 注意：这些 case 验证函数会放行，但 Prompt 优化后 LLM 不应产生这类输出
        ("他比贾宝玉大一点点，然后贾宝玉13岁", "他比贾宝玉大一点点，贾宝玉13岁", True, "删除'然后'变化太小，验证函数无法拦截"),
    ]

    all_pass = True
    for orig, corr, expected, desc in test_cases:
        result = corrector._validate_correction(orig, corr)
        status = "PASS" if result == expected else "FAIL"
        if result != expected:
            all_pass = False
        print(f"  {status}: {desc} | expected={expected}, got={result}")

    if all_pass:
        print("\nAll tests passed!")
    else:
        print("\nSome tests FAILED!")
        exit(1)


if __name__ == "__main__":
    test_validate_correction_thresholds()
