import { appForm } from '../app-dialog';
import { h } from '../creative/render';

/** 卡片说明学习内容和可操作的练习，示例依然只在临时会话内编辑。 */
const learningCards=[
  {id:'documents',title:'文档、分类与引用',level:'入门',detail:'认识项目目录、章节与文档之间的引用。',practice:'练习：打开章节、调整分类、插入引用'},
  {id:'cards',title:'角色与道具',level:'基础文档预设',detail:'通过基础文档整理人物与物品资料。',practice:'练习：填写字段、组合模块、建立关联'},
  {id:'maps',title:'共享底图与覆盖层',level:'地图',detail:'同一张地图承载各处的局部设计。',practice:'练习：阅读地图、修改覆盖层、查看引用'},
  {id:'game',title:'雾港来信 · 游戏',level:'游戏设计',detail:'从探索路线和战斗规则理解设计依据。',practice:'练习：修改设计、围绕体验发起问策'},
  {id:'narrative',title:'雾港来信 · 世界观',level:'叙事与世界观',detail:'从人物、地点及事件了解叙事关联。',practice:'练习：阅读关系、展开故事、整理问题'},
  {id:'screenplay',title:'雨夜候车室',level:'剧本开发',detail:'通过场次、对白及潜台词组织剧本。',practice:'练习：修改对白、查看人物与场次依据'},
  {id:'film',title:'最后一盏灯',level:'微电影制作',detail:'理解分镜、声音与连续画面的配合。',practice:'练习：查看分镜、调整节奏、打开排演'},
  {id:'mixed',title:'综合虚构工程',level:'进阶',detail:'贯通共享地图、游戏设计、剧情和影像。',practice:'练习：追溯引用、跨文档问策、整理任务'},
];

/** 使用原生单选卡片，键盘可导航，选中后给出明确的打开对象。 */
export function pickLearningExample(){
  return appForm('示例与新手教程','<p>选择想体验的内容。所有编辑仅存本次会话，关闭后恢复原样。</p><div class="learning-cards" role="radiogroup" aria-label="学习内容">'+learningCards.map((item,index)=>'<label class="learning-card"><input type="radio" name="example" value="'+item.id+'" '+(index===0?'checked':'')+'/><span class="learning-card-level">'+h(item.level)+'</span><strong>'+h(item.title)+'</strong><span>'+h(item.detail)+'</span><small>'+h(item.practice)+'</small><span class="learning-card-state" aria-hidden="true">已选择</span></label>').join('')+'</div><p data-example-selection aria-live="polite">已选择：文档、分类与引用</p>','打开示例',data=>String(data.get('example')),{className:'learning-example-dialog',onReady:dialog=>{
    dialog.addEventListener('change',()=>{const selected=dialog.querySelector<HTMLInputElement>('[name=example]:checked'),item=learningCards.find(card=>card.id===selected?.value);dialog.querySelector('[data-example-selection]')!.textContent='已选择：'+(item?.title??'');});
  }});
}
