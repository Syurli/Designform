import type { DocumentCanvas } from './document-canvas';
import type { TextFormatting } from './rich-writing';

/** 段落、文字和格式刷常驻紧凑工具区，两种视图共用原选区与撤销链。 */
export class DocumentToolbox {
  readonly root=document.createElement('section');private color='#fff29d';private formatting?:TextFormatting;
  constructor(private canvas:()=>DocumentCanvas|undefined,private locked:()=>boolean,private notice:(message:string)=>void){
    this.root.className='document-toolbox';this.root.setAttribute('aria-label','正文工具');
    this.root.addEventListener('pointerdown',event=>{if((event.target as HTMLElement).closest('button,input,select')){this.canvas()?.rememberTextSelection();if((event.target as HTMLElement).closest('button'))event.preventDefault();}});
    this.root.addEventListener('change',event=>{const select=(event.target as HTMLElement).closest<HTMLSelectElement>('[data-paragraph-type]');if(select&&!this.locked()&&!this.canvas()?.formatParagraph(select.value))this.notice('请先点击要设置的正文段落。');});
    this.root.addEventListener('click',event=>{
      const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button||button.disabled||this.locked())return;const canvas=this.canvas();let applied=false;
      if(button.dataset.paragraphTool){applied=canvas?.formatParagraph(button.dataset.paragraphTool)??false;if(!applied)this.notice('请先点击要设置的正文段落。');return;}
      switch(button.dataset.textTool){
        case 'highlight':applied=canvas?.highlightText(this.color)??false;break;
        case 'bold':case 'italic':case 'style':applied=canvas?.formatText(button.dataset.textTool)??false;break;
        case 'copy':this.formatting=canvas?.copyTextFormatting();this.notice(this.formatting?'已复制文字格式。':'请先选中正文文字。');this.render();return;
        case 'apply':applied=!!this.formatting&&(canvas?.applyTextFormatting(this.formatting)??false);break;
        case 'clear':this.formatting=undefined;this.render();this.notice('格式刷已清空。');return;
      }if(!applied)this.notice('请先在正文中选中文字，再使用此工具。');
    });
    // 光标移动只同步下拉值，不重建工具区或打断输入。
    window.addEventListener('cewen:paragraph-selection',()=>{const select=this.root.querySelector<HTMLSelectElement>('[data-paragraph-type]');if(select)select.value=this.canvas()?.paragraphType()??'paragraph';});this.render();
  }
  render(){const disabled=this.locked()?'disabled':'';
    this.root.innerHTML=`<header><h3>工具</h3></header><div class="document-tool-content"><section class="compact-tool-group"><h4>段落</h4><select data-paragraph-type aria-label="段落样式" ${disabled}><option value="paragraph">正文</option>${[1,2,3,4,5,6].map(level=>`<option value="heading:${level}">标题 ${level}</option>`).join('')}<option value="ordered_list">编号列表</option><option value="bullet_list">项目列表</option><option value="blockquote">引用段落</option></select><div class="compact-tool-row"><button data-paragraph-tool="ordered_list" ${disabled}>编号列表</button><button data-paragraph-tool="bullet_list" ${disabled}>项目列表</button><button data-paragraph-tool="blockquote" ${disabled}>引用</button></div></section><section class="compact-tool-group"><h4>文字</h4><div class="compact-tool-row"><button data-text-tool="bold" ${disabled}>加粗</button><button data-text-tool="italic" ${disabled}>斜体</button><button data-text-tool="style" ${disabled}>字体配色…</button></div><div class="compact-tool-row"><input type="color" value="${this.color}" aria-label="工具荧光笔颜色" ${disabled}/><button data-text-tool="highlight" ${disabled}>应用高亮</button></div></section><section class="compact-tool-group"><h4>格式刷</h4><div class="compact-tool-row"><button data-text-tool="copy" ${disabled}>复制格式</button><button data-text-tool="apply" ${disabled||!this.formatting?'disabled':''}>应用</button><button data-text-tool="clear" ${!this.formatting?'disabled':''}>清除</button></div><small role="status">${this.formatting?'已复制，可跨文档应用':'选中文字后复制格式'}</small></section></div>`;
    const color=this.root.querySelector<HTMLInputElement>('input[type=color]');if(color)color.oninput=()=>{this.color=color.value;};const select=this.root.querySelector<HTMLSelectElement>('[data-paragraph-type]');if(select)select.value=this.canvas()?.paragraphType()??'paragraph';
  }
}
