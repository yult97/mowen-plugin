import type { ChangeEvent, DragEvent, FormEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  Upload,
} from 'lucide-react';

import {
  DEFAULT_SETTINGS,
  MarkdownImportResult,
  NoteCreateResult,
  SaveProgress,
  Settings as SettingsType,
} from '../types';
import { convertMarkdownImport } from '../utils/markdownImport';
import { renderMarkdownPreviewBodyHtml } from '../utils/markdownPreview';
import {
  buildMowenPreviewBodyHtml,
  buildEditedPreviewExtractResult,
  hasEditablePreviewContent,
} from '../utils/mdImportPreviewEdit';
import {
  cancelMdImportTask,
  clearMdImportTask,
  getMdImportTabId,
  pauseMdImportTask,
  restoreMdImportTask,
  resumeMdImportTask,
  startMdImportSave,
  subscribeMdImportTask,
} from '../utils/mdImportSaveClient';
import {
  createInitialSaveProgress,
  getSaveProgressVisualState,
  normalizeSaveProgress,
} from '../utils/saveProgressView';
import { getSettings } from '../utils/storage';

type ParseState = 'empty' | 'reading' | 'parsing' | 'ready' | 'failed';
type SaveState = 'idle' | 'saving' | 'paused' | 'success' | 'failed';
type PreviewMode = 'preview' | 'markdown';

const ACCEPTED_EXTENSIONS = '.md,.markdown';
const PRIMARY_ACTION_BUTTON_CLASS = 'inline-flex h-10 items-center justify-center gap-2 rounded-[16px] bg-brand-primary px-4 text-sm font-medium text-text-on-brand transition-colors hover:bg-brand-hover active:bg-brand-active focus:outline-none focus:ring-2 focus:ring-brand-focus disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_ACTION_BUTTON_CLASS = 'inline-flex h-10 items-center justify-center gap-2 rounded-[16px] border border-brand-primary/85 bg-white px-4 text-sm font-medium text-brand-primary transition-colors hover:bg-brand-soft active:bg-brand-focus focus:outline-none focus:ring-2 focus:ring-brand-focus disabled:cursor-not-allowed disabled:opacity-50';
const PANEL_BODY_MAX_HEIGHT_CLASS = 'xl:max-h-[min(720px,calc(100vh-300px))]';
const ACCEPTED_FILE_PATTERN = /\.(md|markdown)$/i;

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function MdImportPage(): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSubscriptionRef = useRef<(() => void) | null>(null);
  const previewCurrentHtmlRef = useRef('');

  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [markdown, setMarkdown] = useState('');
  const [fileName, setFileName] = useState('');
  const [importedFileMeta, setImportedFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [parseState, setParseState] = useState<ParseState>('empty');
  const [parseError, setParseError] = useState('');
  const [importResult, setImportResult] = useState<MarkdownImportResult | null>(null);
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('preview');
  const [previewDraftHtml, setPreviewDraftHtml] = useState('');
  const [previewDraftVersion, setPreviewDraftVersion] = useState(0);
  const [isPreviewEdited, setIsPreviewEdited] = useState(false);
  const [previewHasContent, setPreviewHasContent] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveProgress, setSaveProgress] = useState<SaveProgress>({ status: 'idle' });
  const [saveResult, setSaveResult] = useState<NoteCreateResult | null>(null);
  const [saveTask, setSaveTask] = useState<{ tabId: number; taskId: string } | null>(null);
  const [actionError, setActionError] = useState('');

  const deferredMarkdown = useDeferredValue(markdown);
  const isTaskActive = saveState === 'saving' || saveState === 'paused';

  const attachTaskSubscription = (tabId: number, taskId: string) => {
    activeSubscriptionRef.current?.();
    activeSubscriptionRef.current = subscribeMdImportTask(tabId, taskId, {
      onProgress: (progress) => {
        setActionError('');
        setSaveState(progress.status === 'paused' ? 'paused' : 'saving');
        setSaveProgress(progress);
      },
      onPaused: () => {
        setActionError('');
        setSaveState('paused');
        setSaveProgress((current) => ({ ...current, status: 'paused' }));
      },
      onResumed: () => {
        setActionError('');
        setSaveState('saving');
        setSaveProgress((current) => normalizeSaveProgress({
          ...current,
          status: current.totalImages && (current.uploadedImages || 0) < current.totalImages
            ? 'uploading_images'
            : 'creating_note',
        }));
      },
      onComplete: (result) => {
        setActionError('');
        setSaveResult(result);
        setSaveTask(null);
        setSaveState(result.success ? 'success' : 'failed');
        setSaveProgress(result.success
          ? { status: 'success', notes: result.notes }
          : { status: 'failed', error: result.error, errorCode: result.errorCode });
        activeSubscriptionRef.current?.();
        activeSubscriptionRef.current = null;
      },
    });
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const loaded = await getSettings();
        if (active) {
          setSettings(loaded);
        }
      } finally {
        if (active) {
          setLoadingSettings(false);
        }
      }

      try {
        const tabId = await getMdImportTabId();
        const restored = await restoreMdImportTask(tabId);
        if (!active || !restored) {
          return;
        }

        setSaveTask({ tabId: restored.tabId, taskId: restored.taskId });
        if (restored.status === 'processing') {
          setSaveState('saving');
          setSaveProgress(restored.progress ? normalizeSaveProgress(restored.progress) : { status: 'creating_note' });
          attachTaskSubscription(restored.tabId, restored.taskId);
          return;
        }

        if (restored.status === 'paused') {
          setSaveState('paused');
          setSaveProgress(restored.progress ? normalizeSaveProgress(restored.progress) : { status: 'paused' });
          attachTaskSubscription(restored.tabId, restored.taskId);
          return;
        }

        if (restored.status === 'success') {
          setSaveState('success');
          setSaveResult(restored.result as NoteCreateResult);
          setSaveProgress({
            status: 'success',
            notes: restored.result?.notes,
          });
          setSaveTask(null);
          return;
        }

        if (restored.status === 'failed') {
          setSaveState('failed');
          setSaveResult(restored.result as NoteCreateResult);
          setSaveProgress({
            status: 'failed',
            error: restored.result?.error,
            errorCode: restored.result?.errorCode,
          });
          setSaveTask(null);
        }
      } catch {
        // Ignore restore failures on first render.
      }
    };

    void load();

    return () => {
      active = false;
      activeSubscriptionRef.current?.();
      activeSubscriptionRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!deferredMarkdown.trim()) {
      setParseState('empty');
      setParseError('');
      setImportResult(null);
      return;
    }

    setParseState((current) => (current === 'reading' ? current : 'parsing'));
    setParseError('');

    const timer = window.setTimeout(() => {
      void convertMarkdownImport({
        markdown: deferredMarkdown,
        fileName,
        includeImages: settings.defaultIncludeImages,
        maxImages: settings.maxImages,
      }).then((result) => {
        if (cancelled) return;

        startTransition(() => {
          setImportResult(result);
          setParseState('ready');
        });
      }).catch((error) => {
        if (cancelled) return;

        setParseState('failed');
        setImportResult(null);
        setParseError(error instanceof Error ? error.message : 'Markdown 解析失败');
      });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferredMarkdown, fileName, settings.defaultIncludeImages, settings.maxImages]);

  const effectiveTitle = importResult?.editableTitle?.trim() || '';
  const generatedPreviewSourceHtml = useMemo(() => {
    if (!importResult) {
      return '';
    }

    return renderMarkdownPreviewBodyHtml(importResult.previewModel.blocks);
  }, [importResult]);
  const generatedPreviewBodyHtml = useMemo(() => (
    generatedPreviewSourceHtml ? buildMowenPreviewBodyHtml(generatedPreviewSourceHtml) : ''
  ), [generatedPreviewSourceHtml]);

  useEffect(() => {
    previewCurrentHtmlRef.current = generatedPreviewBodyHtml;
    setPreviewDraftHtml(generatedPreviewBodyHtml);
    setPreviewHasContent(hasEditablePreviewContent(generatedPreviewBodyHtml));
    setIsPreviewEdited(false);
    setPreviewDraftVersion((current) => current + 1);
  }, [generatedPreviewBodyHtml]);

  const saveBlockedReason = useMemo(() => {
    if (!settings.apiKey) {
      return '未检测到 API Key，请先到设置页完成配置。';
    }
    if (!importResult || !markdown.trim()) {
      return '请先选择文件或粘贴 Markdown 内容。';
    }
    if (!effectiveTitle) {
      return '标题不能为空。';
    }
    if (importResult && !previewHasContent) {
      return '预览内容不能为空。';
    }
    return '';
  }, [effectiveTitle, importResult, markdown, previewHasContent, settings.apiKey]);

  const notes = saveResult?.notes || [];
  const primarySavedNote = notes.find((note) => note.isIndex) || notes[0] || null;
  const saveProgressView = getSaveProgressVisualState(saveProgress);
  const saveProgressSummary = saveProgressView.phaseDetail
    ? `${saveProgressView.phaseLabel} ${saveProgressView.phaseDetail}`
    : saveProgressView.phaseLabel;
  const currentStep = saveState === 'success'
    ? 3
    : saveState === 'saving' || saveState === 'paused'
      ? 3
      : importResult
        ? 2
        : 1;
  const visibleFile = importedFileMeta;

  useEffect(() => {
    if (!isEditorExpanded) {
      return;
    }

    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isEditorExpanded]);

  const openSettings = () => {
    chrome.runtime.openOptionsPage();
  };

  const clearSaveState = () => {
    setSaveState('idle');
    setSaveProgress({ status: 'idle' });
    setSaveResult(null);
    setSaveTask(null);
    setActionError('');
    activeSubscriptionRef.current?.();
    activeSubscriptionRef.current = null;
  };

  const clearWorkspace = () => {
    if (isTaskActive) {
      return;
    }

    setMarkdown('');
    setFileName('');
    setImportedFileMeta(null);
    setUploadError('');
    setParseState('empty');
    setParseError('');
    setImportResult(null);
    setIsEditorExpanded(false);
    setPreviewMode('preview');
    previewCurrentHtmlRef.current = '';
    setPreviewDraftHtml('');
    setPreviewHasContent(false);
    setIsPreviewEdited(false);
    setPreviewDraftVersion((current) => current + 1);
    clearSaveState();
  };

  const applyFile = async (file: File) => {
    if (isTaskActive) {
      return;
    }

    setUploadError('');

    if (!ACCEPTED_FILE_PATTERN.test(file.name)) {
      setIsDragOver(false);
      setUploadError('仅支持 .md / .markdown 文件');
      return;
    }

    try {
      clearSaveState();
      setParseState('reading');
      setParseError('');
      setUploadError('');
      setFileName(file.name);
      setImportedFileMeta({
        name: file.name,
        size: file.size,
      });

      const content = await file.text();
      setMarkdown(content);
      setIsDragOver(false);
    } catch (error) {
      setFileName('');
      setImportedFileMeta(null);
      setIsDragOver(false);
      setUploadError(error instanceof Error ? error.message : '文件读取失败');
    }
  };

  const handleRemoveSelectedFile = () => {
    if (isTaskActive) {
      return;
    }

    clearWorkspace();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await applyFile(file);
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);

    if (isTaskActive) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }

    await applyFile(file);
  };

  const handleToggleEditor = () => {
    setIsEditorExpanded((current) => !current);
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleStartSave();
    }
  };

  const normalizePreviewDraft = (html: string) => {
    const normalizedHtml = buildMowenPreviewBodyHtml(html);
    previewCurrentHtmlRef.current = normalizedHtml;
    setPreviewHasContent(hasEditablePreviewContent(normalizedHtml));
    setIsPreviewEdited(normalizedHtml !== generatedPreviewBodyHtml);
    clearSaveState();
    return normalizedHtml;
  };

  const handlePreviewInput = (event: FormEvent<HTMLDivElement>) => {
    const currentHtml = event.currentTarget.innerHTML;
    previewCurrentHtmlRef.current = currentHtml;
    setPreviewHasContent(hasEditablePreviewContent(currentHtml));
    setIsPreviewEdited(currentHtml !== generatedPreviewBodyHtml);
    clearSaveState();
  };

  const handlePreviewBlur = (event: FormEvent<HTMLDivElement>) => {
    const normalizedHtml = normalizePreviewDraft(event.currentTarget.innerHTML);
    if (event.currentTarget.innerHTML !== normalizedHtml) {
      event.currentTarget.innerHTML = normalizedHtml;
    }
  };

  const handlePreviewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleStartSave();
    }
  };

  const resetPreviewEdits = () => {
    previewCurrentHtmlRef.current = generatedPreviewBodyHtml;
    setPreviewDraftHtml(generatedPreviewBodyHtml);
    setPreviewHasContent(hasEditablePreviewContent(generatedPreviewBodyHtml));
    setIsPreviewEdited(false);
    setPreviewDraftVersion((current) => current + 1);
    clearSaveState();
  };

  const handleStartSave = async () => {
    if (!importResult || saveBlockedReason || isTaskActive) {
      return;
    }

    setActionError('');

    try {
      const extractResult = !isPreviewEdited
        ? {
          ...importResult.extractResult,
          title: effectiveTitle,
        }
        : buildEditedPreviewExtractResult({
          extractResult: importResult.extractResult,
          title: effectiveTitle,
          html: previewCurrentHtmlRef.current || previewDraftHtml || generatedPreviewBodyHtml,
          baselineHtml: generatedPreviewBodyHtml,
        });

      const task = await startMdImportSave({
        extractResult,
        isPublic: settings.defaultPublic,
        includeImages: settings.defaultIncludeImages,
        maxImages: settings.maxImages,
        createIndexNote: settings.createIndexNote,
        enableAutoTag: settings.enableAutoTag,
      });

      setSaveTask(task);
      setSaveState('saving');
      setSaveResult(null);
      setSaveProgress(createInitialSaveProgress(extractResult, {
        includeImages: settings.defaultIncludeImages,
        maxImages: settings.maxImages,
      }));
      attachTaskSubscription(task.tabId, task.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存请求发送失败';
      setActionError(message);
      setSaveState('failed');
      setSaveResult({ success: false, error: message });
      setSaveProgress({ status: 'failed', error: message });
    }
  };

  const handlePauseResume = async () => {
    if (!saveTask) {
      return;
    }

    setActionError('');

    try {
      if (saveState === 'paused') {
        await resumeMdImportTask(saveTask.tabId, saveTask.taskId);
        setSaveState('saving');
        return;
      }

      await pauseMdImportTask(saveTask.tabId, saveTask.taskId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '任务状态切换失败');
    }
  };

  const handleCancelSave = async () => {
    if (!saveTask) {
      return;
    }

    setActionError('');

    try {
      await cancelMdImportTask(saveTask.tabId, saveTask.taskId);
      await clearMdImportTask(saveTask.tabId, saveTask.taskId);
      clearSaveState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '取消任务失败');
    }
  };

  const showPreviewEmptyState = !importResult || !generatedPreviewBodyHtml;
  const showRawMarkdown = previewMode === 'markdown';
  const saveButtonDisabled = Boolean(saveBlockedReason) || isTaskActive || parseState === 'reading' || parseState === 'parsing';
  const showSavePanel = Boolean(importResult) || isTaskActive || saveState === 'success' || saveState === 'failed';
  const savePolicySummary = loadingSettings
    ? '正在读取默认保存策略…'
    : `沿用插件默认设置 · ${settings.defaultPublic ? '公开' : '私密'} · ${settings.defaultIncludeImages ? '含图' : '无图'}${settings.createIndexNote ? ' · 长文合集' : ''}`;

  return (
    <div className="options-container min-h-screen">
      <div className="mx-auto max-w-[1240px] px-4 py-5 md:px-8 md:py-7">
        <section className="rounded-[22px] border border-white/80 bg-white/94 px-5 py-4 shadow-[0_16px_42px_rgba(134,89,52,0.08)] md:px-7 md:py-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-text-primary md:text-[30px]">
                Markdown 一键导入到墨问
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2 md:gap-3">
              <FlowStep
                index={1}
                label="导入"
                state={currentStep > 1 ? 'complete' : currentStep === 1 ? 'current' : 'upcoming'}
              />
              <FlowStep
                index={2}
                label="检查"
                state={currentStep > 2 ? 'complete' : currentStep === 2 ? 'current' : 'upcoming'}
              />
              <FlowStep
                index={3}
                label="保存"
                state={currentStep === 3 ? 'current' : 'upcoming'}
              />
            </div>

            <div className="flex items-center gap-2 self-start xl:self-auto">
              <div className="hidden rounded-full border border-[#E9DED3] bg-[#FCF8F3] px-3 py-1.5 text-[12px] text-text-secondary md:inline-flex">
                默认保存策略
              </div>
              <div className="hidden max-w-[320px] truncate text-[12px] text-text-secondary xl:block">
                {savePolicySummary}
              </div>
              <button
                className="inline-flex h-9 items-center justify-center gap-2 rounded-[14px] border border-brand-primary/20 bg-white px-3.5 text-sm font-medium text-brand-primary transition-colors hover:bg-brand-soft"
                onClick={openSettings}
              >
                <Settings size={15} />
                设置
              </button>
            </div>
          </div>
        </section>

        <div className="mt-6 grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
          <section
            className={`card overflow-hidden rounded-[24px] border bg-white/96 transition-colors ${
              isDragOver ? 'border-brand-primary shadow-[0_18px_48px_rgba(191,64,69,0.12)]' : 'border-border-default'
            }`}
            onDragOver={(event) => {
              if (isTaskActive) {
                return;
              }
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              disabled={isTaskActive}
              onChange={handleFileChange}
            />

            <div className="border-b border-border-default bg-white/90 px-5 py-5 md:px-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-text-primary">导入 Markdown</h2>
                  <p className="mt-1 text-[13px] text-text-secondary">支持 .md / .markdown / .txt</p>
                </div>
                {(parseState === 'parsing' || parseState === 'reading') ? (
                  <div className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                    <Loader2 className="animate-spin" size={12} />
                    {parseState === 'reading' ? '读取中' : '解析中'}
                  </div>
                ) : null}
              </div>

              <div
                className={`mt-5 rounded-[22px] border px-5 py-7 text-center transition-colors ${
                  isDragOver
                    ? 'border-brand-primary bg-brand-soft/18'
                    : 'border-dashed border-[#E4D7CB] bg-[linear-gradient(180deg,#fffefc_0%,#fcf7f1_100%)]'
                }`}
              >
                <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] ${
                  isDragOver ? 'bg-brand-primary text-white' : 'bg-white text-brand-primary'
                }`}>
                  <Upload size={24} />
                </div>
                <div className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-text-primary">
                  {isDragOver ? '松开以上传文件' : '拖拽文件到这里'}
                </div>
                <div className="mt-2 text-sm text-text-secondary">也支持粘贴文本</div>
                <button
                  className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-[14px] border border-[#DDD1C5] bg-white px-4 text-sm font-medium text-text-primary transition-colors hover:bg-[#FCF7F1] focus:outline-none focus:ring-2 focus:ring-brand-focus disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isTaskActive}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileText size={16} />
                  选择文件
                </button>
              </div>

              {visibleFile ? (
                <div className="mt-4 rounded-[18px] border border-[#EADFD4] bg-[#FFFCF8] px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium tracking-[0.16em] text-text-secondary">已选择文件</div>
                      <div className="mt-2 truncate text-sm font-medium text-text-primary">{visibleFile.name}</div>
                      <div className="mt-1 text-sm text-text-secondary">
                        {formatFileSize(visibleFile.size)} · 已就绪
                      </div>
                    </div>
                      <div className="flex items-center gap-3 text-sm">
                        <button
                          className="text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={isTaskActive}
                          onClick={() => fileInputRef.current?.click()}
                      >
                        更换
                      </button>
                      <button
                        className="text-text-secondary transition-colors hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={isTaskActive}
                        onClick={handleRemoveSelectedFile}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {uploadError ? (
                <div className="mt-4 rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {uploadError}
                </div>
              ) : null}

              {parseError && !isEditorExpanded ? (
                <div className="mt-4 inline-flex items-start gap-2 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{parseError}</span>
                </div>
              ) : null}

              {isTaskActive ? (
                <div className="mt-4 rounded-[14px] border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
                  当前有保存任务在运行或暂停中。若要重新导入，请先继续完成或取消当前任务。
                </div>
              ) : null}
            </div>

            <div className="bg-[#FFFCF8] px-5 py-4 md:px-6">
              <button
                className="flex w-full items-center justify-between rounded-[16px] border border-[#EADFD4] bg-white px-4 py-3 text-left transition-colors hover:bg-[#FFF9F1]"
                disabled={isTaskActive}
                onClick={handleToggleEditor}
              >
                <div>
                  <div className="text-sm font-medium text-text-primary">展开编辑 Markdown</div>
                  <div className="mt-1 text-[13px] text-text-secondary">编辑属于次级操作，修改后右侧会自动同步。</div>
                </div>
                {isEditorExpanded ? <ChevronUp size={18} className="text-text-secondary" /> : <ChevronDown size={18} className="text-text-secondary" />}
              </button>

              {isEditorExpanded ? (
                <div className="mt-4">
                  <textarea
                    ref={textareaRef}
                    value={markdown}
                    disabled={isTaskActive}
                    onKeyDown={handleEditorKeyDown}
                    onChange={(event) => {
                      clearSaveState();
                      setImportedFileMeta(null);
                      setUploadError('');
                      setFileName('');
                      setMarkdown(event.target.value);
                    }}
                    placeholder="把 Markdown 粘贴到这里，或上传一个文件"
                    className="input min-h-[320px] resize-none overflow-auto rounded-[16px] border-[#E8DED6] bg-white font-mono text-[13px] leading-7"
                  />

                  {parseError ? (
                    <div className="mt-4 inline-flex items-start gap-2 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      <span>{parseError}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="card flex min-h-[720px] flex-col overflow-hidden rounded-[24px] border border-border-default bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(255,250,245,0.96)_100%)]">
            <div className="border-b border-border-default bg-white/92 px-5 py-5 md:px-6">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-[22px] font-semibold tracking-[-0.03em] text-text-primary">预览结果</div>
                  <p className="mt-1 text-[13px] text-text-secondary">右侧优先查看最终效果，也可切回原始 Markdown。</p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {isPreviewEdited && previewMode === 'preview' ? (
                    <button
                      className="inline-flex h-8 items-center rounded-full border border-brand-primary/25 bg-white px-3 text-[12px] font-medium text-brand-primary transition-colors hover:bg-brand-soft"
                      disabled={isTaskActive}
                      onClick={resetPreviewEdits}
                    >
                      还原预览修改
                    </button>
                  ) : null}
                  <div className="inline-flex rounded-full border border-border-default bg-white p-1 shadow-sm">
                    <PreviewModeButton
                      active={previewMode === 'preview'}
                      icon={<Eye size={15} />}
                      label="墨问效果"
                      onClick={() => setPreviewMode('preview')}
                    />
                    <PreviewModeButton
                      active={previewMode === 'markdown'}
                      icon={<FileText size={15} />}
                      label="原始 Markdown"
                      onClick={() => setPreviewMode('markdown')}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className={`flex min-h-[420px] flex-1 flex-col border-b border-border-default bg-[linear-gradient(180deg,#fffefb_0%,#fff8f1_100%)] p-4 md:p-5 ${PANEL_BODY_MAX_HEIGHT_CLASS}`}>
              {showRawMarkdown ? (
                <pre className="h-full min-h-0 flex-1 overflow-auto rounded-[20px] border border-[#E9DED3] bg-[#FFFDF9] p-5 font-mono text-[13px] leading-7 text-text-primary">
                  {markdown || '选择一个 Markdown 文件，或直接粘贴内容。'}
                </pre>
              ) : showPreviewEmptyState ? (
                <PreviewEmptyState />
              ) : (
                <div
                  className="mx-auto h-full min-h-0 max-w-[820px] flex-1 overflow-auto rounded-[24px] border border-[#E9DED3] bg-white px-5 py-7 shadow-[0_24px_64px_rgba(129,91,58,0.10)] md:px-8 md:py-8"
                >
                  <article className="md-import-preview-article h-full min-h-0">
                    <header className="mb-6 border-b border-[#F1E6DB] pb-5">
                      <h1 className="m-0 text-[28px] font-semibold leading-[1.35] tracking-[-0.03em] text-text-primary">
                        {effectiveTitle || '未命名 Markdown'}
                      </h1>
                    </header>
                    <div
                      key={previewDraftVersion}
                      contentEditable={!isTaskActive}
                      suppressContentEditableWarning
                      spellCheck={false}
                      onInput={handlePreviewInput}
                      onBlur={handlePreviewBlur}
                      onKeyDown={handlePreviewKeyDown}
                      className="outline-none [&_.md-import-preview-empty]:rounded-[20px] [&_.md-import-preview-empty]:border [&_.md-import-preview-empty]:border-dashed [&_.md-import-preview-empty]:border-[#E5D7CA] [&_.md-import-preview-empty]:bg-[#FFFCF8] [&_.md-import-preview-empty]:px-5 [&_.md-import-preview-empty]:py-12 [&_.md-import-preview-empty]:text-center [&_.md-import-preview-empty]:text-text-secondary [&_.md-import-preview-block]:text-[15px] [&_.md-import-preview-block]:leading-8 [&_.md-import-preview-block]:text-text-primary [&_.md-import-preview-block:focus-visible]:outline-none [&_.md-import-heading]:m-0 [&_.md-import-heading]:font-semibold [&_.md-import-heading]:tracking-[-0.02em] [&_.md-import-heading-1]:text-[28px] [&_.md-import-heading-1]:leading-[1.35] [&_.md-import-heading-2]:text-[24px] [&_.md-import-heading-2]:leading-[1.45] [&_.md-import-heading-3]:text-[20px] [&_.md-import-heading-3]:leading-[1.5] [&_.md-import-heading-4]:text-[18px] [&_.md-import-heading-4]:leading-[1.55] [&_.md-import-heading-5]:text-[16px] [&_.md-import-heading-5]:leading-[1.65] [&_.md-import-heading-6]:text-[15px] [&_.md-import-heading-6]:leading-[1.75] [&_p]:m-0 [&_p]:whitespace-pre-wrap [&_p]:break-words [&_p]:text-[15px] [&_p]:leading-8 [&_div]:whitespace-pre-wrap [&_div]:break-words [&_div]:text-[15px] [&_div]:leading-8 [&_strong]:font-semibold [&_a]:text-brand-primary [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:my-5 [&_blockquote]:rounded-r-[18px] [&_blockquote]:border-l-4 [&_blockquote]:border-[#E6D1C2] [&_blockquote]:bg-[#FBF6F1] [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote_p+p]:mt-3 [&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:break-words [&_li]:leading-8 [&_li+li]:mt-2 [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:rounded-[22px] [&_pre]:border [&_pre]:border-[#E5EAF3] [&_pre]:bg-[#F4F7FC] [&_pre]:px-6 [&_pre]:py-6 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-7 [&_pre]:text-[#334155] [&_pre]:shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_code]:rounded-[6px] [&_code]:bg-[#F6EFE7] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-[#8F5A44] [&_figure]:my-5 [&_figure]:grid [&_figure]:gap-2 [&_img]:block [&_img]:max-w-full [&_img]:rounded-[18px] [&_img]:border [&_img]:border-[#EFE3D7] [&_figcaption]:text-[12px] [&_figcaption]:leading-6 [&_figcaption]:text-text-secondary"
                      dangerouslySetInnerHTML={{
                        __html: previewDraftHtml,
                      }}
                    />
                  </article>
                </div>
              )}
            </div>

            {showSavePanel ? (
              <div className="bg-[#FCF8F3] px-5 py-5 md:px-6">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-[12px] font-medium tracking-[0.18em] text-text-secondary">保存到墨问</div>
                    <div className="mt-1 text-[13px] text-text-secondary">
                      {saveState === 'success'
                        ? '内容已写入墨问，可以直接查看或继续导入下一篇。'
                        : isPreviewEdited
                          ? '保存会以右侧预览区当前编辑后的内容为准。'
                          : '导入成功后可直接保存。'}
                    </div>
                  </div>

                  {saveBlockedReason ? (
                    <div className="text-sm text-yellow-800">{saveBlockedReason}</div>
                  ) : null}
                </div>

                {saveState === 'success' ? (
                  <div className="mt-4 rounded-[16px] border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                    {primarySavedNote ? `已生成 ${notes.length} 篇笔记，可以直接打开查看。` : '保存已完成。'}
                  </div>
                ) : saveState === 'failed' && (saveResult?.error || saveProgress.error) ? (
                  <div className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {saveResult?.error || saveProgress.error || '请检查配置或稍后重试。'}
                  </div>
                ) : actionError ? (
                  <div className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {actionError}
                  </div>
                ) : isTaskActive ? (
                  <SaveProgressPanel
                    progress={saveProgress}
                    progressView={saveProgressView}
                    saveState={saveState}
                    summary={saveProgressSummary}
                  />
                ) : null}

                <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
                  {saveState === 'success' && primarySavedNote ? (
                    <>
                      <a
                        href={primarySavedNote.noteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${PRIMARY_ACTION_BUTTON_CLASS} h-11 sm:min-w-[190px]`}
                      >
                        <ExternalLink size={16} />
                        去墨问查看
                      </a>
                      <button
                        className={`${SECONDARY_ACTION_BUTTON_CLASS} sm:min-w-[160px]`}
                        onClick={clearWorkspace}
                      >
                        <RefreshCw size={16} />
                        继续导入下一篇
                      </button>
                    </>
                  ) : isTaskActive ? (
                    <>
                      <button className={`${SECONDARY_ACTION_BUTTON_CLASS} sm:min-w-[160px]`} onClick={handlePauseResume}>
                        {saveState === 'paused' ? '继续保存' : '暂停任务'}
                      </button>
                      <button
                        className={`${SECONDARY_ACTION_BUTTON_CLASS} border-red-200 text-red-600 hover:bg-red-50 sm:min-w-[140px]`}
                        onClick={handleCancelSave}
                      >
                        取消任务
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={`${PRIMARY_ACTION_BUTTON_CLASS} h-11 sm:min-w-[200px]`}
                        disabled={saveButtonDisabled}
                        onClick={handleStartSave}
                      >
                        <Save size={16} />
                        保存到墨问
                      </button>
                      <button
                        className={`${SECONDARY_ACTION_BUTTON_CLASS} sm:min-w-[140px]`}
                        disabled={isTaskActive}
                        onClick={clearWorkspace}
                      >
                        <RefreshCw size={16} />
                        重新导入
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function FlowStep(props: {
  index: number;
  label: string;
  state: 'current' | 'complete' | 'upcoming';
}): JSX.Element {
  const toneClass = props.state === 'current'
    ? 'border-brand-primary/25 bg-brand-soft text-brand-primary'
    : props.state === 'complete'
      ? 'border-green-200 bg-green-50 text-green-700'
      : 'border-[#E9DED3] bg-white text-text-secondary';

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 ${toneClass}`}>
      <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
        props.state === 'current'
          ? 'bg-brand-primary text-white'
          : props.state === 'complete'
            ? 'bg-green-600 text-white'
            : 'bg-[#F3ECE4] text-text-primary'
      }`}>
        {props.state === 'complete' ? '✓' : props.index}
      </div>
      <div className="text-sm font-medium">{props.label}</div>
    </div>
  );
}

function PreviewModeButton(props: {
  active: boolean;
  icon: JSX.Element;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${
        props.active
          ? 'bg-brand-primary text-text-on-brand shadow-sm'
          : 'text-text-secondary hover:bg-brand-soft'
      }`}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function PreviewEmptyState(): JSX.Element {
  return (
    <div className="mx-auto flex h-full min-h-[520px] max-w-[820px] flex-col justify-center rounded-[24px] border border-dashed border-[#E4D7CB] bg-white/74 px-7 py-10 text-left">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-[18px] bg-brand-soft text-brand-primary">
        <Eye size={22} />
      </div>
      <h3 className="mt-5 text-[24px] font-semibold tracking-[-0.02em] text-text-primary">导入后可在这里查看效果</h3>
      <p className="mt-2.5 max-w-xl text-[15px] leading-7 text-text-secondary">
        左侧导入文件或展开编辑 Markdown，右侧会按当前默认保存策略实时更新预览。
      </p>
    </div>
  );
}

function SaveProgressPanel(props: {
  progress: SaveProgress;
  progressView: ReturnType<typeof getSaveProgressVisualState>;
  saveState: SaveState;
  summary: string;
}): JSX.Element {
  return (
    <div className="mt-4 rounded-[18px] border border-[#E8DED6] bg-white/82 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">
            {props.saveState === 'paused' ? '任务已暂停' : '正在保存到墨问…'}
          </div>
          <div className="mt-1 text-xs leading-6 text-text-secondary">
            {props.summary}
            {props.saveState === 'paused' ? '，继续后会从上一次的安全点恢复。' : ''}
          </div>
        </div>
        <div className="rounded-full border border-brand-primary/15 bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand-primary">
          {Math.round(props.progressView.overallProgress)}%
        </div>
      </div>

      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#EDE4DB]">
        <div
          className="h-full rounded-full bg-brand-primary transition-all duration-300"
          style={{ width: `${props.progressView.overallProgress}%` }}
        />
      </div>

      {props.progressView.hasImages && props.progressView.hasNotes ? (
        <div className="mt-2 flex items-center justify-between text-[12px] text-text-secondary">
          <span className={props.progressView.imagePhaseActive ? 'font-medium text-brand-primary' : ''}>
            ① 上传图片
          </span>
          <span className={props.progressView.notePhaseActive ? 'font-medium text-brand-primary' : ''}>
            ② 创建笔记
          </span>
        </div>
      ) : null}

      {props.progress.status === 'paused' && props.progressView.phaseDetail ? (
        <div className="mt-2 text-[12px] text-text-secondary">
          当前停在 {props.progressView.phaseDetail}
        </div>
      ) : null}
    </div>
  );
}

export default MdImportPage;
