import { appForm } from './app-dialog';
import { h } from './creative/render';
import { APP_VERSION } from '../shared/version';
import { MIT_LICENSE } from '../shared/license';
import './about.css';

/** 关于页中的外部链接在桌面交给默认浏览器，网页版保留正常的新标签行为。 */
export async function aboutDesignform(){
  await appForm('关于策问',`<div class="about-identity"><img src="${import.meta.env.BASE_URL}icons/cewen-${document.documentElement.dataset.theme==='light'?'light':'dark'}.svg" alt=""/><div><h3>策问 <span>Designform</span></h3><p>游戏策划知识空间 · ${APP_VERSION}</p></div></div><p class="about-description">用文档与自由画布组织创作，让设计、引用与讨论相互连接。</p><dl class="about-facts"><div><dt>作者</dt><dd>李仕林</dd></div><div><dt>开源许可</dt><dd>MIT</dd></div></dl><div class="about-links"><a href="https://github.com/Syurli/Designform" target="_blank" rel="noopener noreferrer">GitHub · 源码仓库 ↗</a><a href="https://syurli.github.io/Designform/" target="_blank" rel="noopener noreferrer">项目网站与使用入口 ↗</a></div><section class="about-license"><h3>免费使用与商用</h3><p>MIT 允许使用、复制、修改和商用。分发软件副本或主要部分时，须保留版权声明与许可文本。用户创作的项目和文档不会因此改用 MIT。</p><details><summary>查看 MIT 许可全文</summary><pre>${h(MIT_LICENSE)}</pre></details><small>第三方组件适用各自的许可，发行版随附 THIRD_PARTY_NOTICES.md。</small></section>`,'关闭',()=>true,{className:'about-dialog',onReady:dialog=>{dialog.querySelector<HTMLElement>('footer [data-cancel]')!.hidden=true;}});
}
