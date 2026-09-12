import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  Edit3,
  Eye,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
} from "lucide-react";
import { askConfirm } from "../../lib/dialogs";
import { readInitialPath } from "../../lib/filePathState";
import { runTaskQueue } from "../../lib/taskQueue";
import { DeviceService } from "../../services/deviceService";
import type { FileEntry, QueueItemResult } from "../../types";
import type { QueueProgress } from "../../lib/taskQueue";
import { Button } from "../ui/Button";

interface Props {
  serial: string;
  setStatusText: (text: string) => void;
  disabled?: boolean;
}

type SortKey = "name" | "size" | "modified";

function baseName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function childPath(directory: string, name: string) {
  return `${directory.replace(/\/+$/, "") || "/"}/${name}`.replace(/^\/\//, "/");
}

function failedResult<T>(result: QueueItemResult<T, unknown>) {
  return result.status !== "fulfilled" || (
    typeof result.value === "object" && result.value !== null && "success" in result.value
      && !Boolean((result.value as { success: boolean }).success)
  );
}

export function FileExplorer({ serial, setStatusText, disabled = false }: Props) {
  const [path, setPath] = useState(() => readInitialPath(serial));
  const [pathDraft, setPathDraft] = useState(() => readInitialPath(serial));
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<string[]>(["/sdcard", "/sdcard/Download", "/data/local/tmp"]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [taskSummary, setTaskSummary] = useState("");
  const [transferProgress, setTransferProgress] = useState<QueueProgress<unknown, unknown> | null>(null);
  const [clipboard, setClipboard] = useState<{ mode: "copy" | "cut"; paths: string[] } | null>(null);
  const [editor, setEditor] = useState<{ path: string; content: string } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const transferHandle = useRef<{ cancel: () => void } | null>(null);
  const retryHandle = useRef<(() => void) | null>(null);
  const [transferActive, setTransferActive] = useState(false);
  const [retryReady, setRetryReady] = useState(false);

  useEffect(() => () => {
    transferHandle.current?.cancel();
    transferHandle.current = null;
  }, [serial]);

  const failedValue = (value: unknown) => Boolean(value && typeof value === "object" && "success" in value && !(value as { success: boolean }).success);
  const progressText = (label: string, progress: QueueProgress<unknown, unknown>, startedAt: number, succeeded: number, failed: number) => {
    const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
    const current = progress.item && typeof progress.item === "object" && "name" in progress.item
      ? String((progress.item as { name: string }).name)
      : progress.item ? String(progress.item) : "等待任务";
    const speed = progress.completed > 0 ? `${(progress.completed / elapsed).toFixed(1)} 项/秒` : "计算中";
    return `${label} ${progress.completed}/${progress.total} · 进行中 ${progress.active} · 成功 ${succeeded} · 失败 ${failed} · ${speed} · 当前 ${current}`;
  };

  const load = async (nextPath = path, pushHistory = false) => {
    if (disabled) return;
    setBusy(true);
    try {
      const entries = await DeviceService.listFilesResult(serial, nextPath);
      setFiles(entries);
      setPath(nextPath);
      setPathDraft(nextPath);
      setSelected([]);
      if (pushHistory && history[historyIndex] !== nextPath) {
        const nextHistory = [...history.slice(0, historyIndex + 1), nextPath].slice(-30);
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
      }
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`rdc.files.bookmarks.${serial}`);
      if (saved) {
        const parsed = JSON.parse(saved) as unknown;
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) setBookmarks(parsed);
      }
      const initial = readInitialPath(serial);
      setHistory([initial]);
      setHistoryIndex(0);
    } catch {
      setHistory(["/sdcard"]);
      setHistoryIndex(0);
    }
  }, [serial]);

  useEffect(() => {
    if (!disabled) void load(path);
  }, [serial, disabled]);

  useEffect(() => {
    try {
      localStorage.setItem(`rdc.files.bookmarks.${serial}`, JSON.stringify(bookmarks));
      sessionStorage.setItem(`rdc.files.path.${serial}`, path);
    } catch {
      /* persistence is optional */
    }
  }, [serial, bookmarks, path]);

  const visibleFiles = useMemo(() => files
    .filter((file) => !query.trim() || file.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice()
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const left = sortKey === "size" ? Number(a.size) || 0 : sortKey === "modified" ? a.modified : a.name.toLowerCase();
      const right = sortKey === "size" ? Number(b.size) || 0 : sortKey === "modified" ? b.modified : b.name.toLowerCase();
      const result = left < right ? -1 : left > right ? 1 : 0;
      return sortAsc ? result : -result;
    }), [files, query, sortKey, sortAsc]);

  const selectedEntries = files.filter((file) => selected.includes(file.path));

  const go = (nextPath: string) => {
    const next = nextPath.trim() || "/";
    void load(next, true);
  };

  const goBack = () => {
    if (historyIndex <= 0) return;
    const next = historyIndex - 1;
    setHistoryIndex(next);
    void load(history[next]);
  };

  const goForward = () => {
    if (historyIndex >= history.length - 1) return;
    const next = historyIndex + 1;
    setHistoryIndex(next);
    void load(history[next]);
  };

  const runSelected = async (
    label: string,
    worker: (entry: FileEntry) => Promise<unknown>,
    entries = selectedEntries,
  ) => {
    if (!entries.length) {
      setStatusText("请先选择文件或文件夹");
      return;
    }
    setBusy(true);
    setTaskSummary(`${label} 0/${entries.length}`);
    const startedAt = performance.now();
    let succeeded = 0;
    let failed = 0;
    const handle = runTaskQueue<FileEntry, unknown>(
      entries,
      async (entry, index) => {
        setTaskSummary(`${label} ${index + 1}/${entries.length} · 当前 ${entry.name}`);
        return worker(entry);
      },
      {
        concurrency: 2,
        onProgress: (progress) => {
          const typed = progress as QueueProgress<FileEntry, unknown>;
          if (typed.result) {
            if (typed.result.status === "fulfilled" && !failedValue(typed.result.value)) succeeded += 1;
            else failed += 1;
          }
          setTransferProgress(typed);
          setTaskSummary(progressText(label, typed as QueueProgress<unknown, unknown>, startedAt, succeeded, failed));
        },
      },
    );
    transferHandle.current = handle;
    setTransferActive(true);
    try {
      const result = await handle.done;
      const failed = result.results.filter(failedResult).map((item) => item.item);
      const summaryText = `${label}：完成 ${entries.length - failed.length}，失败 ${failed.length}${result.cancelled ? "，已取消" : ""}`;
      setTaskSummary(summaryText);
      setStatusText(summaryText);
      if (failed.length > 0) {
        retryHandle.current = () => { void runSelected(label, worker, failed); };
      } else {
        retryHandle.current = null;
      }
      setRetryReady(failed.length > 0);
    } finally {
      transferHandle.current = null;
      setTransferActive(false);
      setTransferProgress(null);
      setBusy(false);
    }
    await load(path);
  };

  const uploadPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setTaskSummary(`上传 0/${paths.length}`);
    const startedAt = performance.now();
    let succeeded = 0;
    let failed = 0;
    const handle = runTaskQueue<string, unknown>(paths, async (local, index) => {
      setTaskSummary(`上传 ${index + 1}/${paths.length}`);
      return DeviceService.uploadFile(serial, local, childPath(path, baseName(local)));
    }, {
      concurrency: 2,
      onProgress: (progress) => {
        const typed = progress as QueueProgress<string, unknown>;
        if (typed.result) {
          if (typed.result.status === "fulfilled" && !failedValue(typed.result.value)) succeeded += 1;
          else failed += 1;
        }
        setTransferProgress(typed);
        const current = typed.item ? baseName(String(typed.item)) : "等待任务";
        setTaskSummary(`${progressText("上传", { ...typed, item: current }, startedAt, succeeded, failed)}`);
      },
    });
    transferHandle.current = handle;
    setTransferActive(true);
    try {
      const result = await handle.done;
      const failedPaths = result.results.filter(failedResult).map((item) => item.item as unknown as string);
      const failed = failedPaths.length;
      setTaskSummary(`上传完成：成功 ${paths.length - failed}，失败 ${failed}${result.cancelled ? "，已取消" : ""}`);
      if (failedPaths.length > 0) {
        retryHandle.current = () => { void uploadPaths(failedPaths); };
      } else {
        retryHandle.current = null;
      }
      setRetryReady(failed > 0);
    } finally {
      transferHandle.current = null;
      setTransferActive(false);
      setTransferProgress(null);
      setBusy(false);
    }
    await load(path);
  };

  const upload = async (directory: boolean) => {
    if (disabled) return;
    const picked = await open({ multiple: !directory, directory });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    await uploadPaths(paths);
  };

  const dropUpload = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled || busy) return;
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path || "")
      .filter(Boolean);
    if (!paths.length) {
      setStatusText("拖放上传需要桌面版文件路径权限，请使用文件选择按钮");
      return;
    }
    await uploadPaths(paths);
  };

  const download = async (entries = selectedEntries, targetOverride?: string) => {
    if (!entries.length) {
      setStatusText("请先选择文件或文件夹");
      return;
    }
    const target = targetOverride || await open({ directory: true, multiple: false });
    if (typeof target !== "string" || !target) return;
    setBusy(true);
    const startedAt = performance.now();
    let succeeded = 0;
    let failed = 0;
    const handle = runTaskQueue<FileEntry, unknown>(entries, (entry) =>
      DeviceService.downloadFile(serial, entry.path, target), {
        concurrency: 2,
        onProgress: (progress) => {
          const typed = progress as QueueProgress<FileEntry, unknown>;
          if (typed.result) {
            if (typed.result.status === "fulfilled" && !failedValue(typed.result.value)) succeeded += 1;
            else failed += 1;
          }
          setTransferProgress(typed);
          setTaskSummary(progressText("下载", typed as QueueProgress<unknown, unknown>, startedAt, succeeded, failed));
        },
      });
    transferHandle.current = handle;
    setTransferActive(true);
    try {
      const result = await handle.done;
      const failedEntries = result.results.filter(failedResult).map((item) => item.item);
      const failed = failedEntries.length;
      setTaskSummary(`下载完成：成功 ${entries.length - failed}，失败 ${failed}${result.cancelled ? "，已取消" : ""}`);
      setStatusText(`下载：完成 ${entries.length - failed}，失败 ${failed}${result.cancelled ? "，已取消" : ""}`);
      if (failedEntries.length > 0) {
        retryHandle.current = () => { void download(failedEntries, target); };
      } else {
        retryHandle.current = null;
      }
      setRetryReady(failed > 0);
    } finally {
      transferHandle.current = null;
      setTransferActive(false);
      setTransferProgress(null);
      setBusy(false);
    }
  };

  const paste = async (pending = clipboard) => {
    if (!pending?.paths.length) return;
    const sources = pending.paths.map((source) => ({
      name: baseName(source),
      path: source,
      isDir: false,
      size: "0",
      permissions: "",
      modified: "",
    }));
    setBusy(true);
    const startedAt = performance.now();
    let succeeded = 0;
    let failed = 0;
    const handle = runTaskQueue<FileEntry, unknown>(sources, (source) => {
      const target = childPath(path, source.name);
      return pending.mode === "copy"
        ? DeviceService.copyRemote(serial, source.path, target)
        : DeviceService.moveRemote(serial, source.path, target);
    }, {
      concurrency: 2,
      onProgress: (progress) => {
        const typed = progress as QueueProgress<FileEntry, unknown>;
        if (typed.result) {
          if (typed.result.status === "fulfilled" && !failedValue(typed.result.value)) succeeded += 1;
          else failed += 1;
        }
        setTransferProgress(typed);
        setTaskSummary(progressText("粘贴", typed as QueueProgress<unknown, unknown>, startedAt, succeeded, failed));
      },
    });
    transferHandle.current = handle;
    setTransferActive(true);
    try {
      const result = await handle.done;
      const failedSources = result.results.filter(failedResult).map((item) => item.item);
      const failed = failedSources.length;
      setTaskSummary(`粘贴完成：成功 ${sources.length - failed}，失败 ${failed}${result.cancelled ? "，已取消" : ""}`);
      if (failedSources.length > 0) {
        const failedPending = { ...pending, paths: failedSources.map((source) => source.path) };
        retryHandle.current = () => { void paste(failedPending); };
      } else {
        retryHandle.current = null;
      }
      setRetryReady(failed > 0);
    } finally {
      transferHandle.current = null;
      setTransferActive(false);
      setTransferProgress(null);
      setClipboard(null);
      setBusy(false);
    }
    await load(path);
  };

  const edit = async (entry: FileEntry) => {
    setEditorBusy(true);
    try {
      const result = await DeviceService.readRemote(serial, entry.path);
      if (!result.success) throw new Error(result.stderr || result.stdout || "读取文件失败");
      setEditor({ path: entry.path, content: result.stdout });
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorBusy(false);
    }
  };

  const previewFile = async (entry: FileEntry) => {
    setEditorBusy(true);
    try {
      const result = await DeviceService.readRemote(serial, entry.path);
      if (!result.success) throw new Error(result.stderr || result.stdout || "读取文件失败");
      setPreview({ path: entry.path, content: result.stdout });
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    setEditorBusy(true);
    const result = await DeviceService.writeRemote(serial, editor.path, editor.content);
    setEditorBusy(false);
    if (!result.success) {
      setStatusText(result.stderr || result.stdout || "保存文件失败");
      return;
    }
    setEditor(null);
    setStatusText("文件已保存");
  };

  const up = () => go(path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");

  return (
    <div className="file-explorer module" aria-label="设备文件管理器" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropUpload(event)}>
      <div className="module-head file-explorer-head">
        <div className="row file-explorer-navigation">
          <Button size="sm" variant="ghost" disabled={historyIndex <= 0 || busy} onClick={goBack}><ChevronLeft size={14} /></Button>
          <Button size="sm" variant="ghost" disabled={historyIndex >= history.length - 1 || busy} onClick={goForward}><ChevronRight size={14} /></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={up}>上级</Button>
          <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && go(pathDraft)} aria-label="远端路径" />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(path)}><RefreshCw size={14} /></Button>
        </div>
        <div className="row file-explorer-tools">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选当前目录" aria-label="筛选当前目录" />
          <Button size="sm" disabled={busy || disabled} onClick={() => void upload(false)}><Upload size={13} />文件</Button>
          <Button size="sm" disabled={busy || disabled} onClick={() => void upload(true)}><FolderOpen size={13} />目录</Button>
          <Button size="sm" disabled={disabled || busy || !selectedEntries.length} onClick={() => void download()}><Download size={13} />下载</Button>
          {transferActive && <Button size="sm" variant="ghost" onClick={() => transferHandle.current?.cancel()}>取消传输</Button>}
          {retryReady && retryHandle.current && <Button size="sm" variant="ghost" disabled={busy || disabled} onClick={() => { setRetryReady(false); retryHandle.current?.(); }}>重试失败</Button>}
        </div>
      </div>

      <div className="file-explorer-body">
        <aside className="file-explorer-sidebar">
          <div className="file-explorer-sidebar-title">快速访问</div>
          {bookmarks.map((bookmark) => (
            <button key={bookmark} type="button" className={bookmark === path ? "active" : ""} onClick={() => go(bookmark)}>{bookmark}</button>
          ))}
          <button type="button" onClick={() => setBookmarks((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])}>
            {bookmarks.includes(path) ? "移除收藏" : "收藏当前目录"}
          </button>
        </aside>
        <section className="file-explorer-list">
          <div className="file-explorer-list-toolbar">
            <label>
              <input
                type="checkbox"
                checked={visibleFiles.length > 0 && visibleFiles.every((file) => selected.includes(file.path))}
                onChange={() => setSelected((current) =>
                  visibleFiles.every((file) => current.includes(file.path))
                    ? current.filter((item) => !visibleFiles.some((file) => file.path === item))
                    : [...new Set([...current, ...visibleFiles.map((file) => file.path)])],
                )}
              />
              全选
            </label>
            <span className="muted">{selectedEntries.length ? `已选 ${selectedEntries.length}` : `${visibleFiles.length} 项`}</span>
            <Button size="sm" variant="ghost" disabled={disabled || busy || !selectedEntries.length} onClick={() => setClipboard({ mode: "copy", paths: selectedEntries.map((entry) => entry.path) })}><Copy size={13} />复制</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy || !selectedEntries.length} onClick={() => setClipboard({ mode: "cut", paths: selectedEntries.map((entry) => entry.path) })}><Scissors size={13} />剪切</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy || !clipboard?.paths.length} onClick={() => void paste()}><Clipboard size={13} />粘贴</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy || selectedEntries.length !== 1} onClick={async () => {
              const entry = selectedEntries[0];
              const name = prompt("新名称", entry.name);
              if (!name || name === entry.name) return;
              const result = await DeviceService.moveRemote(serial, entry.path, childPath(path, name));
              setStatusText(result.success ? "已重命名" : result.stderr || result.stdout || "重命名失败");
              await load(path);
            }}><Edit3 size={13} />重命名</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy || !selectedEntries.length} onClick={async () => {
              if (!(await askConfirm(`确定删除已选 ${selectedEntries.length} 项吗？`))) return;
              await runSelected("删除", (entry) => DeviceService.deleteRemotePath(serial, entry.path));
            }}><Trash2 size={13} />删除</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={async () => {
              const name = prompt("文件夹名称");
              if (!name) return;
              const result = await DeviceService.mkdir(serial, childPath(path, name));
              setStatusText(result.success ? "文件夹已创建" : result.stderr || result.stdout || "创建失败");
              await load(path);
            }}><FolderPlus size={13} />新建文件夹</Button>
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={async () => {
              const name = prompt("文件名称");
              if (!name) return;
              const result = await DeviceService.writeRemote(serial, childPath(path, name), "");
              setStatusText(result.success ? "文件已创建" : result.stderr || result.stdout || "创建失败");
              await load(path);
            }}><FilePlus2 size={13} />新建文件</Button>
          </div>
          <div className="file-explorer-columns">
            <span />
            <button type="button" onClick={() => sortKey === "name" ? setSortAsc((value) => !value) : (setSortKey("name"), setSortAsc(true))}>名称 {sortKey === "name" ? (sortAsc ? "↑" : "↓") : ""}</button>
            <button type="button" onClick={() => sortKey === "size" ? setSortAsc((value) => !value) : (setSortKey("size"), setSortAsc(true))}>大小 {sortKey === "size" ? (sortAsc ? "↑" : "↓") : ""}</button>
            <button type="button" onClick={() => sortKey === "modified" ? setSortAsc((value) => !value) : (setSortKey("modified"), setSortAsc(true))}>修改时间 {sortKey === "modified" ? (sortAsc ? "↑" : "↓") : ""}</button>
            <span>操作</span>
          </div>
          <div className="file-explorer-scroll">
            {visibleFiles.length ? visibleFiles.map((entry) => (
              <div className={`file-explorer-row ${selected.includes(entry.path) ? "selected" : ""}`} key={entry.path}>
                <input type="checkbox" checked={selected.includes(entry.path)} onChange={() => setSelected((current) => current.includes(entry.path) ? current.filter((item) => item !== entry.path) : [...current, entry.path])} />
                <button type="button" className="file-explorer-name" onDoubleClick={() => entry.isDir && go(entry.path)} onClick={() => setSelected((current) => current.includes(entry.path) ? current : [...current, entry.path])}>
                  <span className={entry.isDir ? "file-icon directory" : "file-icon"}>{entry.isDir ? "DIR" : "FILE"}</span>{entry.name}
                </button>
                <span className="mono muted">{entry.isDir ? "—" : entry.size}</span>
                <span className="muted">{entry.modified || "—"}</span>
                <div className="row file-explorer-row-actions">
                  {entry.isDir ? <Button size="sm" variant="ghost" onClick={() => go(entry.path)}>打开</Button> : <>
                    <Button size="sm" variant="ghost" disabled={busy || editorBusy} onClick={() => void previewFile(entry)}><Eye size={13} />预览</Button>
                    <Button size="sm" variant="ghost" disabled={busy || editorBusy} onClick={() => void edit(entry)}><Edit3 size={13} />编辑</Button>
                  </>}
                </div>
              </div>
            )) : <div className="empty-state">{busy ? "正在读取…" : query ? "没有匹配项" : "目录为空"}</div>}
          </div>
        </section>
      </div>

      {taskSummary && <div className="file-task-status"><span>{taskSummary}</span>{transferProgress && <progress className="file-task-progress-bar" value={transferProgress.completed} max={Math.max(1, transferProgress.total)} aria-label="传输进度" />}<button type="button" onClick={() => setTaskSummary("")}>×</button></div>}
      {editor && (
        <div className="file-editor-overlay">
          <div className="file-editor-dialog module">
            <div className="module-head"><strong>{editor.path}</strong><Button size="sm" variant="ghost" onClick={() => setEditor(null)}>关闭</Button></div>
            <textarea value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} spellCheck={false} />
            <div className="row" style={{ justifyContent: "flex-end", padding: 8 }}><Button variant="primary" loading={editorBusy} onClick={() => void saveEditor()}>保存</Button></div>
          </div>
        </div>
      )}
      {preview && (
        <div className="file-editor-overlay" role="dialog" aria-modal="true" aria-label="文件预览">
          <div className="file-preview-dialog module">
            <div className="module-head"><strong>{preview.path}</strong><Button size="sm" variant="ghost" onClick={() => setPreview(null)}>关闭</Button></div>
            <pre className="file-preview-content">{preview.content || "（文件为空）"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
