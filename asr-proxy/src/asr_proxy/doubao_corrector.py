"""
豆包大模型纠错器
使用火山方舟 SDK 调用 Doubao-pro 模型对 ASR 识别结果进行语义纠错

核心设计原则：宁可漏改，不可错改
1. System/User 角色分离 - 稳定性更好
2. Few-Shot 示例 - 至少 50% 为 no_change 示例，教模型克制
3. 上下文感知 - 传入前文使纠错更准确
4. 反幻觉约束 - 严格限制修改范围，收紧验证阈值
5. 纠错范围限定 - 仅同音字、技术名词、标点，禁止删除口语词
"""

import asyncio
import os
import re
from typing import Optional, Tuple, List


def _levenshtein(s1: str, s2: str) -> int:
    """计算两个字符串的编辑距离"""
    if len(s1) < len(s2):
        return _levenshtein(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            cost = 0 if c1 == c2 else 1
            curr_row.append(min(curr_row[j] + 1, prev_row[j + 1] + 1, prev_row[j] + cost))
        prev_row = curr_row
    return prev_row[-1]


def _edit_operations(s1: str, s2: str) -> tuple:
    """
    计算编辑操作分解，返回 (substitutions, deletions, insertions)。
    基于论文 Chain of Correction (arXiv:2504.01519) 的 ER 公式。
    ER = (S + D + I) / N，其中 N = len(s1)（原文字符数）。
    """
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    # 回溯提取 S, D, I
    s, d, ins = 0, 0, 0
    i, j = m, n
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if s1[i - 1] == s2[j - 1] else 1):
            if s1[i - 1] != s2[j - 1]:
                s += 1
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            d += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return s, d, ins


def _semantic_len(text: str) -> int:
    """估算文本的语义长度，中文字符权重 2（信息密度高），ASCII 字符权重 1"""
    length = 0
    for ch in text:
        if '\u4e00' <= ch <= '\u9fff':
            length += 2
        else:
            length += 1
    return max(length, 1)

# ============ Prompt 设计（核心）============

# System Prompt - 定义角色和规则（稳定层，不随输入变化）
SYSTEM_PROMPT = """你是专业的中文 ASR 文本纠错助手。你只修正语音识别错误，绝不改变用户的表达内容。

【核心原则】宁可漏改，不可错改。不确定时，保持原文不动。

## 绝对禁止（红线规则，最高优先级）
1. ❌ 禁止删除用户说出的任何词语（包括"嗯"、"啊"、"那个"、"然后"、"就是"、"就是说"、"然后呢"等口语词）
2. ❌ 禁止添加原文中没有的内容或观点
3. ❌ 禁止改变语义、语序或说话者的意图
4. ❌ 禁止将口语书面化（"我觉得"不要改成"我认为"）
5. ❌ 禁止替换专有名词（站点名、品牌名、人名等），即使你认为可能是其他词
6. ❌ 禁止猜测用户意图，只修正明确的语音识别错误
7. ❌ 禁止输出任何解释、备注、引号包裹

## 纠错范围（仅限以下 3 类，其他一律不改）

### 1. 同音字/谐音纠错
修正因发音相似导致的错误识别：
- "因为" 被识别为 "音为" → 纠正为 "因为"
- "可视化" 被识别为 "可视花" → 纠正为 "可视化"
- 正确的词不动："在线" ✓、"干细胞" ✓

### 2. 技术/产品名词修正（仅在语境明确时）
- "give ME"/"基米尼"/"杰米尼" → Gemini
- "Deep sick"/"deep seek" → DeepSeek
- "chat GDP" → ChatGPT
- "克劳德" → Claude
- "paddleocr" → PaddleOCR
- "open AI" → OpenAI
- "GPT四" → GPT-4
- 用户自定义的其他映射

### 3. 标点修正
- 句末缺标点时补充（陈述句"。"，疑问句"？"）
- 并列短语补顿号（"苹果香蕉橘子"→"苹果、香蕉、橘子"）
- 数字格式化："百分之三十"→"30%"
- 不过度添加标点，保持口语节奏

## 上下文感知
- 阅读【前文】理解主题和领域
- 根据上下文推断专业术语和人名
- 不要据此脑补或添加内容

## 输出要求
- 直接输出纠正后的完整文本
- 如果原文没有错误，原样输出，一个字都不改"""

# 速度优先模式：精简但保留关键约束（与 SYSTEM_PROMPT 规则一致）
FAST_SYSTEM_PROMPT = """你是 ASR 纠错助手。只修正语音识别错误，不改用户表达。

【核心原则】宁可漏改，不可错改。

## 禁止操作（最高优先级）
- 禁止删除任何词语（包括"嗯"、"那个"、"然后"、"就是"等口语词）
- 禁止添加原文没有的内容（补标点除外）
- 禁止改变语序、语义，禁止书面化
- 禁止替换专有名词（站点名、人名等必须保留原文）
- 不确定时，原样输出，一个字都不改

## 纠错范围（仅限 3 类）
1. 同音字/谐音："音为"→"因为"、"可视花"→"可视化"
2. 技术名词：deep seek→DeepSeek、chat GDP→ChatGPT、克劳德→Claude、基米尼→Gemini、Ymail→YAML
3. 标点：句末补句号/问号，并列项补顿号，"百分之X"→"X%"

阅读【前文】理解主题，但不据此脑补内容。直接输出纠正后的文本。"""

# Few-Shot 示例 - 教会模型期望的纠错粒度
# 设计原则：
# 1. 至少 50% 为 no_change 示例，教模型克制
# 2. 纠错示例只改 ASR 错误（同音字、技术名词、标点），保留所有口语词
# 3. 不包含删除口语词的示例
FEW_SHOT_EXAMPLES = [
    # === no_change 克制型示例（教模型"不要过度纠错"）===
    {
        "domain": "no_change",
        "context": "",
        "input": "嗯我觉得这个方案呢就是说还不错，然后我们可以继续推进。",
        "output": "嗯我觉得这个方案呢就是说还不错，然后我们可以继续推进。"
    },
    {
        "domain": "no_change",
        "context": "今天我们来聊一下ChatGPT和Claude的区别。",
        "input": "其实我觉得这两个模型各有各的优势，没有说哪个一定比另一个好。",
        "output": "其实我觉得这两个模型各有各的优势，没有说哪个一定比另一个好。"
    },
    {
        "domain": "no_change",
        "context": "",
        "input": "我们团队最近在做一个新的项目，主要是面向企业客户的。",
        "output": "我们团队最近在做一个新的项目，主要是面向企业客户的。"
    },
    {
        "domain": "no_change",
        "context": "",
        "input": "我觉得吧这个东西其实也没有那么复杂，就是你得花点时间去研究一下。",
        "output": "我觉得吧这个东西其实也没有那么复杂，就是你得花点时间去研究一下。"
    },
    {
        "domain": "no_change",
        "context": "",
        "input": "那个那个我想说的是，然后呢这个项目其实还挺有意思的。",
        "output": "那个那个我想说的是，然后呢这个项目其实还挺有意思的。"
    },
    {
        "domain": "no_change",
        "context": "",
        "input": "但是公益站一直在有维护，到现在也算稳定运行半年多了。",
        "output": "但是公益站一直在有维护，到现在也算稳定运行半年多了。"
    },
    {
        "domain": "no_change",
        "context": "现在没有暑假那段时间疯狂coding和刷L站那么勤快了。",
        "input": "老友们的留言和私信我抽空都会看，有问题的我都会去修复。",
        "output": "老友们的留言和私信我抽空都会看，有问题的我都会去修复。"
    },
    # === tech 领域（只改 ASR 错误，保留口语词）===
    {
        "domain": "tech",
        "context": "",
        "input": "嗯那个我觉得deep seek这个模型呢就是说还挺不错的，它的推理能力比较强。",
        "output": "嗯那个我觉得DeepSeek这个模型呢就是说还挺不错的，它的推理能力比较强。"
    },
    {
        "domain": "tech",
        "context": "",
        "input": "今天我们来聊一下chat GDP和克劳德的区别。",
        "output": "今天我们来聊一下ChatGPT和Claude的区别。"
    },
    {
        "domain": "tech",
        "context": "",
        "input": "这个项目的技术栈主要是python加上react。",
        "output": "这个项目的技术栈主要是Python加上React。"
    },
    {
        "domain": "tech",
        "context": "我们在讨论前端框架的选型。",
        "input": "然后就是说next JS的那个server side rendering性能确实比较好。",
        "output": "然后就是说Next.js的那个Server Side Rendering性能确实比较好。"
    },
    # === medical 领域 ===
    {
        "domain": "medical",
        "context": "我们最近在做一个医疗影像的项目。\n主要是用深度学习来做肺部CT的分割。",
        "input": "然后我们发现用那个优内特的效果比较好，分割的精度能到百分之九十五以上。",
        "output": "然后我们发现用那个U-Net的效果比较好，分割的精度能到95%以上。"
    },
    {
        "domain": "medical",
        "context": "",
        "input": "这个患者的干细胞移植手术非常成功，术后恢复也很好。",
        "output": "这个患者的干细胞移植手术非常成功，术后恢复也很好。"
    },
    # === business 领域 ===
    {
        "domain": "business",
        "context": "",
        "input": "我们上个季度的GMV增长了百分之三十，用户日活也涨了不少。",
        "output": "我们上个季度的GMV增长了30%，用户日活也涨了不少。"
    },
    {
        "domain": "business",
        "context": "",
        "input": "然后就是这个产品的PMF还没有完全跑通，需要再迭代一下。",
        "output": "然后就是这个产品的PMF还没有完全跑通，需要再迭代一下。"
    },
    # === legal 领域 ===
    {
        "domain": "legal",
        "context": "我们在讨论这个合同的条款。",
        "input": "根据合同法第一百零七条的规定，当事人一方不履行合同义务或者旅行合同义务不符合约定的。",
        "output": "根据合同法第107条的规定，当事人一方不履行合同义务或者履行合同义务不符合约定的。"
    },
    # === finance 领域 ===
    {
        "domain": "finance",
        "context": "",
        "input": "嗯那个我们这个季度的净利润大概是两千三百万，同比增长了百分之十五。",
        "output": "嗯那个我们这个季度的净利润大概是2300万，同比增长了15%。"
    },
    # === education 领域 ===
    {
        "domain": "education",
        "context": "今天我们来讲一下高等数学的内容。",
        "input": "泰勒公式的核心思想就是用多项式来逼近一个复杂的含数。",
        "output": "泰勒公式的核心思想就是用多项式来逼近一个复杂的函数。"
    },
    # === general 日常 ===
    {
        "domain": "general",
        "context": "",
        "input": "我觉得今天天气还不错，下午可以出去走走。",
        "output": "我觉得今天天气还不错，下午可以出去走走。"
    },
    {
        "domain": "general",
        "context": "",
        "input": "你觉得这个方案怎么样 有没有什么需要改进的地方",
        "output": "你觉得这个方案怎么样？有没有什么需要改进的地方？"
    },
    # === 专有名词保留 ===
    {
        "domain": "no_change",
        "context": "",
        "input": "那个人说的那个方案其实还不错。",
        "output": "那个人说的那个方案其实还不错。"
    },
]

# 用户消息模板 - 含上下文的纠错请求
USER_PROMPT_WITH_CONTEXT = """【前文】
{context}

【待纠错文本】
{text}"""

# 用户消息模板 - 无上下文的纠错请求
USER_PROMPT_NO_CONTEXT = """【待纠错文本】
{text}"""

# 批量纠错分隔符（用于多句合并纠错）
BATCH_SEPARATOR = "\n"

# 批量纠错用户消息模板
BATCH_USER_PROMPT_WITH_CONTEXT = """【前文】
{context}

【待纠错文本（共{count}句，用换行分隔，请保持句数和换行不变）】
{text}"""

BATCH_USER_PROMPT_NO_CONTEXT = """【待纠错文本（共{count}句，用换行分隔，请保持句数和换行不变）】
{text}"""

# 批量纠错专用 Few-Shot（教模型保持行数一致）
BATCH_FEW_SHOT_EXAMPLES = [
    {
        "context": "我们在讨论一个开源项目的配置方式。",
        "input": "现在不需要打开Ymail文件手动修改了。\n使用法，订阅链接或节点链接黏贴进去就行。\n可视花配置界面非常方便。",
        "output": "现在不需要打开YAML文件手动修改了。\n使用方法，订阅链接或节点链接粘贴进去就行。\n可视化配置界面非常方便。",
    },
    {
        "context": "",
        "input": "我觉得今天天气还不错。\n下午可以出去走走。",
        "output": "我觉得今天天气还不错。\n下午可以出去走走。",
    },
]

# ============ 两阶段检测 Prompt（轻量级，极低 token 开销）============

DETECT_SYSTEM_PROMPT = """你是 ASR 文本质量检测器。判断每句文本是否包含明显的语音识别错误。
错误类型：同音字/谐音错误、技术名词拼写错误、明显的标点缺失。
注意：口语化表达（如"我觉得"、"然后"、"就是"、"嗯"、"那个"）不算错误，不需要纠错。"""

DETECT_USER_PROMPT = """判断以下{count}句 ASR 文本是否需要纠错。
每句只回答 Y 或 N，用换行分隔，输出恰好{count}行，不要输出其他内容。

{text}"""

DETECT_USER_PROMPT_WITH_CONTEXT = """【前文】
{context}

判断以下{count}句 ASR 文本是否需要纠错。
每句只回答 Y 或 N，用换行分隔，输出恰好{count}行，不要输出其他内容。

{text}"""

QUICK_REPLACEMENTS = [
    (r"deep\s*seek|deep\s*sick|地普西克", "DeepSeek"),
    (r"chat\s*gdp", "ChatGPT"),
    (r"克劳德|科劳德", "Claude"),
    (r"open\s*ai", "OpenAI"),
    (r"paddle\s*ocr|paddleocr|padleocr", "PaddleOCR"),
    (r"基米尼|杰米尼|基米三|kimi三", "Gemini"),
    (r"\bYmail\b", "YAML"),
    (r"\bymail\b", "YAML"),
    # ASR 常见误识别：coding 的各种谐音
    (r"秃顶|扣顶|抠点头顶|抠顶|叩顶", "coding"),
    # "l 站" / "L 站" 规范化（保留原意，不改成 B站）
    (r"(?<![a-zA-Z])l\s*站", "L站"),
    (r"SYLLABLE\s*", ""),  # 火山引擎噪音标记，直接去除
]
QUICK_REPLACEMENT_PATTERNS = [
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in QUICK_REPLACEMENTS
]


class DoubaoCorrector:
    """豆包大模型纠错器（火山方舟 SDK）
    
    关键设计：
    - System Prompt 承载角色、规则、术语表（稳定层）
    - Few-Shot 示例教会纠错粒度
    - 上下文感知：传入前几句 final 文本辅助判断
    - 低 temperature（0.05）确保确定性输出
    """
    
    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint_id: Optional[str] = None,
        fast_mode: bool = True,
        max_context_items: int = 3,
        few_shot_count: int = 1,
        max_output_tokens: int = 96,
        request_timeout_sec: float = 3.0,
    ):
        """
        初始化豆包纠错器
        
        Args:
            api_key: 火山方舟 API Key（ARK_API_KEY）
            endpoint_id: 推理接入点 ID（ep-xxx 格式）
        """
        self.api_key = api_key or os.getenv("ARK_API_KEY", "")
        self.endpoint_id = endpoint_id or os.getenv("ARK_ENDPOINT_ID", "")
        self._client = None
        self._fast_mode = fast_mode
        self._few_shot_count = max(0, few_shot_count)
        self._max_output_tokens = max(48, max_output_tokens)
        self._request_timeout_sec = max(0.5, request_timeout_sec)
        # 上下文窗口：保存最近的 final 文本用于辅助纠错
        self._context_window: List[str] = []
        self._max_context_items = max(0, max_context_items)
        # 热词提示（由 SessionManager 注入）
        self._hotword_hints: List[str] = []
    
    def set_hotwords(self, hotwords: List[str]):
        """注入 ASR 热词作为术语参考，纠错时优先考虑这些拼写"""
        self._hotword_hints = hotwords[:50]

    def _extract_entities(self) -> List[str]:
        """从上下文窗口中提取可能的实体（人名、地名、专有名词）作为白名单"""
        if not self._context_window:
            return []
        entities = set()
        context_text = " ".join(self._context_window)
        # 提取连续的英文单词（可能是人名、产品名）
        # 匹配 2+ 字符的英文词组（排除常见介词等）
        en_words = re.findall(r'\b[A-Z][a-zA-Z]{1,}(?:\s+[A-Z][a-zA-Z]+)*\b', context_text)
        for w in en_words:
            if w not in {"The", "This", "That", "What", "How", "And", "But", "For", "Not"}:
                entities.add(w)
        # 提取中文专有名词模式：引号内的内容
        quoted = re.findall(r'[""「」『』](.+?)[""」」『』]', context_text)
        for q in quoted:
            if 1 < len(q) <= 10:
                entities.add(q)
        # 从热词中提取已出现在上下文中的词
        for hw in self._hotword_hints:
            if hw in context_text:
                entities.add(hw)
        return list(entities)[:30]  # 限制数量避免 prompt 过长

    def _get_client(self):
        """延迟初始化客户端"""
        if self._client is None:
            try:
                from volcenginesdkarkruntime import AsyncArk
                self._client = AsyncArk(api_key=self.api_key)
            except ImportError:
                raise ImportError(
                    "请安装火山方舟 SDK: pip install 'volcengine-python-sdk[ark]'"
                )
        return self._client
    
    def _select_examples(self, text: str) -> list:
        """根据上下文和文本内容选择最相关的 few-shot 示例

        选择策略：至少 50% 为 no_change 示例，教模型克制。
        """
        if self._few_shot_count <= 0:
            return []
        # 简单关键词匹配推断领域
        all_text = " ".join(self._context_window) + " " + text
        domain = "general"
        if any(kw in all_text for kw in ["模型", "AI", "GPT", "代码", "API", "算法", "训练"]):
            domain = "tech"
        elif any(kw in all_text for kw in ["患者", "治疗", "诊断", "医院", "手术", "临床"]):
            domain = "medical"
        elif any(kw in all_text for kw in ["营收", "融资", "用户增长", "KPI", "GMV", "ROI"]):
            domain = "business"
        elif any(kw in all_text for kw in ["合同", "法律", "诉讼", "法院", "条款", "被告"]):
            domain = "legal"
        elif any(kw in all_text for kw in ["利润", "股票", "基金", "投资", "财报", "市值"]):
            domain = "finance"
        elif any(kw in all_text for kw in ["课程", "教学", "学生", "考试", "公式", "定理"]):
            domain = "education"

        no_change = [e for e in FEW_SHOT_EXAMPLES if e["domain"] == "no_change"]
        domain_match = [e for e in FEW_SHOT_EXAMPLES if e["domain"] == domain]
        others = [e for e in FEW_SHOT_EXAMPLES if e["domain"] not in (domain, "no_change")]

        # 至少 50% 为 no_change 示例，教模型克制
        no_change_count = max(1, (self._few_shot_count + 1) // 2)
        domain_count = self._few_shot_count - no_change_count

        selected = domain_match[:domain_count]
        if len(selected) < domain_count:
            selected += others[:domain_count - len(selected)]
        selected += no_change[:no_change_count]
        return selected[:self._few_shot_count]

    def _build_messages(self, text: str) -> list:
        """
        构建消息列表（System + Few-Shot + User）
        
        这是核心 Prompt 工程：
        1. system: 角色定义 + 规则 + 术语表
        2. few-shot: 示例对（教会纠错粒度）
        3. user: 实际待纠错文本 + 上下文
        """
        system_content = FAST_SYSTEM_PROMPT if self._fast_mode else SYSTEM_PROMPT
        # 动态注入热词参考
        if self._hotword_hints:
            system_content += "\n\n### 参考术语（ASR 热词）\n纠错时优先考虑以下拼写：" + "、".join(self._hotword_hints)
        # 动态注入实体白名单（从上下文中提取）
        entities = self._extract_entities()
        if entities:
            system_content += "\n\n### 实体白名单（前文已出现，请勿修改这些词的拼写）\n" + "、".join(entities)
        messages = [{
            "role": "system",
            "content": system_content
        }]
        
        # 注入 Few-Shot 示例（领域自适应选择）
        selected_examples = self._select_examples(text)

        for example in selected_examples:
            if example["context"]:
                user_content = USER_PROMPT_WITH_CONTEXT.format(
                    context=example["context"],
                    text=example["input"]
                )
            else:
                user_content = USER_PROMPT_NO_CONTEXT.format(text=example["input"])
            
            messages.append({"role": "user", "content": user_content})
            messages.append({"role": "assistant", "content": example["output"]})
        
        # 构建实际用户请求（含上下文）
        context_text = "\n".join(self._context_window) if self._context_window else ""
        if context_text:
            user_content = USER_PROMPT_WITH_CONTEXT.format(
                context=context_text,
                text=text
            )
        else:
            user_content = USER_PROMPT_NO_CONTEXT.format(text=text)
        
        messages.append({"role": "user", "content": user_content})
        
        return messages
    
    def _update_context(self, text: str):
        """更新上下文窗口"""
        if self._max_context_items <= 0:
            return
        self._context_window.append(text)
        if len(self._context_window) > self._max_context_items:
            self._context_window.pop(0)

    def _validate_correction(self, original: str, corrected: str) -> bool:
        """多信号验证纠错质量，防止幻觉和过度纠正

        设计原则：宁可放过错误，不可过度纠正。
        验证函数是最后一道防线，主要拦截 LLM 幻觉（大幅改写），
        而非微小的过度纠错（那由 Prompt 约束来防止）。
        """
        if not corrected:
            return False

        # 使用语义长度（中文字符权重 2）避免中英混排时长度比失真
        orig_slen = _semantic_len(original)
        corr_slen = _semantic_len(corrected)
        # 短文本（原文<15字符）放宽阈值，因为单个术语替换就可能导致高变化比
        is_short = len(original) < 15

        # 信号 1: 非对称长度比 — 收紧阈值
        # 纠错不应大幅改变文本长度
        ratio = corr_slen / orig_slen
        max_increase = 1.30 if is_short else 1.20
        min_ratio = 0.70 if is_short else 0.68
        if ratio > max_increase or ratio < min_ratio:
            print(f"[DoubaoCorrector] 验证失败(长度比={ratio:.2f}): '{original[:30]}' → '{corrected[:30]}'")
            return False

        # 信号 2: ER = (S+D+I)/N — 收紧阈值
        subs, dels, ins = _edit_operations(original, corrected)
        N = max(len(original), 1)
        er = (subs + dels + ins) / N
        max_er = 0.45 if is_short else 0.40
        if er > max_er:
            print(f"[DoubaoCorrector] 验证失败(ER={er:.2f}, S={subs}/D={dels}/I={ins}): '{original[:30]}' → '{corrected[:30]}'")
            return False

        # 信号 3: 关键内容字符保留 — 提取中文字符，重叠率 < 50% 则拒绝
        orig_chars = set(ch for ch in original if '\u4e00' <= ch <= '\u9fff')
        corr_chars = set(ch for ch in corrected if '\u4e00' <= ch <= '\u9fff')
        if orig_chars:
            overlap = len(orig_chars & corr_chars) / len(orig_chars)
            if overlap < 0.5:
                print(f"[DoubaoCorrector] 验证失败(内容保留率={overlap:.2f}): '{original[:30]}' → '{corrected[:30]}'")
                return False

        # 信号 4: 删除操作专项检测 — 纠错不应删除用户内容
        # 允许少量删除（标点调整、数字格式化等），但大量删除说明 LLM 违反了"禁止删除"约束
        max_del_ratio = 0.22 if is_short else 0.22
        del_ratio = dels / N
        if del_ratio > max_del_ratio:
            print(f"[DoubaoCorrector] 验证失败(删除比={del_ratio:.2f}, D={dels}): '{original[:30]}' → '{corrected[:30]}'")
            return False

        return True

    def _quick_normalize(self, text: str) -> str:
        """轻量规则纠错：命中常见误识别时直接返回，避免走 LLM。"""
        corrected = text
        for pattern, replacement in QUICK_REPLACEMENT_PATTERNS:
            corrected = pattern.sub(replacement, corrected)
        return corrected
    
    async def correct(self, text: str) -> Tuple[str, Optional[str]]:
        """
        纠错 ASR 识别结果（单句模式，保留向后兼容）

        Args:
            text: ASR 识别的原始文本

        Returns:
            (纠错后文本, 调试信息)
        """
        if not text or not text.strip():
            return text, None

        if not self.api_key or not self.endpoint_id:
            print("[DoubaoCorrector] 缺少 API Key 或 Endpoint ID，跳过纠错")
            return text, None

        # 先做规则纠错，命中后直接返回，减少端到端延迟
        quick_corrected = self._quick_normalize(text)
        if quick_corrected != text:
            self._update_context(quick_corrected)
            return quick_corrected, "quick_rule"

        # 构建消息（含 System + Few-Shot + 上下文）
        messages = self._build_messages(text)

        try:
            client = self._get_client()

            # 调用豆包模型
            estimated_tokens = int(len(text) * (1.6 if self._fast_mode else 2.2)) + 24
            max_tokens = min(max(estimated_tokens, 48), self._max_output_tokens)
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=self.endpoint_id,
                    messages=messages,
                    temperature=0.0 if self._fast_mode else 0.05,
                    max_tokens=max_tokens,
                ),
                timeout=self._request_timeout_sec,
            )

            # 解析返回结果
            if response.choices and len(response.choices) > 0:
                corrected = response.choices[0].message.content.strip()

                # 清理可能的引号包裹
                if corrected.startswith('"') and corrected.endswith('"'):
                    corrected = corrected[1:-1]
                if corrected.startswith("'") and corrected.endswith("'"):
                    corrected = corrected[1:-1]

                # 清理可能的标签包裹（模型可能输出 【纠正后文本】 等）
                for prefix in ["【纠正后文本】", "【输出】", "纠正后：", "输出："]:
                    if corrected.startswith(prefix):
                        corrected = corrected[len(prefix):].strip()

                # 多信号验证纠错质量（防幻觉、防过度纠正）
                if not self._validate_correction(text, corrected):
                    self._update_context(text)
                    return text, None

                if corrected and corrected != text:
                    print(f"[DoubaoCorrector] '{text[:40]}' → '{corrected[:40]}'")
                    # 用纠正后的文本更新上下文
                    self._update_context(corrected)
                    return corrected, "corrected"
                else:
                    print(f"[DoubaoCorrector] 无变化: '{text[:40]}'")
                    self._update_context(text)
                    return text, None
            else:
                print(f"[DoubaoCorrector] 返回结果为空")
                self._update_context(text)
                return text, None

        except asyncio.TimeoutError:
            print(f"[DoubaoCorrector] 纠错超时({self._request_timeout_sec}s)，保留原文")
            self._update_context(text)
            return text, None
        except Exception as e:
            print(f"[DoubaoCorrector] 纠错失败: {e}")
            self._update_context(text)
            return text, None

    async def detect_batch(self, texts: List[str], timeout_sec: float = 1.5) -> List[bool]:
        """
        批量检测多句文本是否需要纠错（两阶段检测的第一阶段）

        使用极简 prompt，LLM 只需回答 Y/N，token 开销极低。
        检测失败时保守返回全 True（即全部送去纠错，不丢失纠错机会）。

        Args:
            texts: 多句 ASR 原始文本
            timeout_sec: 检测超时（秒）

        Returns:
            与 texts 等长的布尔列表，True 表示需要纠错
        """
        if not texts:
            return []

        all_need = [True] * len(texts)  # 保守默认：全部需要纠错

        if not self.api_key or not self.endpoint_id:
            return all_need

        merged_text = BATCH_SEPARATOR.join(texts)
        # 构建检测消息（含上下文时检测更准确）
        context_text = "\n".join(self._context_window) if self._context_window else ""
        if context_text:
            user_content = DETECT_USER_PROMPT_WITH_CONTEXT.format(
                context=context_text, count=len(texts), text=merged_text
            )
        else:
            user_content = DETECT_USER_PROMPT.format(
                count=len(texts), text=merged_text
            )
        messages = [
            {"role": "system", "content": DETECT_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]

        try:
            client = self._get_client()
            # 每句只需 1-2 token（Y/N），极低开销
            max_tokens = len(texts) * 3 + 8
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=self.endpoint_id,
                    messages=messages,
                    temperature=0.0,
                    max_tokens=max_tokens,
                ),
                timeout=timeout_sec,
            )

            if response.choices and len(response.choices) > 0:
                raw = response.choices[0].message.content.strip()
                lines = [line.strip().upper() for line in raw.split("\n") if line.strip()]

                if len(lines) == len(texts):
                    results = []
                    for line in lines:
                        # 容错：只要包含 N 且不包含 Y 就认为不需要纠错
                        if "N" in line and "Y" not in line:
                            results.append(False)
                        else:
                            results.append(True)
                    skip_count = results.count(False)
                    print(f"[DoubaoCorrector·detect] {len(texts)}句中{skip_count}句无需纠错，跳过")
                    return results
                else:
                    print(f"[DoubaoCorrector·detect] 行数不匹配: 期望{len(texts)}, 实际{len(lines)}, 保守全部纠错")
                    return all_need
            else:
                print(f"[DoubaoCorrector·detect] 返回为空，保守全部纠错")
                return all_need

        except asyncio.TimeoutError:
            print(f"[DoubaoCorrector·detect] 检测超时({timeout_sec}s)，保守全部纠错")
            return all_need
        except Exception as e:
            print(f"[DoubaoCorrector·detect] 检测失败: {e}，保守全部纠错")
            return all_need

    async def correct_batch(
        self, texts: List[str], max_output_tokens: int = 256,
        enable_detection: bool = False, detection_timeout_sec: float = 1.5,
    ) -> List[Tuple[str, Optional[str]]]:
        """
        批量纠错多句 ASR 文本（滑动窗口模式）

        将多句文本合并为一段，一次 LLM 调用完成纠错，
        比逐句调用有更充分的上下文，纠错精度更高。

        两阶段模式（enable_detection=True）：
        1. 先用轻量 prompt 检测哪些句子需要纠错
        2. 只对需要纠错的句子调用完整纠错 LLM

        Args:
            texts: 多句 ASR 原始文本列表
            max_output_tokens: 批量纠错最大输出 token
            enable_detection: 是否启用检测阶段
            detection_timeout_sec: 检测阶段超时（秒）

        Returns:
            与 texts 等长的列表，每项为 (纠错后文本, 调试信息)
        """
        if not texts:
            return []

        # 对每句先做规则纠错
        quick_results: List[Tuple[int, str, str]] = []  # (index, original, quick_corrected)
        remaining: List[Tuple[int, str]] = []  # (index, text) 需要 LLM 纠错的

        for i, text in enumerate(texts):
            if not text or not text.strip():
                quick_results.append((i, text, text))
                continue
            quick_corrected = self._quick_normalize(text)
            if quick_corrected != text:
                quick_results.append((i, text, quick_corrected))
            else:
                remaining.append((i, text))

        # 初始化结果列表（默认原文不变）
        results: List[Tuple[str, Optional[str]]] = [(t, None) for t in texts]

        # 填入规则纠错结果
        for idx, original, corrected in quick_results:
            if corrected != original:
                results[idx] = (corrected, "quick_rule")
            # else: 保持 (original, None)

        # 如果没有需要 LLM 纠错的，直接返回
        if not remaining:
            for text in texts:
                self._update_context(text)
            return results

        # 检查 API 配置
        if not self.api_key or not self.endpoint_id:
            print("[DoubaoCorrector] 缺少 API Key 或 Endpoint ID，跳过批量纠错")
            for text in texts:
                self._update_context(text)
            return results

        # ===== 两阶段检测：先检测哪些句子需要纠错 =====
        # 仅当 batch >= 2 时才启用检测（单句时检测性价比极低，直接走纠错）
        if enable_detection and len(remaining) >= 2:
            remaining_texts_for_detect = [t for _, t in remaining]
            need_correction = await self.detect_batch(
                remaining_texts_for_detect, timeout_sec=detection_timeout_sec
            )
            # 过滤掉不需要纠错的句子
            filtered_remaining = []
            for j, (idx, text) in enumerate(remaining):
                if need_correction[j]:
                    filtered_remaining.append((idx, text))
                else:
                    # 标记为检测跳过
                    results[idx] = (text, "detect_skip")
            if len(filtered_remaining) < len(remaining):
                print(f"[DoubaoCorrector·detect] 过滤后: {len(remaining)}→{len(filtered_remaining)}句需要纠错")
            remaining = filtered_remaining

            # 如果检测后全部不需要纠错，直接返回
            if not remaining:
                print(f"[DoubaoCorrector·detect] 全部跳过，无需调用纠错 LLM")
                for text in texts:
                    self._update_context(text)
                return results

        # 合并待纠错文本（用换行分隔）
        remaining_texts = [t for _, t in remaining]
        merged_text = BATCH_SEPARATOR.join(remaining_texts)

        # 构建批量纠错消息
        messages = self._build_batch_messages(merged_text, len(remaining_texts))

        try:
            client = self._get_client()

            estimated_tokens = int(len(merged_text) * (1.6 if self._fast_mode else 2.2)) + 32
            max_tokens = min(max(estimated_tokens, 64), max_output_tokens)

            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=self.endpoint_id,
                    messages=messages,
                    temperature=0.0 if self._fast_mode else 0.05,
                    max_tokens=max_tokens,
                ),
                timeout=self._request_timeout_sec,
            )

            if response.choices and len(response.choices) > 0:
                raw_output = response.choices[0].message.content.strip()

                # 清理可能的标签包裹
                for prefix in ["【纠正后文本】", "【输出】", "纠正后：", "输出："]:
                    if raw_output.startswith(prefix):
                        raw_output = raw_output[len(prefix):].strip()

                # 按换行拆分回多句
                corrected_lines = raw_output.split(BATCH_SEPARATOR)

                # 如果行数匹配，逐句验证并填入结果
                if len(corrected_lines) == len(remaining_texts):
                    for j, (orig_idx, original) in enumerate(remaining):
                        corrected = corrected_lines[j].strip()
                        # 清理引号
                        if corrected.startswith('"') and corrected.endswith('"'):
                            corrected = corrected[1:-1]
                        if corrected.startswith("'") and corrected.endswith("'"):
                            corrected = corrected[1:-1]

                        if corrected and corrected != original and self._validate_correction(original, corrected):
                            results[orig_idx] = (corrected, "batch_corrected")
                            print(f"[DoubaoCorrector·batch] '{original[:30]}' → '{corrected[:30]}'")
                        else:
                            # 验证失败或无变化，保留原文
                            results[orig_idx] = (original, None)
                else:
                    # 行数不匹配：LLM 可能合并/拆分了句子，回退逐句纠错
                    print(f"[DoubaoCorrector·batch] 行数不匹配: 期望{len(remaining_texts)}行, 实际{len(corrected_lines)}行, 回退逐句")
                    for orig_idx, original in remaining:
                        try:
                            corrected_single, reason = await asyncio.wait_for(
                                self.correct(original),
                                timeout=self._request_timeout_sec,
                            )
                            if corrected_single and corrected_single != original:
                                results[orig_idx] = (corrected_single, "fallback_single")
                        except Exception:
                            pass  # 逐句也失败则保留原文
            else:
                print(f"[DoubaoCorrector·batch] 返回结果为空")

        except asyncio.TimeoutError:
            print(f"[DoubaoCorrector·batch] 批量纠错超时({self._request_timeout_sec}s)，保留原文")
        except Exception as e:
            print(f"[DoubaoCorrector·batch] 批量纠错失败: {e}")

        # 更新上下文（用纠错后的文本）
        for corrected_text, _ in results:
            self._update_context(corrected_text)

        return results

    def _build_batch_messages(self, merged_text: str, count: int) -> list:
        """
        构建批量纠错的消息列表

        与单句模式共享 System Prompt 和 Few-Shot，
        但 User Prompt 使用批量模板，强调保持行数不变。
        """
        system_content = FAST_SYSTEM_PROMPT if self._fast_mode else SYSTEM_PROMPT
        # 追加批量纠错的额外约束
        system_content += "\n\n### 批量纠错规则\n输入为多句文本（换行分隔），请逐句纠错后输出，保持句数和换行与输入完全一致。"

        if self._hotword_hints:
            system_content += "\n\n### 参考术语（ASR 热词）\n纠错时优先考虑以下拼写：" + "、".join(self._hotword_hints)
        # 动态注入实体白名单
        entities = self._extract_entities()
        if entities:
            system_content += "\n\n### 实体白名单（前文已出现，请勿修改这些词的拼写）\n" + "、".join(entities)

        messages = [{"role": "system", "content": system_content}]

        # 注入批量专用 Few-Shot 示例（教模型保持行数一致）
        for example in BATCH_FEW_SHOT_EXAMPLES:
            if example["context"]:
                user_content = BATCH_USER_PROMPT_WITH_CONTEXT.format(
                    context=example["context"],
                    count=len(example["input"].split("\n")),
                    text=example["input"],
                )
            else:
                user_content = BATCH_USER_PROMPT_NO_CONTEXT.format(
                    count=len(example["input"].split("\n")),
                    text=example["input"],
                )
            messages.append({"role": "user", "content": user_content})
            messages.append({"role": "assistant", "content": example["output"]})

        # 构建实际批量请求
        context_text = "\n".join(self._context_window) if self._context_window else ""
        if context_text:
            user_content = BATCH_USER_PROMPT_WITH_CONTEXT.format(
                context=context_text, count=count, text=merged_text
            )
        else:
            user_content = BATCH_USER_PROMPT_NO_CONTEXT.format(
                count=count, text=merged_text
            )

        messages.append({"role": "user", "content": user_content})
        return messages
    
    def reset_context(self):
        """重置上下文窗口（新会话时调用）"""
        self._context_window.clear()
    
    async def close(self):
        """关闭客户端"""
        self._client = None
