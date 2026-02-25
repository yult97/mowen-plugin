"""
LLM 纠错模块
使用 DeepSeek Chat 对 ASR 识别结果进行语义纠错
"""

import os
import httpx
from typing import Optional, Tuple

# 纠错 Prompt 模板（直接、明确，不让 LLM 犹豫）
CORRECTION_PROMPT = """你是 ASR 文本纠错专家。以下文本来自语音识别，用户正在讨论 AI/技术产品。

【常见 ASR 误识别映射】
- "give ME"、"give me 3"、"give ME3"、"Kimi 三"、"基米三"、"基米尼"、"杰米尼" → Gemini
- "Deep sick"、"deep seek"、"地普西克" → DeepSeek
- "chat GDP"、"Chat GDP" → ChatGPT
- "克劳德"、"科劳德" → Claude
- "padle"、"Padle" → Paddle
- "OCR杠"、"VL杠" → OCR-、VL-
- "paddleocr" → PaddleOCR
- "谷歌的" → Google（在讨论产品语境中）

【纠错规则】
1. 识别出上述谐音/拼写错误，替换为正确的产品名
2. 保持版本号不变（如 1.5、3.0）
3. 保持原有标点符号
4. 如果无法确定是否为误识别，保持原文

直接输出纠正后的文本，不要解释，不要加引号。

输入：{text}
输出："""


class LLMCorrector:
    """DeepSeek Chat 纠错器"""
    
    def __init__(
        self,
        api_key: Optional[str] = None,
        api_base: str = "https://api.deepseek.com",
        model: str = "deepseek-chat",
        request_timeout_sec: float = 3.0,
        max_output_tokens: int = 96,
    ):
        self.api_key = api_key or os.getenv("DEEPSEEK_API_KEY", "")
        self.api_base = api_base
        self.model = model
        self._request_timeout_sec = max(0.5, request_timeout_sec)
        self._max_output_tokens = max(48, max_output_tokens)
        self._client: Optional[httpx.AsyncClient] = None
    
    async def correct(self, text: str) -> Tuple[str, Optional[str]]:
        """
        纠错 ASR 识别结果
        
        Args:
            text: ASR 识别的原始文本
            
        Returns:
            (纠错后文本, 调试信息)
        """
        if not text or not text.strip() or not self.api_key:
            return text, None
        
        prompt = CORRECTION_PROMPT.format(text=text)
        
        try:
            if not self._client:
                self._client = httpx.AsyncClient(timeout=self._request_timeout_sec)
            estimated_tokens = int(len(text) * 1.8) + 24
            max_tokens = min(max(estimated_tokens, 48), self._max_output_tokens)
            
            response = await self._client.post(
                f"{self.api_base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.1,  # 低温度，更确定性的输出
                    "max_tokens": max_tokens,
                },
            )
            
            if response.status_code == 200:
                result = response.json()
                message = result["choices"][0]["message"]
                corrected = message.get("content", "").strip()
                
                # 清理可能的引号包裹
                if corrected.startswith('"') and corrected.endswith('"'):
                    corrected = corrected[1:-1]
                if corrected.startswith("'") and corrected.endswith("'"):
                    corrected = corrected[1:-1]
                
                if corrected and corrected != text:
                    print(f"[LLM纠错] '{text}' → '{corrected}'")
                    return corrected, "corrected"
                else:
                    print(f"[LLM纠错] 无变化: '{text}'")
                    return text, None
            else:
                print(f"[LLMCorrector] API 调用失败: {response.status_code} - {response.text}")
                return text, None
                
        except Exception as e:
            print(f"[LLMCorrector] 纠错失败: {e}")
            return text, None
    
    async def close(self):
        """关闭客户端"""
        if self._client:
            await self._client.aclose()
            self._client = None
