import React, { useState, useEffect, useCallback } from 'react';
import { Settings, DEFAULT_SETTINGS, ERROR_MESSAGES } from '../types';
import { getSettings, saveSettings, clampMaxImages } from '../utils/storage';
import { testConnection } from '../services/api';
import { Settings as SettingsIcon, Key, Eye, EyeOff, Check, X, RefreshCw, ExternalLink, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';

const Options: React.FC = () => {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [originalSettings, setOriginalSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    noteUrl?: string;
    error?: string;
  } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    const changed = JSON.stringify(settings) !== JSON.stringify(originalSettings);
    setHasChanges(changed);
  }, [settings, originalSettings]);

  // Clear test result when API Key is empty
  useEffect(() => {
    if (!settings.apiKey.trim()) {
      setTestResult(null);
    }
  }, [settings.apiKey]);

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const loaded = await getSettings();
      setSettings(loaded);
      setOriginalSettings(loaded);

      // Initialize testResult from saved test status ONLY if API Key exists
      if (loaded.apiKey.trim() && loaded.lastTestStatus === 'success' && loaded.lastTestNoteUrl) {
        setTestResult({
          success: true,
          noteUrl: loaded.lastTestNoteUrl,
        });
      } else if (loaded.apiKey.trim() && loaded.lastTestStatus === 'failed' && loaded.lastTestError) {
        setTestResult({
          success: false,
          error: loaded.lastTestError,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // If API Key is cleared, reset test status as well
      let settingsToSave = settings;
      if (!settings.apiKey.trim()) {
        settingsToSave = {
          ...settings,
          lastTestStatus: null,
          lastTestAt: null,
          lastTestNoteUrl: null,
          lastTestError: null,
        };
        // Also clear local testResult state
        setTestResult(null);
      }
      await saveSettings(settingsToSave);
      setOriginalSettings(settingsToSave);
      setSettings(settingsToSave);
      setHasChanges(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const handleTestConnection = async () => {
    if (!settings.apiKey.trim()) {
      setTestResult({ success: false, error: '请先输入 API Key' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await testConnection(settings.apiKey);
      if (result.success) {
        setTestResult({
          success: true,
          noteUrl: result.noteUrl,
        });
        // Update last test info
        const updatedSettings = {
          ...settings,
          lastTestStatus: 'success' as const,
          lastTestAt: new Date().toISOString(),
          lastTestNoteUrl: result.noteUrl,
          lastTestError: null,
        };
        setSettings(updatedSettings);
        await saveSettings(updatedSettings);
        setOriginalSettings(updatedSettings);
      } else {
        const errorMessage = ERROR_MESSAGES[result.errorCode || 'UNKNOWN'] || result.error || '测试失败';
        setTestResult({
          success: false,
          error: errorMessage,
        });
        // Update last test info
        const updatedSettings = {
          ...settings,
          lastTestStatus: 'failed' as const,
          lastTestAt: new Date().toISOString(),
          lastTestNoteUrl: null,
          lastTestError: errorMessage,
        };
        setSettings(updatedSettings);
        await saveSettings(updatedSettings);
        setOriginalSettings(updatedSettings);
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: '测试失败，请检查网络连接',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleMaxImagesChange = useCallback((value: string) => {
    const num = parseInt(value, 10);
    setSettings(prev => ({
      ...prev,
      maxImages: clampMaxImages(isNaN(num) ? 0 : num),
    }));
  }, []);

  if (isLoading) {
    return (
      <div className="options-container flex items-center justify-center min-h-screen">
        <div className="animate-spin text-brand-primary">
          <RefreshCw size={32} />
        </div>
      </div>
    );
  }

  return (
    <div className="options-container py-8 px-4 md:px-6">
      <div className="max-w-[860px] mx-auto space-y-4">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <SettingsIcon className="text-brand-primary" size={28} />
            <h1 className="text-2xl font-semibold text-text-primary">墨问笔记助手 - 设置</h1>
          </div>
          <p className="text-text-secondary text-sm">配置 API Key 与默认参数</p>
        </div>

        {/* Card 1: API Configuration */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Key className="text-brand-primary" size={20} />
            <h2 className="text-base font-semibold text-text-primary">API 配置</h2>
          </div>

          <div className="space-y-4">
            {/* API Key Input */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                API Key
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  className="input pr-12"
                  placeholder="请输入您的墨问 API Key"
                  value={settings.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              <p className="text-xs text-text-secondary mt-2">
                在墨问设置中获取 API Key。
                <a
                  href="https://mowen.cn/settings/api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-primary hover:underline ml-1"
                >
                  获取 API Key
                </a>
              </p>
            </div>

            {/* Test Connection */}
            <div className="flex items-center gap-3">
              <button
                className="btn-secondary flex items-center gap-2"
                onClick={handleTestConnection}
                disabled={isTesting || !settings.apiKey.trim()}
              >
                {isTesting ? (
                  <RefreshCw size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                {isTesting ? '测试中...' : '测试连接'}
              </button>
            </div>

            {/* Test Result */}
            {testResult && (
              <div
                className={`p-4 rounded-button ${testResult.success
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
                  }`}
              >
                <div className="flex items-start gap-2">
                  {testResult.success ? (
                    <Check className="text-green-600 mt-0.5" size={18} />
                  ) : (
                    <X className="text-red-600 mt-0.5" size={18} />
                  )}
                  <div>
                    <p className={`text-sm font-medium ${testResult.success ? 'text-green-800' : 'text-red-800'}`}>
                      {testResult.success ? '连接成功，已创建测试笔记。' : testResult.error}
                    </p>
                    {testResult.success && testResult.noteUrl && (
                      <a
                        href={testResult.noteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline mt-1"
                      >
                        打开测试笔记 <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Last Test Info */}
            {settings.lastTestAt && !testResult && (
              <div className="text-xs text-text-secondary">
                上次测试：{new Date(settings.lastTestAt).toLocaleString()}
                {settings.lastTestStatus === 'success' ? (
                  <span className="text-green-600 ml-2">成功</span>
                ) : (
                  <span className="text-red-600 ml-2">失败</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Card 2: Default Settings */}
        <div className="card p-5">
          <h2 className="text-base font-semibold text-text-primary mb-4">默认设置</h2>

          <div className="space-y-5">
            {/* Default Public */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">默认笔记权限</p>
                <p className="text-xs text-text-secondary mt-0.5">新建笔记时的默认可见性</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-secondary">
                  {settings.defaultPublic ? '公开' : '私密'}
                </span>
                <button
                  className={`switch ${settings.defaultPublic ? 'switch-on' : 'switch-off'}`}
                  onClick={() => setSettings({ ...settings, defaultPublic: !settings.defaultPublic })}
                >
                  <span
                    className={`switch-thumb ${settings.defaultPublic ? 'translate-x-5' : 'translate-x-1'}`}
                  />
                </button>
              </div>
            </div>

            {/* Default Include Images */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">默认包含图片</p>
                <p className="text-xs text-text-secondary mt-0.5">剪藏时是否抓取图片</p>
              </div>
              <button
                className={`switch ${settings.defaultIncludeImages ? 'switch-on' : 'switch-off'}`}
                onClick={() => setSettings({ ...settings, defaultIncludeImages: !settings.defaultIncludeImages })}
              >
                <span
                  className={`switch-thumb ${settings.defaultIncludeImages ? 'translate-x-5' : 'translate-x-1'}`}
                />
              </button>
            </div>

            {/* Max Images */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">最大图片数量</p>
                <p className="text-xs text-text-secondary mt-0.5">超出数量的图片将转为链接（0-200）</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="w-8 h-8 rounded-button border border-border-default flex items-center justify-center hover:bg-gray-50"
                  onClick={() => handleMaxImagesChange(String(settings.maxImages - 1))}
                  disabled={settings.maxImages <= 0}
                >
                  -
                </button>
                <input
                  type="number"
                  className="w-16 text-center input py-1.5"
                  value={settings.maxImages}
                  onChange={(e) => handleMaxImagesChange(e.target.value)}
                  min={0}
                  max={200}
                />
                <button
                  className="w-8 h-8 rounded-button border border-border-default flex items-center justify-center hover:bg-gray-50"
                  onClick={() => handleMaxImagesChange(String(settings.maxImages + 1))}
                  disabled={settings.maxImages >= 200}
                >
                  +
                </button>
              </div>
            </div>

            {/* Create Index Note */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">创建索引笔记</p>
                <p className="text-xs text-text-secondary mt-0.5">长文拆分时创建包含所有分篇链接的索引</p>
              </div>
              <button
                className={`switch ${settings.createIndexNote ? 'switch-on' : 'switch-off'}`}
                onClick={() => setSettings({ ...settings, createIndexNote: !settings.createIndexNote })}
              >
                <span
                  className={`switch-thumb ${settings.createIndexNote ? 'translate-x-5' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Card 3: Advanced Settings (Collapsible) */}
        <div className="card">
          <button
            className="w-full p-5 flex items-center justify-between text-left"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <h2 className="text-base font-semibold text-text-primary">高级设置</h2>
            {showAdvanced ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>

          {showAdvanced && (
            <div className="px-5 pb-5 pt-0 border-t border-border-default">
              <div className="pt-4">
                {/* Debug Mode */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">调试模式</p>
                    <p className="text-xs text-text-secondary mt-0.5">在控制台输出详细日志</p>
                  </div>
                  <button
                    className={`switch ${settings.debugMode ? 'switch-on' : 'switch-off'}`}
                    onClick={() => setSettings({ ...settings, debugMode: !settings.debugMode })}
                  >
                    <span
                      className={`switch-thumb ${settings.debugMode ? 'translate-x-5' : 'translate-x-1'}`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sticky Footer */}
        <div className="sticky bottom-0 bg-bg-default py-4 border-t border-border-default -mx-4 px-4 md:-mx-6 md:px-6">
          <div className="max-w-[860px] mx-auto flex items-center justify-between gap-4">
            <button
              className="btn-secondary flex items-center gap-2"
              onClick={handleReset}
            >
              <RotateCcw size={16} />
              恢复默认
            </button>
            <button
              className="btn-primary flex items-center gap-2"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                <Check size={16} />
              )}
              {isSaving ? '保存中...' : '保存设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Options;
