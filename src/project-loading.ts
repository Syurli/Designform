import './project-loading.css';

/** 服务没有逐文件进度时，读取阶段保持不确定；后续只报告真正进入的界面阶段。 */
export type ProjectLoadingStage = 'files' | 'categories' | 'content' | 'interface';
const stages: { id: ProjectLoadingStage; label: string }[] = [
  { id: 'files', label: '读取项目文件' },
  { id: 'categories', label: '准备分类目录' },
  { id: 'content', label: '准备文档内容' },
  { id: 'interface', label: '显示项目界面' },
];

export interface ProjectLoadingTask {
  /** 取消只阻止后续打开，不宣称中止已经发出的磁盘读取。 */
  readonly signal: AbortSignal;
  setTitle(name: string): void;
  stage(stage: ProjectLoadingStage, detail?: string): void;
  setCancellable(value: boolean): void;
  throwIfCancelled(): void;
  /** 等待请求时可立即取消，迟到的请求结果不会继续打开项目。 */
  wait<T>(work: Promise<T>): Promise<T>;
  /** 给浏览器一次绘制机会，不用计时器编造进度。 */
  paint(): Promise<void>;
  finish(): void;
  cancel(): void;
}

let current: ProjectLoadingTask | undefined;
/** 项目库、启动恢复及文档工作台共用一个任务，避免重复打开和叠加进度面板。 */
export function currentProjectLoading() { return current; }

/** 已有项目正在打开时返回空值，调用者应直接忽略重复入口。 */
export function beginProjectLoading(name: string, options: { cancellable?: boolean; onCancel?(): void } = {}): ProjectLoadingTask | undefined {
  if (current) return undefined;
  const controller = new AbortController(), prior = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog'); dialog.className = 'project-loading-dialog'; dialog.setAttribute('aria-label', '项目载入进度');
  const panel = document.createElement('section'); panel.className = 'project-loading-panel';
  const heading = document.createElement('h2'); heading.textContent = '正在打开项目';
  const project = document.createElement('p'); project.className = 'project-loading-name';
  const status = document.createElement('p'); status.className = 'project-loading-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const bar = document.createElement('progress'); bar.max = stages.length; bar.setAttribute('aria-label', '已完成载入阶段');
  const list = document.createElement('ol'); list.className = 'project-loading-stages';
  const rows = stages.map((stage, index) => { const row = document.createElement('li'); row.dataset.stage = stage.id; const number = document.createElement('span'); number.textContent = String(index + 1); row.append(number, document.createTextNode(stage.label)); list.append(row); return row; });
  const detail = document.createElement('p'); detail.className = 'project-loading-detail';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消打开';
  panel.append(heading, project, status, bar, list, detail, cancel); dialog.append(panel);
  let closed = false, cancellable = options.cancellable !== false, activeIndex = 0;
  const close = () => {
    if (closed) return; closed = true;
    dialog.close(); dialog.remove();
    if (current === task) { current = undefined; window.dispatchEvent(new CustomEvent('cewen:project-loading-change')); }
    // 模态结束后恢复原入口；若项目库已经隐藏，不把焦点送回隐藏的界面。
    if (prior?.isConnected && !prior.closest('[hidden]')) prior.focus({ preventScroll: true });
  };
  const task: ProjectLoadingTask = {
    signal: controller.signal,
    setTitle(value) { if (closed) return; project.textContent = value || '本地项目'; project.title = project.textContent; },
    stage(value, message) {
      if (closed || controller.signal.aborted) return;
      const next = stages.findIndex(stage => stage.id === value); if (next < activeIndex) return; activeIndex = next;
      rows.forEach((row, index) => { row.classList.toggle('is-complete', index < next); row.classList.toggle('is-current', index === next); if (index === next) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current'); });
      status.textContent = `${stages[next].label} · 第 ${next + 1} / ${stages.length} 阶段`;
      if (value === 'files') { bar.removeAttribute('value'); bar.setAttribute('aria-valuetext', '正在读取，进度尚未确定'); }
      else { bar.value = next; bar.setAttribute('aria-valuetext', `已完成 ${next} / ${stages.length} 个阶段`); }
      detail.textContent = message ?? (value === 'files' ? '正在读取与核对项目文件…' : ''); detail.title = detail.textContent;
    },
    setCancellable(value) { if (closed) return; cancellable = value; cancel.hidden = !value; },
    throwIfCancelled() { if (controller.signal.aborted) throw new DOMException('已取消打开项目', 'AbortError'); },
    wait<T>(work: Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new DOMException('已取消打开项目', 'AbortError')); };
        const cleanup = () => controller.signal.removeEventListener('abort', abort);
        controller.signal.addEventListener('abort', abort, { once: true });
        // 始终消费原请求的结果或错误，取消之后也不会产生未处理的 Promise 拒绝。
        work.then(value => { cleanup(); controller.signal.aborted ? reject(new DOMException('已取消打开项目', 'AbortError')) : resolve(value); }, error => { cleanup(); reject(error); });
        if (controller.signal.aborted) abort();
      });
    },
    paint() { return new Promise<void>(resolve => { requestAnimationFrame(() => { setTimeout(resolve, 0); }); }); },
    finish: close,
    cancel() { if (closed || !cancellable) return; controller.abort(); close(); options.onCancel?.(); },
  };
  current = task; task.setTitle(name); task.stage('files'); task.setCancellable(cancellable);
  cancel.onclick = () => task.cancel();
  // 载入期间快捷键只留在模态内，不让后方工作台执行保存、切页或新建。
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.oncancel = event => { event.preventDefault(); event.stopPropagation(); task.cancel(); };
  document.body.append(dialog); dialog.showModal();
  window.dispatchEvent(new CustomEvent('cewen:project-loading-change'));
  return task;
}
