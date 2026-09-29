import './icon-interaction.css';

/** 图标仅在进入所在控件时播放一次；空闲保持原来的细线样式，不持续摇晃。 */
export function installIconInteractions() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const control = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('button,a,[role="button"]') : null;
  const animate = (element: HTMLElement | null) => {
    if (!element || reduced.matches || element.matches(':disabled,[aria-disabled="true"]')) return;
    // 分类栏有自己的抽出与图钉动画，避免两套变换叠加。
    if (element.closest('.project-directory')) return;
    const svg = element.querySelector<SVGElement>('svg'); if (!svg) return;
    const classes = svg.getAttribute('class') ?? '';
    const kind = /orbit/.test(classes) ? 'orbit' : /layout-grid|grid-2x2/.test(classes) ? 'grid' : /arrow-up-down|arrow-down-up/.test(classes) ? 'sort' : /pin|star|lock/.test(classes) ? 'tilt' : 'nudge';
    element.dataset.iconMotion = kind;
    element.classList.remove('icon-motion-active');
    // 重入控件可以重播，移出后的下一帧仍回到静止姿态。
    void svg.getBoundingClientRect(); element.classList.add('icon-motion-active');
  };
  document.addEventListener('pointerover', event => {
    const element = control(event.target);
    if (element && !(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) animate(element);
  });
  document.addEventListener('pointerout', event => {
    const element = control(event.target);
    if (element && !(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) element.classList.remove('icon-motion-active');
  });
  document.addEventListener('focusin', event => animate(control(event.target)));
  document.addEventListener('focusout', event => control(event.target)?.classList.remove('icon-motion-active'));
}
