import React, { useState, useEffect, useCallback, useRef } from 'react';
import './notesExport.css';
import {
  MowenNoteItem,
  PdfExportProgress,
  PdfExportSettings,
  PDF_EXPORT_MAX_COUNT,
} from '../types';
import {
  fetchNoteList,
  fetchNoteDetail,
  fetchNoteRefInfos,
  checkLoginStatus,
  MowenWebApiError,
} from '../services/mowenWebApi';
import { exportMergedPdf, exportBatchAsZip } from '../utils/pdfExporter';
import {
  FileText,
  Download,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  LogIn,
  Search,
  RefreshCw,
  X,
  RotateCcw,
} from 'lucide-react';

// ============================================
// 工具函数（不变）
// ============================================

// 合集子笔记缓存
const childNotesCache = new Map<string, MowenNoteItem[]>();
const collectionStatusCache = new Map<string, Pick<MowenNoteItem, 'isCollection' | 'canExpandChildren'>>();
const noteDetailCache = new Map<string, Promise<Awaited<ReturnType<typeof fetchNoteDetail>>>>();

type CollectionStatus = Pick<MowenNoteItem, 'isCollection' | 'canExpandChildren'>;

function isPotentialCollectionCandidate(note: Pick<MowenNoteItem, 'title' | 'digest' | 'isCollection'>): boolean {
  if (note.isCollection) return false;

  const title = note.title.trim();
  const digest = note.digest.trim();
  const normalizedTitle = title.replace(/[\s\u00A0\u200B\uFEFF]/g, '');

  return (
    /(合集|合辑)(?:[）)\]】」』"'""']*)$/.test(normalizedTitle) ||
    /^(此合集|本合集|该合集)/.test(digest) ||
    digest.includes('已自动拆分为')
  );
}

function extractChildUuidsFromHtml(html: string): string[] {
  const childUuids: string[] = [];
  const patterns = [
    /<note\b[^>]*uuid="([^"]+)"/g,
    /data-note-uuid="([^"]+)"/g,
    /data-mowen-note-uuid="([^"]+)"/g,
    /<q\b[^>]*uuid="([^"]+)"/g,
    /\bcite="(?:https?:\/\/(?:note|d-note|dev-note)\.mowen\.cn)?\/detail\/([^"?#/]+)"/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      if (!childUuids.includes(match[1])) {
        childUuids.push(match[1]);
      }
    }
  }

  return childUuids;
}

function getChildUuidsFromDetail(detail: Awaited<ReturnType<typeof fetchNoteDetail>>): string[] {
  if (detail.childNoteIds && detail.childNoteIds.length > 0) {
    return detail.childNoteIds;
  }

  return extractChildUuidsFromHtml(detail.htmlContent);
}

function getCollectionStatusFromDetail(
  detail: Awaited<ReturnType<typeof fetchNoteDetail>>
): CollectionStatus {
  const hasChildren = getChildUuidsFromDetail(detail).length > 0;
  return {
    isCollection: hasChildren,
    canExpandChildren: hasChildren,
  };
}

function mergeCollectionStatus(
  current: Partial<CollectionStatus> | undefined,
  incoming: Partial<CollectionStatus> | undefined
): CollectionStatus {
  const isCollection = Boolean(current?.isCollection || incoming?.isCollection);
  const canExpandChildren = Boolean(
    current?.canExpandChildren ||
    incoming?.canExpandChildren ||
    isCollection
  );

  return {
    isCollection,
    canExpandChildren,
  };
}

function fetchNoteDetailCached(uuid: string): Promise<Awaited<ReturnType<typeof fetchNoteDetail>>> {
  const cached = noteDetailCache.get(uuid);
  if (cached) {
    return cached;
  }

  const request = fetchNoteDetail(uuid).catch((error) => {
    noteDetailCache.delete(uuid);
    throw error;
  });

  noteDetailCache.set(uuid, request);
  return request;
}

async function resolveChildNotes(childUuids: string[]): Promise<MowenNoteItem[]> {
  if (childUuids.length === 0) return [];

  // ref/infos API 可能因无效 UUID 返回 400，需要 try-catch 保护
  let refInfoNotes: MowenNoteItem[] = [];
  try {
    refInfoNotes = await fetchNoteRefInfos(childUuids);
  } catch (error) {
    console.warn('[NotesExport] fetchNoteRefInfos 失败，降级为逐个获取', error);
  }

  const existingMap = new Map(refInfoNotes.map((note) => [note.uuid, note]));
  const missingUuids = childUuids.filter((uuid) => !existingMap.has(uuid));

  if (missingUuids.length === 0) {
    return childUuids.map((uuid) => existingMap.get(uuid)!).filter(Boolean);
  }

  const fallbackNotes = await Promise.all(
    missingUuids.map(async (childUuid) => {
      try {
        const detail = await fetchNoteDetailCached(childUuid);
        return {
          uuid: childUuid,
          title: detail.title,
          digest: '',
          createdAt: '',
          isCollection: false,
        } as MowenNoteItem;
      } catch (error) {
        console.warn('[NotesExport] Failed to fetch child detail', error);
        return null;
      }
    })
  );

  for (const note of fallbackNotes) {
    if (note) {
      existingMap.set(note.uuid, note);
    }
  }

  return childUuids.map((uuid) => existingMap.get(uuid)).filter(Boolean) as MowenNoteItem[];
}

function parseNoteDate(value: string | number): Date | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.abs(value) < 1e12 ? value * 1000 : value;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{10}$/.test(trimmed)) {
    const parsed = new Date(Number.parseInt(trimmed, 10) * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (/^\d{13}$/.test(trimmed)) {
    const parsed = new Date(Number.parseInt(trimmed, 10));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: normalizedConcurrency }, async () => {
      while (cursor < items.length) {
        const currentIndex = cursor;
        cursor += 1;
        await worker(items[currentIndex]);
      }
    })
  );
}

function mergeNoteItem(
  existing: MowenNoteItem | undefined,
  incoming: MowenNoteItem
): MowenNoteItem {
  const cachedStatus = collectionStatusCache.get(incoming.uuid);

  return {
    ...(existing || incoming),
    ...incoming,
    title: incoming.title !== '无标题' ? incoming.title : existing?.title || incoming.title,
    digest: incoming.digest || existing?.digest || '',
    createdAt: incoming.createdAt || existing?.createdAt || '',
    tags: incoming.tags && incoming.tags.length > 0 ? incoming.tags : existing?.tags,
    coverImage: incoming.coverImage || existing?.coverImage,
    isCollection: Boolean(
      cachedStatus?.isCollection ||
      existing?.isCollection ||
      incoming.isCollection
    ),
    canExpandChildren: Boolean(
      cachedStatus?.canExpandChildren ||
      existing?.canExpandChildren ||
      incoming.canExpandChildren
    ),
    isTop: Boolean(existing?.isTop || incoming.isTop),
    childNoteIds: incoming.childNoteIds && incoming.childNoteIds.length > 0
      ? incoming.childNoteIds
      : existing?.childNoteIds,
  };
}

function mergeNotesByUuid(existingNotes: MowenNoteItem[], incomingNotes: MowenNoteItem[]): MowenNoteItem[] {
  if (existingNotes.length === 0) {
    const uniqueNotes: MowenNoteItem[] = [];
    const noteMap = new Map<string, MowenNoteItem>();
    const appended = new Set<string>();

    for (const note of incomingNotes) {
      const merged = mergeNoteItem(noteMap.get(note.uuid), note);
      noteMap.set(note.uuid, merged);
    }

    for (const note of incomingNotes) {
      const merged = noteMap.get(note.uuid);
      if (merged && !appended.has(merged.uuid)) {
        appended.add(merged.uuid);
        uniqueNotes.push(merged);
      }
    }

    return uniqueNotes;
  }

  const noteMap = new Map(existingNotes.map((note) => [note.uuid, note]));
  const mergedNotes = [...existingNotes];
  const noteIndexMap = new Map(existingNotes.map((note, index) => [note.uuid, index]));

  for (const note of incomingNotes) {
    const existing = noteMap.get(note.uuid);
    const merged = mergeNoteItem(existing, note);
    noteMap.set(note.uuid, merged);

    if (existing) {
      const index = noteIndexMap.get(note.uuid);
      if (index !== undefined) {
        mergedNotes[index] = merged;
      }
    } else {
      noteIndexMap.set(note.uuid, mergedNotes.length);
      mergedNotes.push(merged);
    }
  }

  return mergedNotes;
}

// ============================================
// 主组件
// ============================================

const NotesExportPage: React.FC = () => {
  // 登录状态
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [loginChecking, setLoginChecking] = useState(true);

  // 笔记列表
  const [notes, setNotes] = useState<MowenNoteItem[]>([]);
  const [nextHint, setNextHint] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');

  // 搜索
  const [searchQuery, setSearchQuery] = useState('');

  // 选择状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 合集展开
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [childNotes, setChildNotes] = useState<Map<string, MowenNoteItem[]>>(new Map());
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set());

  // 导出状态
  const [exportProgress, setExportProgress] = useState<PdfExportProgress>({ status: 'idle' });

  // 已选内容区展开/收起
  const [selectedListExpanded, setSelectedListExpanded] = useState(false);

  // 导出设置（PRD 第 10 节）
  const [exportSettings, setExportSettings] = useState<PdfExportSettings>({
    exportMode: 'separate',
    includeImages: true,
  });

  // 失败项记录（用于重试）
  const [failedUuids, setFailedUuids] = useState<string[]>([]);
  const notesRef = useRef<MowenNoteItem[]>([]);
  const isMountedRef = useRef(true);
  const verificationGenerationRef = useRef(0);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      verificationGenerationRef.current += 1;
      loadRequestIdRef.current += 1;
    };
  }, []);

  const applyCollectionStatus = useCallback((
    uuid: string,
    status: CollectionStatus,
    childNoteIds?: string[]
  ) => {
    const currentNote = notesRef.current.find((note) => note.uuid === uuid);
    const mergedStatus = mergeCollectionStatus(
      currentNote || collectionStatusCache.get(uuid),
      status
    );

    collectionStatusCache.set(uuid, mergedStatus);
    setNotes((prev) => prev.map((note) => (
      note.uuid === uuid
        ? {
            ...note,
            ...mergeCollectionStatus(note, mergedStatus),
            // 合集笔记的子笔记 UUID 列表（用于显示篇数）
            childNoteIds: childNoteIds && childNoteIds.length > 0
              ? childNoteIds
              : note.childNoteIds,
          }
        : note
    )));
  }, []);

  const isVerificationActive = useCallback((generation: number) => (
    isMountedRef.current && verificationGenerationRef.current === generation
  ), []);

  const verifyCollectionCandidates = useCallback(async (noteItems: MowenNoteItem[], generation: number) => {
    if (!isVerificationActive(generation)) {
      return;
    }

    const prioritized: MowenNoteItem[] = [];
    const background: MowenNoteItem[] = [];

    for (const note of noteItems) {
      const cachedStatus = collectionStatusCache.get(note.uuid);
      if (cachedStatus) {
        if (isVerificationActive(generation)) {
          applyCollectionStatus(note.uuid, cachedStatus, note.childNoteIds);
        }
        continue;
      }

      if (note.isCollection || note.canExpandChildren || (note.childNoteIds?.length ?? 0) > 0) {
        if (isVerificationActive(generation)) {
          applyCollectionStatus(
            note.uuid,
            {
              isCollection: Boolean(note.isCollection || (note.childNoteIds?.length ?? 0) > 0),
              canExpandChildren: Boolean(note.canExpandChildren || (note.childNoteIds?.length ?? 0) > 0),
            },
            note.childNoteIds
          );
        }
        continue;
      }

      if (note.isTop || isPotentialCollectionCandidate(note)) {
        prioritized.push(note);
      } else {
        background.push(note);
      }
    }

    const verifyNote = async (note: MowenNoteItem) => {
      if (!isVerificationActive(generation)) return;

      try {
        const detail = await fetchNoteDetailCached(note.uuid);
        if (!isVerificationActive(generation)) return;

        const childUuids = getChildUuidsFromDetail(detail);
        if (childUuids.length === 0) {
          return;
        }

        applyCollectionStatus(note.uuid, getCollectionStatusFromDetail(detail), childUuids);
      } catch (error) {
        console.warn('[NotesExport] Failed to verify collection status', error);
      }
    };

    await runWithConcurrency(prioritized, 2, verifyNote);

    for (const note of background) {
      if (!isVerificationActive(generation)) {
        return;
      }

      await verifyNote(note);

      if (!isVerificationActive(generation)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }, [applyCollectionStatus, isVerificationActive]);

  // 加载笔记列表
  const loadNotes = useCallback(async (hint = '') => {
    const isFirstPage = hint === '';
    const requestId = ++loadRequestIdRef.current;
    const verificationGeneration = isFirstPage
      ? ++verificationGenerationRef.current
      : verificationGenerationRef.current;

    if (isFirstPage) {
      noteDetailCache.clear();
    }

    setListLoading(true);
    setListError('');
    try {
      const result = await fetchNoteList(
        { hint, size: 20 },
        { benchType: 1 }
      );
      if (!isMountedRef.current || loadRequestIdRef.current !== requestId) {
        return;
      }

      setNotes(prev => (hint === '' ? mergeNotesByUuid([], result.notes) : mergeNotesByUuid(prev, result.notes)));
      void verifyCollectionCandidates(result.notes, verificationGeneration);
      setNextHint(result.nextHint);
      setTotalCount(result.total);
    } catch (error) {
      if (!isMountedRef.current || loadRequestIdRef.current !== requestId) {
        return;
      }

      const msg = error instanceof MowenWebApiError ? error.message : '加载失败，请重试';
      setListError(msg);
    } finally {
      if (isMountedRef.current && loadRequestIdRef.current === requestId) {
        setListLoading(false);
      }
    }
  }, [verifyCollectionCandidates]);

  // 检查登录态
  useEffect(() => {
    const check = async () => {
      setLoginChecking(true);
      const loggedIn = await checkLoginStatus();
      if (!isMountedRef.current) {
        return;
      }

      setIsLoggedIn(loggedIn);
      setLoginChecking(false);
      if (loggedIn) {
        loadNotes();
      }
    };
    check();
  }, [loadNotes]);

  // 加载更多
  const loadMore = useCallback(() => {
    if (nextHint && !listLoading) {
      loadNotes(nextHint);
    }
  }, [nextHint, listLoading, loadNotes]);

  // 刷新列表
  const refreshList = useCallback(() => {
    verificationGenerationRef.current += 1;
    setNotes([]);
    setNextHint('');
    setSelectedIds(new Set());
    setExpandedCollections(new Set());
    setChildNotes(new Map());
    childNotesCache.clear();
    collectionStatusCache.clear();
    noteDetailCache.clear();
    loadNotes();
  }, [loadNotes]);

  // 展开/收起合集
  const toggleCollection = useCallback(async (uuid: string) => {
    const isExpanded = expandedCollections.has(uuid);

    if (isExpanded) {
      setExpandedCollections(prev => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
      return;
    }

    // 展开：先检查缓存
    if (childNotesCache.has(uuid)) {
      setChildNotes(prev => new Map(prev).set(uuid, childNotesCache.get(uuid)!));
      setExpandedCollections(prev => new Set(prev).add(uuid));
      return;
    }

    // 需要获取子笔记详情
    setLoadingChildren(prev => new Set(prev).add(uuid));
    try {
      const detail = await fetchNoteDetailCached(uuid);
      const childUuids = getChildUuidsFromDetail(detail);
      const status = getCollectionStatusFromDetail(detail);
      if (status.isCollection) {
        applyCollectionStatus(uuid, status, childUuids);
      }

      if (childUuids.length > 0) {
        const children = await resolveChildNotes(childUuids);
        childNotesCache.set(uuid, children);
        setChildNotes(prev => new Map(prev).set(uuid, children));
      } else {
        childNotesCache.set(uuid, []);
        setChildNotes(prev => new Map(prev).set(uuid, []));
      }

      setExpandedCollections(prev => new Set(prev).add(uuid));
    } catch (error) {
      console.error('[NotesExport] Failed to load children', error);
    } finally {
      setLoadingChildren(prev => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
    }
  }, [expandedCollections, applyCollectionStatus]);

  // 切换选中状态
  const toggleSelect = useCallback((uuid: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else if (next.size < PDF_EXPORT_MAX_COUNT) {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  // 移除单个选中项（已选内容区使用）
  const removeSelected = useCallback((uuid: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(uuid);
      return next;
    });
  }, []);

  // 全选当前结果（PRD 第 9 节：全选范围 = 当前列表上下文）
  const selectAll = useCallback(() => {
    const filtered = searchQuery
      ? notes.filter(n =>
          n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          n.digest.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : notes;
    const newSelected = new Set<string>();
    for (const note of filtered) {
      if (newSelected.size >= PDF_EXPORT_MAX_COUNT) break;
      newSelected.add(note.uuid);
    }
    setSelectedIds(newSelected);
  }, [notes, searchQuery]);

  // 清空已选
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // 获取已选笔记的标题（用于已选内容区）
  const getSelectedNoteTitle = useCallback((uuid: string): string => {
    // 先从主列表搜索
    const note = notes.find(n => n.uuid === uuid);
    if (note) return note.title;
    // 再从子笔记缓存搜索
    for (const children of childNotes.values()) {
      const child = children.find(c => c.uuid === uuid);
      if (child) return child.title;
    }
    return uuid;
  }, [notes, childNotes]);

  // 导出选中的笔记
  const handleExport = useCallback(async (retryUuids?: string[]) => {
    const uuids = retryUuids || Array.from(selectedIds);
    if (uuids.length === 0) return;

    setExportProgress({ status: 'fetching', current: 0, total: uuids.length });
    setFailedUuids([]);

    // 第一阶段：获取所有笔记详情
    const noteDetails: Array<{
      uuid: string;
      title: string;
      htmlContent: string;
      sourceUrl?: string;
      childNotes?: Array<{ uuid: string; title: string; digest?: string }>;
    }> = [];
    const newFailedUuids: string[] = [];
    const failedTitles: string[] = [];

    for (let i = 0; i < uuids.length; i++) {
      const uuid = uuids[i];
      setExportProgress({
        status: 'fetching',
        current: i + 1,
        total: uuids.length,
        currentTitle: '获取笔记内容...',
      });

      try {
        const detail = await fetchNoteDetailCached(uuid);
        const detailCollectionStatus = getCollectionStatusFromDetail(detail);
        const childUuids = getChildUuidsFromDetail(detail);
        if (detailCollectionStatus.isCollection) {
          applyCollectionStatus(uuid, detailCollectionStatus, childUuids);
        }

        // 获取合集子笔记信息
        let childNotesForPdf: Array<{ uuid: string; title: string; digest?: string }> | undefined;
        const noteItem = notes.find(n => n.uuid === uuid);
        if (noteItem?.canExpandChildren || childUuids.length > 0) {
          let children = childNotes.get(uuid) || childNotesCache.get(uuid);
          if (!children && childUuids.length > 0) {
            children = await resolveChildNotes(childUuids);
            childNotesCache.set(uuid, children);
          }
          if (children && children.length > 0) {
            childNotesForPdf = children.map(c => ({
              uuid: c.uuid,
              title: c.title,
              digest: c.digest,
            }));
          }
        }

        noteDetails.push({
          uuid,
          title: detail.title,
          htmlContent: detail.htmlContent,
          childNotes: childNotesForPdf,
        });
      } catch (error) {
        newFailedUuids.push(uuid);
        const noteItem = notes.find(n => n.uuid === uuid);
        failedTitles.push(noteItem?.title || uuid);
        console.error('[NotesExport] Export fetch error', error);
      }
    }

    if (noteDetails.length === 0) {
      // 全部失败
      setFailedUuids(newFailedUuids);
      setExportProgress({
        status: 'failed',
        current: 0,
        total: uuids.length,
        error: `全部获取失败：${failedTitles.join('、')}`,
      });
      return;
    }

    // 第二阶段：导出 PDF
    setExportProgress({
      status: 'converting',
      current: 0,
      total: noteDetails.length,
      currentTitle: '生成 PDF...',
    });

    const skipImages = !exportSettings.includeImages;
    let exportedCount = noteDetails.length;
    const generationFailedUuids: string[] = [];
    const generationFailedTitles: string[] = [];

    try {
      if (exportSettings.exportMode === 'merged') {
        // 合并导出为单个 PDF
        await exportMergedPdf(noteDetails, { skipImages });
      } else {
        // 逐篇导出：单篇直接下载 PDF，多篇打包为 ZIP
        const exportResult = await exportBatchAsZip(
          noteDetails,
          { skipImages },
          (current, total, title) => {
            setExportProgress({
              status: 'converting',
              current,
              total,
              currentTitle: title,
            });
          }
        );

        exportedCount = exportResult.success;
        generationFailedUuids.push(
          ...exportResult.failedNotes
            .map(note => note.uuid)
            .filter((uuid): uuid is string => Boolean(uuid))
        );
        generationFailedTitles.push(...exportResult.failedNotes.map(note => note.title));

        if (exportResult.success === 0) {
          setFailedUuids(generationFailedUuids.length > 0 ? generationFailedUuids : newFailedUuids);
          setExportProgress({
            status: 'failed',
            current: 0,
            total: uuids.length,
            error: `PDF 生成失败：${generationFailedTitles.join('、') || '未知错误'}`,
          });
          return;
        }
      }
    } catch (error) {
      console.error('[NotesExport] PDF generation error', error);
      setExportProgress({
        status: 'failed',
        current: 0,
        total: uuids.length,
        error: `PDF 生成失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
      return;
    }

    const allFailedUuids = [...newFailedUuids, ...generationFailedUuids];
    const allFailedTitles = [...failedTitles, ...generationFailedTitles];

    // 设置最终状态
    if (allFailedUuids.length > 0) {
      setFailedUuids(allFailedUuids);
      setExportProgress({
        status: 'success',
        current: uuids.length,
        total: uuids.length,
        error: `已成功导出 ${exportedCount} 篇，${allFailedUuids.length} 篇失败：${allFailedTitles.join('、')}`,
      });
    } else {
      setExportProgress({
        status: 'success',
        current: uuids.length,
        total: uuids.length,
      });
    }

    // 8 秒后重置（给用户更多时间看到结果）
    setTimeout(() => {
      setExportProgress({ status: 'idle' });
      setFailedUuids([]);
    }, 8000);
  }, [selectedIds, notes, childNotes, applyCollectionStatus, exportSettings]);

  // 重试失败项
  const handleRetryFailed = useCallback(() => {
    if (failedUuids.length > 0) {
      handleExport(failedUuids);
    }
  }, [failedUuids, handleExport]);

  // 本地搜索过滤
  const filteredNotes = searchQuery
    ? notes.filter(n =>
        n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.digest.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : notes;

  // 格式化日期
  const formatDate = (dateValue: string | number) => {
    const date = parseNoteDate(dateValue);
    if (!date) return '';

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  // ============================================
  // 渲染
  // ============================================

  // 未完成登录检查
  if (loginChecking) {
    return (
      <div className="notes-export-page">
        <div className="notes-export-loading">
          <Loader2 className="animate-spin" size={32} />
          <p>正在检查登录状态...</p>
        </div>
      </div>
    );
  }

  // 未登录
  if (!isLoggedIn) {
    return (
      <div className="notes-export-page">
        <div className="notes-export-login">
          <LogIn size={48} strokeWidth={1.5} />
          <h2>请先登录墨问</h2>
          <p>在浏览器中登录 note.mowen.cn 后，即可查看和导出笔记。</p>
          <a
            href="https://note.mowen.cn"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
          >
            前往登录
          </a>
          <button onClick={() => window.location.reload()} className="btn-outline" style={{ marginTop: 12 }}>
            <RefreshCw size={16} />
            重新检查
          </button>
        </div>
      </div>
    );
  }

  // 已选 UUID 排序后列表
  const selectedUuids = Array.from(selectedIds);
  const isExporting = exportProgress.status !== 'idle';

  // 已登录 - 主界面
  return (
    <div className="notes-export-page">
      {/* 顶部任务区（PRD 第 7 节） */}
      <header className="notes-export-header">
        <div className="header-left">
          <div className="header-title-row">
            <FileText size={24} />
            <h1>导出笔记为 PDF</h1>
            {totalCount > 0 && <span className="note-count">共 {totalCount} 篇</span>}
          </div>
          <p className="header-subtitle">
            单次最多选择 {PDF_EXPORT_MAX_COUNT} 篇，支持普通笔记与合集内笔记
          </p>
        </div>
        <div className="header-right">
          <button onClick={refreshList} className="btn-icon" title="刷新">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      {/* 搜索栏 + 操作栏 */}
      <div className="notes-export-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索笔记标题或内容..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="toolbar-actions">
          <button onClick={selectAll} className="btn-text" disabled={filteredNotes.length === 0}>
            全选当前结果
          </button>
          <button onClick={clearSelection} className="btn-text" disabled={selectedIds.size === 0}>
            清空已选
          </button>
          <button
            onClick={() => handleExport()}
            className="btn-primary btn-export"
            disabled={selectedIds.size === 0 || isExporting}
          >
            <Download size={16} />
            导出选中（{selectedIds.size}/{PDF_EXPORT_MAX_COUNT}）
          </button>
        </div>
      </div>

      {/* 选择上限提示（PRD 第 9 节：超限处理） */}
      {selectedIds.size >= PDF_EXPORT_MAX_COUNT && (
        <div className="limit-warning">
          <AlertCircle size={14} />
          已达到单次导出上限 {PDF_EXPORT_MAX_COUNT} 篇，请分批导出
        </div>
      )}

      {/* 已选内容区（PRD 第 11.3 节） */}
      {selectedIds.size > 0 && !isExporting && (
        <div className="selected-summary">
          <div
            className="selected-summary-header"
            onClick={() => setSelectedListExpanded(!selectedListExpanded)}
          >
            <span className="selected-summary-header-left">
              <CheckCircle2 size={14} />
              已选 {selectedIds.size} 篇
            </span>
            <span className="selected-summary-header-right">
              {selectedListExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </div>
          {selectedListExpanded && (
            <div className="selected-summary-list">
              {selectedUuids.map(uuid => (
                <div key={uuid} className="selected-summary-item">
                  <span className="item-title">{getSelectedNoteTitle(uuid)}</span>
                  <button
                    className="btn-remove"
                    onClick={() => removeSelected(uuid)}
                    title="移除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 导出设置区（PRD 第 10 节） */}
      {selectedIds.size > 0 && !isExporting && (
        <div className="export-settings">
          <div className="export-settings-title">导出设置</div>
          <div className="export-settings-row">
            <span className="export-settings-label">导出方式</span>
            <div className="segmented-control">
              <button
                className={`segmented-btn ${exportSettings.exportMode === 'merged' ? 'active' : ''}`}
                onClick={() => setExportSettings(prev => ({ ...prev, exportMode: 'merged' }))}
              >
                合并导出
              </button>
              <button
                className={`segmented-btn ${exportSettings.exportMode === 'separate' ? 'active' : ''}`}
                onClick={() => setExportSettings(prev => ({ ...prev, exportMode: 'separate' }))}
              >
                逐篇导出
              </button>
            </div>
          </div>
          <p className="export-settings-hint">
            {exportSettings.exportMode === 'merged'
              ? '将所选笔记合并为 1 个 PDF 文件，笔记之间自动分页。'
              : '每篇笔记单独导出为 PDF；选中多篇时，自动打包为 ZIP 下载。'}
          </p>
          <div className="export-settings-row">
            <span className="export-settings-label">
              保留图片
              <span className="label-hint">关闭后仅导出文本</span>
            </span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={exportSettings.includeImages}
                onChange={(e) => setExportSettings(prev => ({ ...prev, includeImages: e.target.checked }))}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>
      )}

      {/* 导出进度（PRD 第 12 节：状态反馈） */}
      {isExporting && (
        <div className={`export-progress ${exportProgress.status} ${exportProgress.error && exportProgress.status === 'success' ? 'partial-fail' : ''}`}>
          {exportProgress.status === 'success' ? (
            <>
              <CheckCircle2 size={16} />
              <span>
                {exportProgress.error
                  ? exportProgress.error
                  : `PDF 已生成，共 ${exportProgress.total} 篇`}
              </span>
            </>
          ) : exportProgress.status === 'failed' ? (
            <>
              <AlertCircle size={16} />
              <span>{exportProgress.error || '导出失败，请重试'}</span>
            </>
          ) : (
            <>
              <Loader2 size={16} className="animate-spin" />
              <span>
                {exportProgress.status === 'fetching' ? '获取内容' : '生成 PDF'}
                （{exportProgress.current}/{exportProgress.total}）
                {exportProgress.currentTitle && `：${exportProgress.currentTitle}`}
              </span>
            </>
          )}
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${((exportProgress.current || 0) / (exportProgress.total || 1)) * 100}%` }}
            />
          </div>
          {/* 重试按钮（部分失败或完全失败时显示） */}
          {(exportProgress.status === 'success' && failedUuids.length > 0) || exportProgress.status === 'failed' ? (
            <div className="progress-actions">
              <button onClick={handleRetryFailed} className="btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
                <RotateCcw size={12} />
                重试失败项
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* 错误提示 */}
      {listError && (
        <div className="list-error">
          <AlertCircle size={16} />
          <span>{listError}</span>
          <button onClick={() => loadNotes()} className="btn-text">重试</button>
        </div>
      )}

      {/* 笔记列表 */}
      <div className="notes-list">
        {filteredNotes.map((note) => {
          const isCollection = Boolean(note.isCollection);
          const isExpandableCollection = Boolean(note.canExpandChildren);
          const isExpanded = expandedCollections.has(note.uuid);
          const isLoadingChild = loadingChildren.has(note.uuid);
          const children = childNotes.get(note.uuid) || [];
          const isAtLimit = selectedIds.size >= PDF_EXPORT_MAX_COUNT && !selectedIds.has(note.uuid);

          return (
            <div key={note.uuid} className="note-item-wrapper">
              <div className={`note-item ${selectedIds.has(note.uuid) ? 'selected' : ''} ${isAtLimit ? 'disabled' : ''}`}>
                <label className="note-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(note.uuid)}
                    onChange={() => toggleSelect(note.uuid)}
                    disabled={isAtLimit}
                  />
                </label>
                <div className="note-content" onClick={() => !isAtLimit && toggleSelect(note.uuid)}>
                  <div className="note-title-row">
                    <span className="note-title">{note.title}</span>
                    {note.isTop && (
                      <span className="badge badge-top">置顶</span>
                    )}
                    {isCollection && (
                      <span className="badge badge-collection">合集</span>
                    )}
                    {/* 合集子笔记数量（PRD 8.3：明确显示笔记数量） */}
                    {isExpandableCollection && (note.childNoteIds?.length || children.length) > 0 && (
                      <span className="badge-child-count">共 {note.childNoteIds?.length || children.length} 篇</span>
                    )}
                  </div>
                  {note.digest && (
                    <p className="note-digest">{note.digest}</p>
                  )}
                  <div className="note-meta">
                    <span className="note-date">{formatDate(note.createdAt)}</span>
                    {note.tags && note.tags.length > 0 && (
                      <div className="note-tags">
                        {note.tags.slice(0, 3).map((tag, i) => (
                          <span key={i} className="tag">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {isExpandableCollection && (
                  <button
                    className="btn-expand"
                    onClick={(e) => { e.stopPropagation(); toggleCollection(note.uuid); }}
                    disabled={isLoadingChild}
                  >
                    {isLoadingChild ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : isExpanded ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                    <span>{isExpanded ? '收起' : '展开'}</span>
                  </button>
                )}
              </div>

              {/* 子笔记列表 */}
              {isExpanded && children.length > 0 && (
                <div className="child-notes">
                  {children.map((child) => {
                    const childAtLimit = selectedIds.size >= PDF_EXPORT_MAX_COUNT && !selectedIds.has(child.uuid);
                    return (
                      <div key={child.uuid} className={`child-note-item ${selectedIds.has(child.uuid) ? 'selected' : ''} ${childAtLimit ? 'disabled' : ''}`}>
                        <label className="note-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(child.uuid)}
                            onChange={() => toggleSelect(child.uuid)}
                            disabled={childAtLimit}
                          />
                        </label>
                        <div className="note-content" onClick={() => !childAtLimit && toggleSelect(child.uuid)}>
                          <span className="note-title">{child.title}</span>
                          {child.digest && <p className="note-digest">{child.digest}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {isExpanded && children.length === 0 && !isLoadingChild && (
                <div className="child-notes-empty">
                  <span>暂无子笔记</span>
                </div>
              )}
            </div>
          );
        })}

        {/* 加载更多 */}
        {nextHint && (
          <div className="load-more">
            <button onClick={loadMore} className="btn-outline" disabled={listLoading}>
              {listLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  加载中...
                </>
              ) : (
                '加载更多'
              )}
            </button>
          </div>
        )}

        {/* 空状态（PRD 第 12 节：空列表/搜索无结果） */}
        {!listLoading && filteredNotes.length === 0 && !listError && (
          <div className="empty-state">
            <FileText size={48} strokeWidth={1} />
            <p>{searchQuery ? '没有匹配的笔记，请清空搜索重试' : '暂无笔记'}</p>
          </div>
        )}

        {/* 首次加载 */}
        {listLoading && notes.length === 0 && (
          <div className="notes-export-loading">
            <Loader2 size={24} className="animate-spin" />
            <p>加载笔记列表...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesExportPage;
