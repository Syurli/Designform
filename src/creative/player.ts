import type { ProjectSnapshot } from '../../shared/model';
import type { CreativeIndex } from '../../shared/creative/model';
import { asString, asRows, asNumber } from '../../shared/creative/model';
import { buildCreativeIndex } from '../../shared/creative/content';
import { compileSequence, timeLabel, type PlaybackPlan, type AudioCue } from '../../shared/creative/sequence';
import { changeShotDuration, TapTimingSession, type TimingPreview } from '../../shared/creative/timing';
import { creativeAction, acquireMediaUrl } from '../project-client';
import { h } from './render';

export function downloadText(name: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** 排演只读冻结计划；媒体仅加载播放位置附近。编辑时间必须先预览、后明确保存。 */
export class AnimaticPlayer {
  private plan: PlaybackPlan;
  private time = 0; private base = 0; private started = 0; private playing = false;
  private speed = 1; private raf = 0; private frame = -1; private muted = false;
  private loop = false; private loopStart = 0; private loopEnd = 0; private disposed = false;
  private sounds = new Map<string, HTMLAudioElement>();
  private urls = new Map<string, { url: string; release: () => void }>();
  private loading = new Map<string, Promise<string>>();
  private loadingSounds = new Set<string>(); private blockedSounds = new Set<string>();
  private playPromises = new Set<string>(); private ticks = 0;
  private recording?: TapTimingSession; private timingDialog?: HTMLDialogElement;
  private hidden = () => { if (document.hidden) this.pause(); };
  private blurred = () => this.pause();
  constructor(private host: HTMLElement, private snapshot: ProjectSnapshot, private index: CreativeIndex, sequenceId: string) {
    this.plan = compileSequence(index, sequenceId); this.loopEnd = this.plan.durationMs;
    this.render(); this.paint(); document.addEventListener('visibilitychange', this.hidden); window.addEventListener('blur', this.blurred);
  }
  private render() {
    this.host.innerHTML = `<section class="animatic" data-tutorial="animatic-player"><header><div><small>二维分镜排演 · 冻结修订 ${h(this.snapshot.revisionLabel ?? this.snapshot.revision)}</small><h2>${h(this.plan.sequence.title)}</h2></div><select data-mode aria-label="观看布局"><option value="review">审阅模式</option><option value="cinema">观影模式</option><option value="dialogue">台词排演</option></select><button data-fullscreen>全屏</button></header>
      <div class="animatic-stage"><div class="animatic-picture"><img alt="当前分镜画面"/><div class="animatic-missing">正在准备画面</div><div class="animatic-subtitles" aria-live="off"></div></div><aside><h3 data-title></h3><p data-description></p><div data-lines></div><small>镜头描述不会作为旁白播放。台词可以跨镜持续。</small></aside></div>
      <div class="animatic-controls"><button data-play class="primary-button">播放</button><button data-prev>上一镜</button><button data-next>下一镜</button><input data-seek aria-label="播放位置" type="range" min="0" max="${this.plan.durationMs}" value="0" step="10"/><output data-clock></output><select data-speed aria-label="播放速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><label><input data-muted type="checkbox"/>静音</label><label><input data-subtitle type="checkbox" checked/>字幕</label></div>
      <div class="animatic-secondary"><label><input data-loop type="checkbox"/>循环范围</label><label>从 <input data-loop-start type="number" value="0" min="0" step="0.1"/> 秒</label><label>到 <input data-loop-end type="number" value="${this.plan.durationMs / 1000}" min="0.1" step="0.1"/> 秒</label><button data-timing ${this.snapshot.historical ? 'disabled' : ''}>调整镜头时长</button><button data-record ${this.snapshot.historical ? 'disabled' : ''}>按键录制节奏</button><button data-quest>暂停并发起 Quest</button><button data-export>导出可播放 HTML 包</button></div>
      <p role="status">${h(this.plan.warnings.join('；'))}</p><div class="animatic-shot-strip">${this.shots().map(f => `<button data-jump="${f.startMs}" title="${h(f.itemId)}">${h(f.title)}<small>${timeLabel(f.startMs)}</small></button>`).join('')}</div></section>`;
    this.host.onclick = event => {
      const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return;
      if (b.hasAttribute('data-play')) { if (this.playing) this.pause(); else this.play(); }
      if (b.hasAttribute('data-prev') || b.hasAttribute('data-next')) {
        const current = this.plan.frames[this.frame], currentShot = this.shots().find(f => f.itemId === current?.itemId);
        const starts = this.shots().map(f => f.startMs);
        this.seek(b.hasAttribute('data-next') ? starts.find(t => t > this.time) ?? this.plan.durationMs : [...starts].reverse().find(t => t < (currentShot?.startMs ?? this.time) - 1) ?? 0);
      }
      if (b.hasAttribute('data-jump')) this.seek(Number(b.dataset.jump));
      if (b.hasAttribute('data-fullscreen')) {
        const el = this.host.querySelector<HTMLElement>('.animatic')!;
        void (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(err => this.message(err.message));
      }
      if (b.hasAttribute('data-export')) void this.export();
      if (b.hasAttribute('data-timing')) this.editTiming();
      if (b.hasAttribute('data-record')) this.recordTiming();
      if (b.hasAttribute('data-quest')) {
        this.pause(); const frame = this.plan.frames[this.frame], start = this.shots().find(f => f.itemId === frame?.itemId)?.startMs ?? 0;
        if (frame) window.dispatchEvent(new CustomEvent('cewen:creative-request', { detail: { action: 'quest', objectId: frame.shotId,
          anchor: { sequenceId: this.plan.sequence.id, itemId: frame.itemId, objectId: frame.shotId, shotId: frame.shotId,
            subObjectId: frame.panelId, panelId: frame.panelId, localMs: this.time - start, panelLocalMs: this.time - frame.startMs,
            sourceRevision: this.snapshot.revision, excerpt: frame.description } } }));
      }
    };
    this.host.oninput = event => { const input = event.target as HTMLInputElement; if (input.hasAttribute('data-seek')) this.seek(Number(input.value)); };
    this.host.onchange = event => {
      const input = event.target as HTMLInputElement;
      if (input.hasAttribute('data-mode')) this.host.querySelector('.animatic')!.setAttribute('data-layout', input.value);
      if (input.hasAttribute('data-speed')) { this.base = this.time; this.started = performance.now(); this.speed = Number(input.value); }
      if (input.hasAttribute('data-muted')) { this.muted = input.checked; this.sounds.forEach(a => a.muted = this.muted); }
      if (input.hasAttribute('data-subtitle')) (this.host.querySelector('.animatic-subtitles') as HTMLElement).hidden = !input.checked;
      if (input.hasAttribute('data-loop')) this.loop = input.checked;
      if (input.hasAttribute('data-loop-start')) this.loopStart = Math.max(0, Math.min(this.plan.durationMs - 1, Math.round(Number(input.value) * 1000)));
      if (input.hasAttribute('data-loop-end')) this.loopEnd = Math.max(1, Math.min(this.plan.durationMs, Math.round(Number(input.value) * 1000)));
      if (this.loop && this.loopStart >= this.loopEnd) { this.loop = false; (this.host.querySelector('[data-loop]') as HTMLInputElement).checked = false; this.message('循环终点必须晚于起点，已关闭无效循环。'); }
    };
  }
  private shots() { return this.plan.frames.filter((f, i, a) => i === 0 || f.itemId !== a[i - 1].itemId); }
  private message(text: string) { const p = this.host.querySelector('[role=status]'); if (p) p.textContent = text; }
  private mediaUrl(id: string): Promise<string> {
    if (this.urls.has(id)) return Promise.resolve(this.urls.get(id)!.url);
    const pending = this.loading.get(id); if (pending) return pending;
    const object = this.index.objects.find(x => x.object.id === id)?.object;
    if (object?.type !== 'media') return Promise.reject(new Error('素材缺失，仍可审阅文字。'));
    const load = acquireMediaUrl(this.snapshot, asString(object.data.path)).then(lease => {
      if (this.disposed) { lease.release(); throw new Error('播放器已关闭'); }
      this.urls.set(id, lease); return lease.url;
    }).finally(() => this.loading.delete(id));
    this.loading.set(id, load); return load;
  }
  private play() {
    if (this.disposed || !this.plan.durationMs) return;
    if (this.time >= this.plan.durationMs) this.time = 0;
    this.blockedSounds.clear(); this.base = this.time; this.started = performance.now(); this.playing = true;
    this.host.querySelector('[data-play]')!.textContent = '暂停'; this.prepareNearby(); this.tick();
    window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence', { detail: { name: 'sequence-played', projectId:this.snapshot.project.id, objectId: this.plan.sequence.id } }));
  }
  pause() { this.playing = false; cancelAnimationFrame(this.raf); this.sounds.forEach(a => a.pause()); const b = this.host.querySelector('[data-play]'); if (b) b.textContent = '播放'; }
  seek(time: number) {
    if (!Number.isFinite(time)) return;
    this.time = Math.max(0, Math.min(this.plan.durationMs, time)); this.base = this.time; this.started = performance.now();
    this.paint(); if (this.playing) this.prepareNearby(); this.syncAudio(true);
  }
  private tick = () => {
    if (!this.playing || this.disposed) return;
    this.time = Math.round(this.base + (performance.now() - this.started) * this.speed);
    const end = this.loop && this.loopEnd > this.loopStart ? this.loopEnd : this.plan.durationMs;
    if (this.time >= end) { if (this.loop) this.seek(this.loopStart); else { this.time = end; this.pause(); } }
    this.paint(); this.syncAudio(); if (++this.ticks % 20 === 0) this.prepareNearby();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  };
  private nearby(cue: AudioCue) { return cue.startMs < this.time + 12000 && cue.startMs + cue.durationMs - cue.offsetMs > this.time - 3000; }
  private prepareNearby() {
    const keep = new Set<string>();
    for (const f of this.plan.frames.slice(Math.max(0, this.frame - 1), this.frame + 3)) { if (f.mediaId) { keep.add(f.mediaId); void this.mediaUrl(f.mediaId).catch(() => {}); } }
    for (const cue of this.plan.audio) {
      if (!cue.mediaId || !this.nearby(cue)) {
        const old = this.sounds.get(cue.id); if (old) { old.pause(); old.removeAttribute('src'); old.load(); this.sounds.delete(cue.id); } continue;
      }
      keep.add(cue.mediaId);
      if (this.sounds.has(cue.id) || this.loadingSounds.has(cue.id) || this.loadingSounds.size >= 8) continue;
      this.loadingSounds.add(cue.id);
      void this.mediaUrl(cue.mediaId).then(url => {
        if (this.disposed || !this.nearby(cue)) return;
        const audio = new Audio(url); audio.preload = 'auto'; audio.muted = this.muted;
        audio.onerror = () => { this.blockedSounds.add(cue.id); this.message(`${cue.character} 的配音无法解码，已保留字幕。`); };
        this.sounds.set(cue.id, audio); this.syncAudio(true);
      }).catch(() => { if (!this.disposed) this.message('部分声音缺失；画面和字幕仍可播放。'); }).finally(() => this.loadingSounds.delete(cue.id));
    }
    for (const [id, lease] of this.urls) if (!keep.has(id) && !this.loading.has(id)) { lease.release(); this.urls.delete(id); }
  }
  private paint() {
    // 二分定位，长序列不每帧扫描全部画面。
    let lo = 0, hi = this.plan.frames.length - 1, at = hi;
    while (lo <= hi) { const mid = (lo + hi) >> 1, f = this.plan.frames[mid]; if (this.time < f.startMs) hi = mid - 1; else if (this.time >= f.endMs) lo = mid + 1; else { at = mid; break; } }
    const frame = this.plan.frames[at]; if (!frame) return;
    if (at !== this.frame) {
      this.frame = at; this.host.querySelector('[data-title]')!.textContent = frame.title;
      this.host.querySelector('[data-description]')!.textContent = frame.description;
      const image = this.host.querySelector('img')!, missing = this.host.querySelector<HTMLElement>('.animatic-missing')!;
      image.hidden = true; missing.hidden = false; missing.textContent = frame.mediaId ? '正在读取图片…' : '暂无图片 · ' + frame.description;
      if (frame.mediaId) void this.mediaUrl(frame.mediaId).then(url => {
        if (this.disposed || this.frame !== at) return;
        image.onload = () => { if (this.frame !== at) return; image.hidden = false; missing.hidden = true; };
        image.onerror = () => { missing.textContent = '图片无法解码，文字仍可审阅。'; }; image.src = url;
      }).catch(err => { if (this.frame === at) missing.textContent = err.message; });
    }
    const lines = this.plan.audio.filter(c => this.time >= c.startMs && this.time < c.startMs + Math.max(1, c.durationMs - c.offsetMs));
    this.host.querySelector('.animatic-subtitles')!.textContent = lines.map(l => `${l.character}：${l.text}`).join('\n');
    this.host.querySelector('[data-lines]')!.textContent = lines.map(l => `${l.character}：${l.text}`).join('\n');
    (this.host.querySelector('[data-seek]') as HTMLInputElement).value = String(this.time);
    this.host.querySelector('[data-clock]')!.textContent = `${timeLabel(this.time)} / ${timeLabel(this.plan.durationMs)}`;
  }
  private syncAudio(force = false) {
    for (const cue of this.plan.audio) {
      const audio = this.sounds.get(cue.id); if (!audio) continue;
      const elapsed = (this.time - cue.startMs + cue.offsetMs) / 1000;
      const active = this.time >= cue.startMs && this.time < cue.startMs + cue.durationMs - cue.offsetMs;
      if (!active || !this.playing) { audio.pause(); continue; }
      audio.playbackRate = this.speed;
      if (force || Math.abs(audio.currentTime - elapsed) > .1) try { audio.currentTime = Math.max(0, elapsed); } catch { /* 元数据加载后再次同步。 */ }
      if (audio.paused && !this.playPromises.has(cue.id) && !this.blockedSounds.has(cue.id)) {
        this.playPromises.add(cue.id);
        void audio.play().catch(() => { this.blockedSounds.add(cue.id); this.message('浏览器拒绝声音播放。请再次点击播放，或静音检查画面。'); }).finally(() => this.playPromises.delete(cue.id));
      }
    }
  }
  private editTiming() {
    this.pause(); const shot = this.shots().find(f => f.itemId === this.plan.frames[this.frame]?.itemId); if (!shot) return;
    const item = asRows(this.plan.sequence.data.items).find(i => i.id === shot.itemId)!;
    const dialog = this.dialog('调整镜头时长', `<p>${h(shot.title)}。只更改此序列中的出现实例，不改镜头文字或其他剪辑方案。</p><label>时长（毫秒）<input data-duration type="number" min="1" max="3600000" value="${asNumber(item.durationMs)}"/></label><label>后续处理<select data-timing-mode><option value="ripple">顺延后续画面和随镜声音</option><option value="keep-next">保持后续入点，检查重叠 / 空隙</option></select></label><button data-preview>预览变化</button>`);
    dialog.querySelector('[data-preview]')!.addEventListener('click', () => { try {
      const preview = changeShotDuration(this.plan.sequence, shot.itemId, Number(dialog.querySelector<HTMLInputElement>('[data-duration]')!.value), dialog.querySelector<HTMLSelectElement>('[data-timing-mode]')!.value as 'ripple' | 'keep-next');
      this.showTimingPreview(dialog, preview);
    } catch (e) { dialog.querySelector('[role=status]')!.textContent = (e as Error).message; } });
  }
  private dialog(title: string, body: string) {
    this.timingDialog?.close(); this.timingDialog?.remove(); const dialog = document.createElement('dialog'); this.timingDialog = dialog;
    dialog.className = 'project-dialog creative-editor'; dialog.innerHTML = `<header class="project-dialog-header"><h2>${h(title)}</h2><button data-close aria-label="关闭">×</button></header>${body}<div data-timing-preview></div><p role="status"></p>`;
    const close = () => { this.recording?.cancel(); this.recording = undefined; dialog.close(); dialog.remove(); if (this.timingDialog === dialog) this.timingDialog = undefined; };
    dialog.querySelector('[data-close]')!.addEventListener('click', close); dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    document.body.append(dialog); dialog.showModal(); return dialog;
  }
  private recordTiming() {
    this.pause(); const shots = this.shots(); if (!shots.length) return;
    const tap = new TapTimingSession(shots.map(f => f.itemId), () => performance.now()); this.recording = tap;
    const dialog = this.dialog('按键录制镜头节奏', '<p>开始后按空格或“下一镜”记录时长。不会自动保存，也不自动生成声音。</p><h3 data-record-title></h3><button data-start class="primary-button">开始录制</button><button data-tap disabled>下一镜 / 空格</button>');
    const title = dialog.querySelector('[data-record-title]')!, next = dialog.querySelector<HTMLButtonElement>('[data-tap]')!;
    dialog.querySelector<HTMLButtonElement>('[data-start]')!.onclick = () => { tap.start(); this.recording = tap; title.textContent = shots[0].title; next.disabled = false; (dialog.querySelector('[data-start]') as HTMLButtonElement).disabled = true; };
    const advance = () => { try { const r = tap.tap(); if (r.done) { next.disabled = true; title.textContent = '节奏已录制，尚未保存'; this.showTimingPreview(dialog, tap.preview(this.plan.sequence)); } else { title.textContent = shots[r.index].title; this.seek(shots[r.index].startMs); } } catch (e) { dialog.querySelector('[role=status]')!.textContent = (e as Error).message; } };
    next.onclick = advance; dialog.addEventListener('keydown', e => { if (e.code === 'Space' && !next.disabled && !(e.target as HTMLElement).matches('input,textarea,select')) { e.preventDefault(); e.stopPropagation(); advance(); } });
  }
  private showTimingPreview(dialog: HTMLDialogElement, preview: TimingPreview) {
    const host = dialog.querySelector<HTMLElement>('[data-timing-preview]')!;
    host.innerHTML = `<table><thead><tr><th>镜头实例</th><th>原时长</th><th>新时长</th></tr></thead><tbody>${preview.changes.map(c => `<tr><td>${h(c.itemId)}</td><td>${c.beforeMs} ms</td><td>${c.afterMs} ms</td></tr>`).join('')}</tbody></table><p>${h(preview.conflicts.join('；'))}</p><button data-save-timing class="primary-button" ${preview.conflicts.length ? 'disabled' : ''}>确认采用节奏并形成版本</button>`;
    const button = host.querySelector<HTMLButtonElement>('[data-save-timing]')!;
    button.onclick = () => { const located = this.index.objects.find(o => o.object.id === this.plan.sequence.id)!; button.disabled = true;
      void creativeAction<ProjectSnapshot>(this.snapshot.project.id, 'save-object', { requestId: crypto.randomUUID(), object: preview.sequence, documentId: located.documentId, baseHash: located.documentHash }).then(snapshot => {
        if (this.disposed) return; window.dispatchEvent(new CustomEvent('cewen:creative-apply', { detail: snapshot }));
        window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence', { detail: { name: 'timing-saved',projectId:this.snapshot.project.id, objectId: preview.sequence.id } }));
        dialog.close(); dialog.remove(); this.timingDialog = undefined; this.snapshot = snapshot; this.index = buildCreativeIndex(snapshot);
        this.plan = compileSequence(this.index, preview.sequence.id); this.loopEnd = this.plan.durationMs; this.frame = -1; this.time = 0; this.render(); this.paint();
      }).catch(e => { dialog.querySelector('[role=status]')!.textContent = e.message + '；候选保留，未强制覆盖。'; button.disabled = false; });
    };
  }
  private async export() {
    try {
      const data = await creativeAction<Record<string, unknown>>(this.snapshot.project.id, 'playback-bundle', { sequenceId: this.plan.sequence.id, revision: this.snapshot.revision });
      if (data.revision !== this.snapshot.revision) { this.message('项目已更新，请重新打开排演再导出。'); return; }
      downloadText('策问排演-' + this.plan.sequence.id + '.html', standalonePlayer(data), 'text/html');
      window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence', { detail: { name: 'playback-exported', objectId: this.plan.sequence.id } }));
      this.message('已导出自包含排演包；不需要模型或 CDN。');
    } catch (e) { this.message((e as Error).message); }
  }
  dispose() {
    this.disposed = true; this.pause(); this.recording?.cancel(); this.timingDialog?.close(); this.timingDialog?.remove();
    document.removeEventListener('visibilitychange', this.hidden); window.removeEventListener('blur', this.blurred);
    this.sounds.forEach(a => { a.pause(); a.removeAttribute('src'); a.load(); }); this.sounds.clear();
    this.urls.forEach(lease => lease.release()); this.urls.clear(); this.host.onclick = null; this.host.onchange = null; this.host.oninput = null;
  }
}
/** 离线播放器只通过 textContent 呈现创作文字，不执行正文 HTML。 */
function standalonePlayer(data: Record<string, unknown>) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>策问 · 分镜排演</title><style>body{background:#141b24;color:#ecf1f4;font:16px system-ui;margin:24px auto;max-width:1100px}img{width:100%;max-height:65vh;object-fit:contain}button,input{margin:10px;padding:10px}#sub{white-space:pre-line;font-size:22px}#description{white-space:pre-line;color:#bac8d2}</style><h1>二维分镜排演</h1><img id="picture" alt="当前分镜"><h2 id="title"></h2><p id="description"></p><p id="sub"></p><button id="play">播放 / 暂停</button><input id="seek" aria-label="播放位置" type="range" min="0" value="0" step="50"><span id="clock"></span><p id="status" role="status"></p><script type="application/json" id="bundle">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script>
const data=JSON.parse(document.getElementById('bundle').textContent),p=data.plan,assets=data.assets,seek=document.getElementById('seek'),sounds=new Map();seek.max=p.durationMs;let t=0,base=0,started=0,playing=false,frame=-1,raf=0;
function url(id){const a=assets[id];return a?'data:'+a.mime+';base64,'+a.data:'';}
function paint(){let i=p.frames.findIndex(f=>t>=f.startMs&&t<f.endMs);if(i<0)i=p.frames.length-1;const f=p.frames[i];if(f&&frame!==i){frame=i;document.getElementById('picture').src=url(f.mediaId);document.getElementById('title').textContent=f.title;document.getElementById('description').textContent=f.description;}document.getElementById('sub').textContent=p.audio.filter(c=>t>=c.startMs&&t<c.startMs+c.durationMs-c.offsetMs).map(c=>c.character+'：'+c.text).join('\\n');seek.value=t;document.getElementById('clock').textContent=(t/1000).toFixed(1)+' / '+(p.durationMs/1000).toFixed(1)+'秒';}
function audio(){for(const c of p.audio){const active=playing&&t>=c.startMs&&t<c.startMs+c.durationMs-c.offsetMs;let a=sounds.get(c.id);if(!a&&active&&assets[c.mediaId]){a=new Audio(url(c.mediaId));sounds.set(c.id,a);}if(!a)continue;if(!active){a.pause();continue;}const sec=(t-c.startMs+c.offsetMs)/1000;if(Math.abs(a.currentTime-sec)>.1)try{a.currentTime=Math.max(0,sec);}catch{}if(a.paused&&!a.dataset.blocked)a.play().catch(()=>{a.dataset.blocked='1';document.getElementById('status').textContent='声音暂不可用。请再次点击播放。';});}}
function pause(){playing=false;cancelAnimationFrame(raf);sounds.forEach(a=>a.pause());}
function tick(){if(!playing)return;t=Math.min(p.durationMs,base+performance.now()-started);if(t>=p.durationMs)pause();paint();audio();if(playing)raf=requestAnimationFrame(tick);}
document.getElementById('play').onclick=()=>{if(playing){pause();return;}sounds.forEach(a=>delete a.dataset.blocked);playing=true;if(t>=p.durationMs)t=0;base=t;started=performance.now();audio();tick();};seek.oninput=()=>{t=Number(seek.value);base=t;started=performance.now();paint();audio();};document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});window.addEventListener('blur',pause);paint();
</script></html>`;
}
