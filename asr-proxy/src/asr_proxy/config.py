"""
配置管理模块

配置优先级：环境变量 > .env 文件 > 代码默认值
所有配置统一在 .env 文件中设置，代码默认值仅作为兜底
"""

from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict


LEGACY_VOLC_RESOURCE_ID_MAP = {
    # 1.0 -> 2.0（流式按时长计费）
    "volc.bigasr.sauc.duration": "volc.seedasr.sauc.duration",
    # 1.0 -> 2.0（流式按并发计费）
    "volc.bigasr.sauc.concurrent": "volc.seedasr.sauc.concurrent",
    # 1.0 -> 2.0（录音文件版）
    "volc.bigasr.auc": "volc.seedasr.auc",
}
DEFAULT_VOLC_RESOURCE_ID = "volc.seedasr.sauc.duration"


class Settings(BaseSettings):
    """应用配置"""
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )
    
    # 火山引擎凭证
    volc_app_id: str = ""
    volc_access_token: str = ""
    volc_resource_id: str = DEFAULT_VOLC_RESOURCE_ID
    
    # 火山引擎 ASR 服务地址（Doubao-Seed-ASR-2.0，优化版双向流式模式）
    volc_asr_url: str = "wss://openspeech.bytedance.com"
    volc_asr_uri: str = "/api/v3/sauc/bigmodel_async"
    
    # 腾讯云凭证
    tencent_appid: str = ""
    tencent_secret_id: str = ""
    tencent_secret_key: str = ""
    tencent_engine_type: str = "16k_zh"
    
    # ASR 提供商
    asr_provider: Literal["mock", "volcengine", "tencent"] = "mock"
    
    # WebSocket 服务配置
    ws_host: str = "0.0.0.0"
    ws_port: int = 8765
    
    # 重连配置
    max_reconnect: int = 3
    
    # 日志级别
    log_level: str = "INFO"
    
    # LLM 纠错提供商（doubao / deepseek）
    llm_provider: Literal["doubao", "deepseek"] = "doubao"
    enable_llm_correction: bool = True  # 默认开启 LLM 纠错
    llm_fast_mode: bool = True  # 速度优先模式：更短 prompt、更少上下文
    llm_correction_timeout_sec: float = 5.0
    llm_min_text_len: int = 5
    llm_max_pending_tasks: int = 4
    llm_max_context_items: int = 2
    llm_few_shot_count: int = 2
    llm_max_output_tokens: int = 150

    # 滑动窗口批量纠错配置
    llm_batch_window_size: int = 2       # 累积多少个 final block 后触发批量纠错
    llm_batch_flush_delay_sec: float = 1.5  # 最后一个 final 后等待多久强制触发（秒）
    llm_batch_max_output_tokens: int = 512  # 批量纠错时的最大输出 token
    llm_streaming_mode: bool = False  # 流式输出模式（实验性，暂未启用）

    # 两阶段检测配置（先检测是否需要纠错，再执行纠错）
    enable_llm_detection: bool = True     # 是否启用检测阶段（关闭则所有文本都走纠错）
    llm_detection_timeout_sec: float = 1.0  # 检测阶段超时（秒），应远小于纠错超时
    
    # 豆包大模型配置（火山方舟）
    ark_api_key: str = ""  # 火山方舟 API Key
    ark_endpoint_id: str = ""  # 推理接入点 ID（ep-xxx 格式）
    
    # DeepSeek 纠错配置（备选）
    deepseek_api_key: str = ""
    deepseek_api_base: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"

    # 语义分段配置
    enable_semantic_segmentation: bool = True  # 是否启用语义分段
    semantic_min_segment_length: int = 5  # 最小段落长度（字符数）
    semantic_max_segment_length: int = 150  # 最大段落长度（字符数）
    semantic_confidence_threshold: float = 0.7  # 分段置信度阈值
    semantic_enable_bert: bool = False  # 是否启用 BERT 模型（需要额外依赖）

    @property
    def volc_ws_url(self) -> str:
        """完整的火山 ASR WebSocket 地址"""
        return f"{self.volc_asr_url}{self.volc_asr_uri}"

    @property
    def volc_effective_resource_id(self) -> str:
        """
        火山引擎请求头中最终使用的 Resource ID。

        - 空值时默认使用 Doubao-Seed-ASR-2.0（按时长）
        - 旧版 bigasr 自动映射到 seedasr
        """
        resource_id = self.volc_resource_id.strip()
        if not resource_id:
            return DEFAULT_VOLC_RESOURCE_ID
        return LEGACY_VOLC_RESOURCE_ID_MAP.get(resource_id, resource_id)

    @property
    def has_legacy_volc_resource_id(self) -> bool:
        """是否配置了旧版 1.0 的 Resource ID。"""
        return self.volc_resource_id.strip() in LEGACY_VOLC_RESOURCE_ID_MAP
    
    def validate_volcengine_config(self) -> bool:
        """验证火山引擎配置是否完整"""
        return all([
            self.volc_app_id,
            self.volc_access_token,
            self.volc_effective_resource_id,
        ])
    
    def validate_tencent_config(self) -> bool:
        """验证腾讯云配置是否完整"""
        return all([
            self.tencent_appid,
            self.tencent_secret_id,
            self.tencent_secret_key,
        ])


# 全局配置单例
settings = Settings()
