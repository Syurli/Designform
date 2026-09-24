import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';

export type TutorialTarget = string;
export type TutorialStep = {
  id: string;
  target?: TutorialTarget;
  title: string;
  description: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  waitFor?: TutorialTarget;
  optional?: boolean;
  before?: () => void | Promise<void>;
};
export type TutorialDefinition = {
  id: string;
  version: number;
  title: string;
  steps: TutorialStep[];
};
type TutorialProgress = { version: number; status: 'completed' | 'skipped'; step: number; updatedAt: string };

const STORAGE_KEY = 'cewen-tutorial-progress-v1';
const targetSelector = (target: string) => `[data-tutorial="${CSS.escape(target)}"]`;

function loadProgress(): Record<string, TutorialProgress> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); } catch { return {}; }
}
function saveProgress(value: Record<string, TutorialProgress>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* 教程进度不影响策划正文。 */ }
}
async function waitForTarget(target: string, timeout = 3000) {
  const selector = targetSelector(target);
  const existing = document.querySelector<HTMLElement>(selector);
  if (existing) return existing;
  return new Promise<HTMLElement | null>(resolve => {
    const observer = new MutationObserver(() => { const found = document.querySelector<HTMLElement>(selector); if (found) { observer.disconnect(); clearTimeout(timer); resolve(found); } });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

/**
 * 教程业务层：教程数据、进度与宿主行为属于策问；Driver.js 只负责 DOM spotlight/popover。
 * 未来 Babylon 项目可以保留 Definition/Progress，并替换为 BabylonAdapter。
 */
export class TutorialManager {
  private current?: TutorialDefinition;
  private currentStep = 0;
  private instance?: Driver;

  constructor(private definitions: TutorialDefinition[], private announce?: (message: string) => void) {}

  available() { return this.definitions.map(({ id, version, title, steps }) => ({ id, version, title, steps: steps.length, progress: loadProgress()[id] })); }
  shouldAutoStart(id: string) {
    const tutorial = this.definitions.find(item => item.id === id), progress = loadProgress()[id];
    return Boolean(tutorial && (!progress || progress.version < tutorial.version));
  }
  reset(id?: string) {
    const progress = loadProgress();
    if (id) delete progress[id]; else Object.keys(progress).forEach(key => delete progress[key]);
    saveProgress(progress);
  }

  async start(id: string, from = 0) {
    const tutorial = this.definitions.find(item => item.id === id);
    if (!tutorial) return;
    this.instance?.destroy();
    this.current = tutorial;
    this.currentStep = Math.max(0, Math.min(from, tutorial.steps.length - 1));
    const steps: DriveStep[] = [];
    for (const step of tutorial.steps) {
      const target = step.waitFor ?? step.target;
      if (target && !document.querySelector(targetSelector(target)) && step.optional) continue;
      steps.push({
        element: step.target ? targetSelector(step.target) : undefined,
        popover: { title: step.title, description: step.description, side: step.side, align: step.align },
        onHighlightStarted: async () => { if (step.before) await step.before(); if (target) await waitForTarget(target); },
      });
    }
    if (!steps.length) return;
    const manager = this;
    this.instance = driver({
      steps,
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      nextBtnText: '下一步',
      prevBtnText: '上一步',
      doneBtnText: '完成',
      allowClose: true,
      overlayClickBehavior: 'close',
      stagePadding: 7,
      stageRadius: 8,
      popoverClass: 'cewen-tutorial-popover',
      onPopoverRender(popover, { config, state }) {
        const footer = popover.footer;
        if (!footer.querySelector('[data-tutorial-skip]')) {
          const skip = document.createElement('button');
          skip.type = 'button'; skip.className = 'driver-popover-btn cewen-tutorial-skip'; skip.dataset.tutorialSkip = 'true'; skip.textContent = '跳过教程';
          skip.onclick = () => manager.finish('skipped');
          const fast = document.createElement('button');
          fast.type = 'button'; fast.className = 'driver-popover-btn cewen-tutorial-fast'; fast.dataset.tutorialFast = 'true'; fast.textContent = '快进';
          fast.title = '跳到最后一步';
          fast.onclick = () => { const count = config.steps?.length ?? 1; manager.instance?.drive(Math.max(0, count - 1)); };
          popover.footerButtons.prepend(skip, fast);
        }
        manager.currentStep = state.activeIndex ?? manager.currentStep;
      },
      onDestroyed: () => {
        if (!manager.current) return;
        const progress = loadProgress()[manager.current.id];
        if (!progress || progress.version < manager.current.version) manager.finish('skipped', false);
      },
      onNextClick: () => {
        const active = manager.instance?.getActiveIndex() ?? 0;
        if (active >= steps.length - 1) manager.finish('completed'); else manager.instance?.moveNext();
      },
      onPrevClick: () => manager.instance?.movePrevious(),
    });
    this.instance.drive(this.currentStep);
    this.announce?.(`已开始“${tutorial.title}”，可随时跳过或快进。`);
  }

  finish(status: 'completed' | 'skipped', destroy = true) {
    if (!this.current) return;
    const progress = loadProgress();
    progress[this.current.id] = { version: this.current.version, status, step: this.currentStep, updatedAt: new Date().toISOString() };
    saveProgress(progress);
    const title = this.current.title;
    this.current = undefined;
    if (destroy) this.instance?.destroy();
    this.instance = undefined;
    this.announce?.(status === 'completed' ? `已完成“${title}”。` : `已跳过“${title}”，可从帮助菜单重新开始。`);
  }
}
