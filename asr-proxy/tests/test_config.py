"""
Config 单元测试
验证 Doubao-Seed-ASR-2.0 资源 ID 默认值和旧版兼容映射
"""

from asr_proxy.config import (
    DEFAULT_VOLC_RESOURCE_ID,
    Settings,
)


class TestVolcResourceId:
    """测试火山 Resource ID 映射逻辑"""

    def test_default_resource_id_is_seed_asr_2(self):
        """未配置时默认使用 Seed-ASR-2.0"""
        cfg = Settings(_env_file=None, volc_app_id="app", volc_access_token="token")
        assert cfg.volc_effective_resource_id == DEFAULT_VOLC_RESOURCE_ID

    def test_legacy_duration_resource_id_is_mapped(self):
        """旧版按时长 resource id 会自动迁移"""
        cfg = Settings(
            _env_file=None,
            volc_app_id="app",
            volc_access_token="token",
            volc_resource_id="volc.bigasr.sauc.duration",
        )
        assert cfg.has_legacy_volc_resource_id is True
        assert cfg.volc_effective_resource_id == "volc.seedasr.sauc.duration"

    def test_legacy_concurrent_resource_id_is_mapped(self):
        """旧版按并发 resource id 会自动迁移"""
        cfg = Settings(
            _env_file=None,
            volc_app_id="app",
            volc_access_token="token",
            volc_resource_id="volc.bigasr.sauc.concurrent",
        )
        assert cfg.volc_effective_resource_id == "volc.seedasr.sauc.concurrent"

    def test_seed_resource_id_kept(self):
        """已是新版 resource id 时保持不变"""
        cfg = Settings(
            _env_file=None,
            volc_app_id="app",
            volc_access_token="token",
            volc_resource_id="volc.seedasr.sauc.duration",
        )
        assert cfg.has_legacy_volc_resource_id is False
        assert cfg.volc_effective_resource_id == "volc.seedasr.sauc.duration"

    def test_validate_volcengine_config_uses_effective_resource_id(self):
        """验证火山配置完整性时使用有效 resource id"""
        cfg = Settings(_env_file=None, volc_app_id="app", volc_access_token="token")
        assert cfg.validate_volcengine_config() is True
