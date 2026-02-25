"""
语义分段器模块

基于语义连贯性和句子完整性判断进行智能分段。
支持多种分段策略：
1. 基于规则的快速分段
2. 基于 BERT 的语义连贯性分段
3. 基于标点模型的分段
"""

import re
from typing import List, Optional, Tuple
from dataclasses import dataclass
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class SegmentResult:
    """分段结果"""
    should_segment: bool
    confidence: float  # 0-1 之间的置信度
    reason: str  # 分段原因


class RuleBasedSegmenter:
    """
    基于规则的快速分段器

    使用语言学规则判断句子完整性，速度快，适合实时场景。
    """

    def __init__(self):
        # 句子结束标志
        self.sentence_endings = re.compile(r'[。！？\.!?]$')

        # 明确的句子结束标志（带标点）
        self.strong_endings = re.compile(r'[。！？]$')

        # 不完整句子特征（连接词结尾）
        self.incomplete_connectors = re.compile(
            r'(因为|所以|但是|然而|如果|虽然|尽管|不过|而且|并且|或者|'
            r'而|且|并|况且|何况|甚至|以及|以至于|以便|为了|由于)$'
        )

        # 助词结尾（通常不完整）
        self.incomplete_particles = re.compile(r'(的|地|得|着|了|过)$')

        # 动词结尾无宾语（可能不完整）
        self.incomplete_verbs = re.compile(
            r'(是|在|有|会|要|能|可以|应该|必须|需要|想|希望|'
            r'认为|觉得|发现|看到|听到|说|讲|做|去|来|给|让|使)$'
        )

        # 疑问词开头（通常是新句子）
        self.question_starters = re.compile(
            r'^(什么|为什么|怎么|如何|哪里|哪个|谁|何时|多少|是否|能否)'
        )

        # 转折词开头（通常是新句子）
        self.transition_starters = re.compile(
            r'^(但是|然而|不过|可是|只是|然后|接着|于是|因此|所以|'
            r'总之|总的来说|综上所述|首先|其次|最后|另外|此外)'
        )

    def is_semantically_complete(self, text: str) -> SegmentResult:
        """
        判断文本是否语义完整

        Args:
            text: 待判断的文本

        Returns:
            SegmentResult: 分段结果
        """
        text = text.strip()

        # 规则 1：过短的文本可能不完整
        if len(text) < 3:
            return SegmentResult(
                should_segment=False,
                confidence=0.9,
                reason="文本过短"
            )

        # 规则 2：有明确的句子结束标志（强信号）
        if self.strong_endings.search(text):
            return SegmentResult(
                should_segment=True,
                confidence=0.95,
                reason="明确的句子结束标志"
            )

        # 规则 3：英文句号结尾（中等信号）
        if self.sentence_endings.search(text):
            return SegmentResult(
                should_segment=True,
                confidence=0.8,
                reason="句子结束标志"
            )

        # 规则 4：连接词结尾（不完整）
        if self.incomplete_connectors.search(text):
            return SegmentResult(
                should_segment=False,
                confidence=0.9,
                reason="连接词结尾，语义不完整"
            )

        # 规则 5：助词结尾（不完整）
        if self.incomplete_particles.search(text):
            return SegmentResult(
                should_segment=False,
                confidence=0.85,
                reason="助词结尾，语义不完整"
            )

        # 规则 6：动词结尾无宾语（可能不完整）
        if self.incomplete_verbs.search(text):
            return SegmentResult(
                should_segment=False,
                confidence=0.7,
                reason="动词结尾缺少宾语"
            )

        # 规则 7：长度检查（较长的文本更可能完整）
        if len(text) >= 15:
            return SegmentResult(
                should_segment=True,
                confidence=0.6,
                reason="文本较长，可能完整"
            )

        # 默认：不确定，倾向于不分段
        return SegmentResult(
            should_segment=False,
            confidence=0.5,
            reason="无明确信号，继续累积"
        )

    def should_start_new_segment(self, current_text: str, new_text: str) -> SegmentResult:
        """
        判断新文本是否应该开始新段落

        Args:
            current_text: 当前段落文本
            new_text: 新到达的文本

        Returns:
            SegmentResult: 分段结果
        """
        new_text = new_text.strip()

        # 规则 1：疑问词开头（新句子）
        if self.question_starters.search(new_text):
            return SegmentResult(
                should_segment=True,
                confidence=0.85,
                reason="疑问词开头，开始新句子"
            )

        # 规则 2：转折词开头（新句子）
        if self.transition_starters.search(new_text):
            return SegmentResult(
                should_segment=True,
                confidence=0.8,
                reason="转折词开头，开始新句子"
            )

        # 规则 3：当前段落已经很长
        if len(current_text) >= 100:
            return SegmentResult(
                should_segment=True,
                confidence=0.7,
                reason="当前段落过长"
            )

        return SegmentResult(
            should_segment=False,
            confidence=0.5,
            reason="继续当前段落"
        )


class SemanticSegmenter:
    """
    语义分段器

    结合多种策略进行智能分段：
    1. 快速规则分段（低延迟）
    2. 可选的深度学习模型分段（高准确率）
    """

    def __init__(
        self,
        min_segment_length: int = 5,
        max_segment_length: int = 150,
        confidence_threshold: float = 0.7,
        enable_bert: bool = False,
    ):
        """
        初始化语义分段器

        Args:
            min_segment_length: 最小段落长度（字符数）
            max_segment_length: 最大段落长度（字符数）
            confidence_threshold: 分段置信度阈值
            enable_bert: 是否启用 BERT 模型（需要额外依赖）
        """
        self.min_segment_length = min_segment_length
        self.max_segment_length = max_segment_length
        self.confidence_threshold = confidence_threshold
        self.enable_bert = enable_bert

        # 规则分段器（始终启用）
        self.rule_segmenter = RuleBasedSegmenter()

        # BERT 分段器（可选）
        self.bert_segmenter = None
        if enable_bert:
            try:
                self.bert_segmenter = BERTSemanticSegmenter()
                logger.info("BERT semantic segmenter enabled")
            except Exception as e:
                logger.warning(f"Failed to load BERT segmenter: {e}, falling back to rule-based")
                self.enable_bert = False

        logger.info(
            "Semantic segmenter initialized",
            min_length=min_segment_length,
            max_length=max_segment_length,
            threshold=confidence_threshold,
            bert_enabled=self.enable_bert,
        )

    def should_segment(
        self,
        text_buffer: List[str],
        new_text: Optional[str] = None,
    ) -> Tuple[bool, float, str]:
        """
        判断是否应该分段

        Args:
            text_buffer: 当前文本缓冲区
            new_text: 新到达的文本（可选）

        Returns:
            (should_segment, confidence, reason)
        """
        if not text_buffer:
            return False, 0.0, "缓冲区为空"

        combined_text = ' '.join(text_buffer)

        # 强制规则：超过最大长度必须分段
        if len(combined_text) >= self.max_segment_length:
            return True, 1.0, "超过最大段落长度"

        # 强制规则：低于最小长度不分段
        if len(combined_text) < self.min_segment_length:
            return False, 1.0, "未达到最小段落长度"

        # 规则 1：基于规则的快速判断
        rule_result = self.rule_segmenter.is_semantically_complete(combined_text)

        # 如果规则判断置信度高，直接返回
        if rule_result.confidence >= 0.85:
            return rule_result.should_segment, rule_result.confidence, rule_result.reason

        # 规则 2：判断新文本是否应该开始新段落
        if new_text:
            new_segment_result = self.rule_segmenter.should_start_new_segment(
                combined_text, new_text
            )
            if new_segment_result.confidence >= 0.8:
                return (
                    new_segment_result.should_segment,
                    new_segment_result.confidence,
                    new_segment_result.reason,
                )

        # 规则 3：如果启用了 BERT，使用 BERT 判断
        if self.enable_bert and self.bert_segmenter:
            try:
                bert_result = self.bert_segmenter.compute_completeness(combined_text)
                # 结合规则和 BERT 的结果
                combined_confidence = (rule_result.confidence + bert_result) / 2
                should_seg = combined_confidence >= self.confidence_threshold
                return should_seg, combined_confidence, "规则+BERT综合判断"
            except Exception as e:
                logger.warning(f"BERT segmentation failed: {e}, using rule-based result")

        # 默认：使用规则判断结果
        should_seg = rule_result.confidence >= self.confidence_threshold and rule_result.should_segment
        return should_seg, rule_result.confidence, rule_result.reason

    def segment_text_stream(self, text_stream: List[str]) -> List[str]:
        """
        对文本流进行分段

        Args:
            text_stream: 文本流（按时间顺序）

        Returns:
            分段后的文本列表
        """
        segments = []
        current_buffer = []

        for text in text_stream:
            current_buffer.append(text)

            should_seg, confidence, reason = self.should_segment(current_buffer)

            if should_seg:
                segment = ' '.join(current_buffer)
                segments.append(segment)
                logger.debug(
                    "Segment created",
                    segment=segment[:50] + "..." if len(segment) > 50 else segment,
                    confidence=confidence,
                    reason=reason,
                )
                current_buffer = []

        # 处理剩余文本
        if current_buffer:
            segments.append(' '.join(current_buffer))

        return segments


class BERTSemanticSegmenter:
    """
    基于 BERT 的语义分段器（可选）

    需要安装：pip install transformers torch
    """

    def __init__(self, model_name: str = "bert-base-chinese"):
        """
        初始化 BERT 分段器

        Args:
            model_name: BERT 模型名称
        """
        try:
            from transformers import BertTokenizer, BertModel
            import torch
            import torch.nn.functional as F

            self.tokenizer = BertTokenizer.from_pretrained(model_name)
            self.model = BertModel.from_pretrained(model_name)
            self.model.eval()  # 设置为评估模式
            self.torch = torch
            self.F = F

            logger.info(f"BERT model loaded: {model_name}")
        except ImportError:
            raise ImportError(
                "BERT segmenter requires transformers and torch. "
                "Install with: pip install transformers torch"
            )

    def compute_completeness(self, text: str) -> float:
        """
        计算文本的语义完整性得分

        Args:
            text: 待判断的文本

        Returns:
            完整性得分（0-1）
        """
        # 编码文本
        inputs = self.tokenizer(
            text,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=128,
        )

        # 获取 BERT 输出
        with self.torch.no_grad():
            outputs = self.model(**inputs)

        # 使用 [CLS] token 的输出作为句子表示
        cls_embedding = outputs.last_hidden_state[:, 0, :]

        # 计算完整性得分（这里使用简化的启发式方法）
        # 实际应用中可以训练一个分类器
        # 这里我们使用嵌入的范数作为完整性的代理指标
        completeness_score = self.torch.norm(cls_embedding).item() / 10.0
        completeness_score = min(1.0, max(0.0, completeness_score))

        return completeness_score

    def compute_coherence(self, text1: str, text2: str) -> float:
        """
        计算两段文本的语义连贯性

        Args:
            text1: 第一段文本
            text2: 第二段文本

        Returns:
            连贯性得分（0-1）
        """
        # 编码两段文本
        inputs1 = self.tokenizer(text1, return_tensors="pt", padding=True, truncation=True)
        inputs2 = self.tokenizer(text2, return_tensors="pt", padding=True, truncation=True)

        # 获取句子嵌入
        with self.torch.no_grad():
            outputs1 = self.model(**inputs1)
            outputs2 = self.model(**inputs2)

        emb1 = outputs1.last_hidden_state[:, 0, :]
        emb2 = outputs2.last_hidden_state[:, 0, :]

        # 计算余弦相似度
        coherence = self.F.cosine_similarity(emb1, emb2).item()

        # 归一化到 0-1
        coherence = (coherence + 1) / 2

        return coherence
