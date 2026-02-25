"""
热词管理模块
管理 ASR 热词表，提升专业术语识别准确率
"""

from typing import List

# 基础热词包：覆盖 AI/科技 + 日常交流沟通 场景
DEFAULT_HOTWORDS = [
    # ========== AI/科技相关 ==========
    "ChatGPT", "GPT", "Claude", "OpenAI", "LLM", "AI", "API", "SDK",
    "人工智能", "大语言模型", "神经网络", "机器学习", "深度学习",
    "DeepSeek", "Gemini", "Copilot", "Midjourney", "Stable Diffusion",
    
    # ========== 互联网产品 ==========
    "App", "iPhone", "Android", "iOS", "WiFi", "PDF", "URL",
    "微信", "抖音", "小红书", "B站", "淘宝", "支付宝", "美团",
    "飞书", "钉钉", "企业微信", "Notion", "Figma", "Slack",
    
    # ========== 编程相关 ==========
    "Python", "JavaScript", "TypeScript", "React", "Vue", "Next.js",
    "Docker", "K8S", "Kubernetes", "GitHub", "GitLab", "npm", "yarn",
    "WebSocket", "MCP", "Typeless", "墨问",
    "coding", "code", "debug", "deploy", "commit", "merge",
    
    # ========== 商业/职场术语 ==========
    "OKR", "KPI", "ROI", "GMV", "DAU", "MAU", "MVP", "PMF",
    "产品经理", "用户体验", "商业模式", "融资", "估值",
    "复盘", "对齐", "拉通", "赋能", "抓手", "颗粒度",
    
    # ========== 日常交流/沟通 ==========
    "的确", "已经", "以后", "一起", "其实", "然后",
    "那个", "这个", "怎么", "什么", "为什么", "可能",
    "应该", "需要", "希望", "觉得", "认为", "感觉",
    
    # ========== 常见易错同音词 ==========
    "人工智能",  # vs 人工只能
    "增长",      # vs 增涨
    "反应",      # vs 反映（根据语境）
    "权利",      # vs 权力（根据语境）
    
    # ========== 常见缩写 ==========
    "BTW", "ASAP", "FYI", "YYDS", "XSWL", "LGTM", "WFH",
]


class HotwordManager:
    """热词管理器"""
    
    def __init__(self):
        self._user_hotwords: List[str] = []
        self._history_hotwords: List[str] = []
    
    def get_hotwords(self) -> List[str]:
        """获取完整热词列表（去重）"""
        all_words = DEFAULT_HOTWORDS + self._user_hotwords + self._history_hotwords
        return list(set(all_words))
    
    def add_user_hotword(self, word: str):
        """添加用户自定义热词"""
        if word and word not in self._user_hotwords:
            self._user_hotwords.append(word)
    
    def add_history_hotwords(self, words: List[str]):
        """从历史笔记中添加热词"""
        self._history_hotwords.extend(words)
        self._history_hotwords = list(set(self._history_hotwords))


# 全局热词管理器
hotword_manager = HotwordManager()
