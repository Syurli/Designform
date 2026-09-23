import type { InkCompanion, InkItem } from '../shared/document-companion';
import './annotation-layer.css';

type Tool='select'|'stroke'|'marker'|'arrow'|'text'|'image';
interface Options {
  shared:InkCompanion; personal:InkItem[]; readonly?:boolean;
  onChange(shared:InkCompanion,personal:InkItem[]):void;
  upload?(file:File,personal?:boolean):Promise<string>; resolveImage(path:string):string;
}
const ns='http://www.w3.org/2000/svg';
const svgElement=(tag:string,attributes:Record<string,string|number>={})=>{const element=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attributes))element.setAttribute(key,String(value));return element;};

/** 注释是一层附着于内容块的坐标，不把笔画或拼贴写进正文文字。 */
export class AnnotationLayer {
  private svg=svgElement('svg') as SVGSVGElement;
  private controls=document.createElement('div');
  private observer:ResizeObserver;
  private mutations:MutationObserver;
  private frame=0;
  private shared:InkCompanion;private personal:InkItem[];
  private tool:Tool='select';private scope:'shared'|'personal'='shared';
  private selected:string|null=null;private color='#e4bd52';private opacity=.45;private size=14;
  private undoStack:string[]=[];private redoStack:string[]=[];
  private drag?:{id:string;start:[number,number];original:InkItem;drawing:boolean;before:string};
  private visible=true;
  constructor(private paper:HTMLElement, toolbar:HTMLElement|null,private options:Options){
    this.shared=structuredClone(options.shared);this.personal=structuredClone(options.personal);
    this.svg.classList.add('document-ink');this.svg.setAttribute('aria-label','文档注释层');this.paper.classList.add('ink-paper');this.paper.append(this.svg);
    this.controls.className='ink-toolbar';
    if(toolbar&&!options.readonly){toolbar.append(this.controls);this.renderControls();this.svg.addEventListener('pointerdown',this.down);this.svg.addEventListener('pointermove',this.move);this.svg.addEventListener('pointerup',this.up);this.svg.addEventListener('pointercancel',this.cancel);this.svg.addEventListener('dblclick',this.editText);this.paper.addEventListener('keydown',this.keydown);}
    this.observer=new ResizeObserver(()=>this.render());this.observer.observe(paper);
    // 拖动与折叠可能不改变纸张外尺寸，单独观察正文节点来同步锚点。
    this.mutations=new MutationObserver(records=>{if(records.some(record=>!this.svg.contains(record.target)&&record.target!==this.svg)){cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.render());}});
    this.mutations.observe(paper,{subtree:true,childList:true,attributes:true,attributeFilter:['style','hidden','class']});this.render();
  }
  private items(){return [...this.shared.items,...this.personal];}
  private editable(){return this.scope==='shared'?this.shared.items:this.personal;}
  private snapshot(){return JSON.stringify({shared:this.shared,personal:this.personal});}
  private restore(value:string){const state=JSON.parse(value);this.shared=state.shared;this.personal=state.personal;this.selected=null;this.changed();}
  private checkpoint(before=this.snapshot()){this.undoStack.push(before);if(this.undoStack.length>60)this.undoStack.shift();this.redoStack=[];}
  private changed(){this.options.onChange(structuredClone(this.shared),structuredClone(this.personal));this.render();this.renderControls();}
  private point(event:PointerEvent|MouseEvent):[number,number]{const box=this.paper.getBoundingClientRect();return [event.clientX-box.left,event.clientY-box.top];}
  private offset(item:InkItem):[number,number]{
    if(!item.anchor.blockId)return [0,0];const anchor=this.paper.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(item.anchor.blockId)}"]`);
    if(!anchor)return [0,0];const box=anchor.getBoundingClientRect(),paper=this.paper.getBoundingClientRect();return [box.left-paper.left,box.top-paper.top];
  }
  private anchor(x:number,y:number):{anchor:InkItem['anchor'];x:number;y:number}{
    const paper=this.paper.getBoundingClientRect();const blocks=[...this.paper.querySelectorAll<HTMLElement>('[data-block-id]')].filter(block=>block.offsetHeight>0);
    const distance=(block:HTMLElement)=>{const r=block.getBoundingClientRect(),dx=Math.max(r.left-paper.left-x,0,x-(r.right-paper.left)),dy=Math.max(r.top-paper.top-y,0,y-(r.bottom-paper.top));return dx*dx+dy*dy;};
    const hit=blocks.sort((a,b)=>distance(a)-distance(b))[0];
    if(!hit)return {anchor:{},x,y};const r=hit.getBoundingClientRect();return {anchor:{blockId:hit.dataset.blockId},x:x-(r.left-paper.left),y:y-(r.top-paper.top)};
  }
  private renderControls(){
    if(this.options.readonly)return;this.controls.replaceChildren();
    const add=(label:string,action:()=>void,active=false)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.classList.toggle('active',active);b.addEventListener('click',action);this.controls.append(b);return b;};
    const visibility=add(this.visible?'隐藏注释':'显示注释',()=>{this.visible=!this.visible;this.render();this.renderControls();});visibility.setAttribute('aria-pressed',String(this.visible));
    for(const [id,label]of [['select','选择'],['marker','荧光笔'],['stroke','画笔'],['arrow','箭头'],['text','文字'],['image','贴图']] as [Tool,string][])add(label,()=>{this.tool=id;this.svg.classList.toggle('drawing',id!=='select');this.renderControls();},this.tool===id);
    const scope=document.createElement('select');scope.setAttribute('aria-label','注释保存范围');scope.innerHTML='<option value="shared">项目共享</option><option value="personal">我的私注</option>';scope.value=this.scope;scope.addEventListener('change',()=>{this.scope=scope.value as typeof this.scope;this.selected=null;this.render();this.renderControls();});this.controls.append(scope);
    const color=document.createElement('input');color.type='color';color.value=this.color;color.title='笔触颜色';color.addEventListener('input',()=>{this.color=color.value;});this.controls.append(color);
    const range=(name:string,value:number,min:number,max:number,step:number,change:(v:number)=>void)=>{const label=document.createElement('label');label.textContent=name;const input=document.createElement('input');input.type='range';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',name);input.addEventListener('change',()=>change(Number(input.value)));label.append(input);this.controls.append(label);};
    range('透明度',this.opacity,.1,1,.05,v=>{this.opacity=v;const item=this.editable().find(item=>item.id===this.selected);if(item){this.checkpoint();item.opacity=v;this.changed();}});range('笔宽',this.size,2,40,1,v=>{this.size=v;});
    add('撤销',()=>this.undo()).disabled=!this.undoStack.length;add('重做',()=>this.redo()).disabled=!this.redoStack.length;
    const selected=this.editable().find(item=>item.id===this.selected);
    if(selected){add('旋转',()=>{this.checkpoint();selected.rotation=((selected.rotation??0)+15)%360;this.changed();});add('放大',()=>this.scaleSelected(1.15));add('缩小',()=>this.scaleSelected(1/1.15));add('置顶',()=>{this.checkpoint();const list=this.editable();list.splice(list.indexOf(selected),1);list.push(selected);this.changed();});add('删除',()=>this.removeSelected());}
    const note=document.createElement('span');note.className='ink-scope-note';note.textContent=this.scope==='shared'?'随文档保存版本':'仅存本机工作区';this.controls.append(note);
  }
  private scaleSelected(factor:number){const item=this.editable().find(item=>item.id===this.selected);if(!item)return;this.checkpoint();item.width*=factor;item.height*=factor;item.points=item.points?.map(([x,y])=>[x*factor,y*factor]);this.changed();}
  private render(){
    this.svg.style.display=this.visible?"":"none";this.svg.style.width=`${this.paper.clientWidth}px`;this.svg.style.height=`${this.paper.scrollHeight}px`;this.svg.replaceChildren();
    for(const item of this.items()){
      const [ox,oy]=this.offset(item);const anchor=item.anchor.blockId?this.paper.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(item.anchor.blockId)}"]`):null;
      // 折叠内容的注释跟随隐藏，原始锚点已移除则保留笔画并在列表中标注。
      if(anchor&&anchor.offsetHeight===0)continue;
      const group=svgElement('g',{transform:`translate(${ox+item.x},${oy+item.y}) rotate(${item.rotation??0} ${item.width/2} ${item.height/2})`,opacity:item.opacity});group.dataset.inkId=item.id;
      group.classList.add('ink-item');if(this.options.readonly||!this.editable().includes(item))group.classList.add('ink-readonly');
      if(item.kind==='stroke'){const path=svgElement('path',{d:(item.points??[]).map(([x,y],index)=>`${index?'L':'M'}${x},${y}`).join(' '),fill:'none',stroke:item.color,'stroke-width':item.height||3,'stroke-linecap':'round','stroke-linejoin':'round'});group.append(path);}
      if(item.kind==='arrow'){const [endX,endY]=item.points?.[1]??[item.width,item.height];const angle=Math.atan2(endY,endX),wing=12;group.append(svgElement('path',{d:`M0 0 L${endX} ${endY} M${endX-wing*Math.cos(angle-.45)} ${endY-wing*Math.sin(angle-.45)} L${endX} ${endY} L${endX-wing*Math.cos(angle+.45)} ${endY-wing*Math.sin(angle+.45)}`,fill:'none',stroke:item.color,'stroke-width':3}));}
      if(item.kind==='text'){const text=svgElement('text',{fill:item.color,'font-size':16});for(const [index,line]of(item.text??'').split('\n').entries()){const span=svgElement('tspan',{x:0,y:18+index*24});span.textContent=line;text.append(span);}group.append(text);}
      if(item.kind==='image'&&item.assetPath){const image=svgElement('image',{href:this.options.resolveImage(item.assetPath),width:item.width,height:item.height,preserveAspectRatio:'xMidYMid meet'});group.append(image);}
      if(item.id===this.selected){const border=svgElement('rect',{x:-5,y:-5,width:Math.max(20,item.width)+10,height:Math.max(20,item.height)+10,fill:'none',stroke:'currentColor','stroke-width':1,'stroke-dasharray':'4 4'});group.append(border);}
      this.svg.append(group);
    }
  }
  private down=(event:PointerEvent)=>{
    if(event.button!==0||this.options.readonly)return;const hit=(event.target as Element).closest<SVGGElement>('[data-ink-id]');const [x,y]=this.point(event);
    if(this.tool==='select'){
      const item=this.editable().find(item=>item.id===hit?.dataset.inkId);this.selected=item?.id??null;if(!item){this.render();this.renderControls();return;}
      event.preventDefault();event.stopPropagation();this.drag={id:item.id,start:[x,y],original:structuredClone(item),drawing:false,before:this.snapshot()};this.svg.setPointerCapture(event.pointerId);this.render();this.renderControls();return;
    }
    event.preventDefault();event.stopPropagation();const now=new Date().toISOString();const item:InkItem={id:`ink-${crypto.randomUUID()}`,kind:this.tool==='marker'?'stroke':this.tool,...this.anchor(x,y),width:0,height:this.tool==='marker'?this.size:this.tool==='stroke'?Math.max(2,this.size/5):0,color:this.color,opacity:this.tool==='marker'?this.opacity:1,createdAt:now,updatedAt:now};
    if(this.tool==='text'){void this.writeText('').then(value=>{if(value===null)return;this.checkpoint();item.text=value;item.width=Math.min(500,Math.max(80,value.length*15));item.height=value.split('\n').length*24;this.editable().push(item);this.selected=item.id;this.tool='select';this.svg.classList.remove('drawing');this.changed();});return;}
    if(this.tool==='image'){this.chooseImage(item);return;}
    const before=this.snapshot();item.points=[[0,0]];this.editable().push(item);this.drag={id:item.id,start:[x,y],original:structuredClone(item),drawing:true,before};this.svg.setPointerCapture(event.pointerId);this.render();
  };
  private move=(event:PointerEvent)=>{if(!this.drag)return;const item=this.editable().find(item=>item.id===this.drag!.id)!;const [x,y]=this.point(event),dx=x-this.drag.start[0],dy=y-this.drag.start[1];if(this.drag.drawing){if(item.kind==='arrow'){item.points=[[0,0],[dx,dy]];item.width=Math.abs(dx);item.height=Math.abs(dy);}else{if((item.points?.length??0)<19990)item.points!.push([dx,dy]);item.width=Math.max(item.width,Math.abs(dx));}}else{item.x=this.drag.original.x+dx;item.y=this.drag.original.y+dy;}this.render();};
  private up=()=>{if(!this.drag)return;this.checkpoint(this.drag.before);this.selected=this.drag.id;const item=this.editable().find(item=>item.id===this.drag!.id);if(item)item.updatedAt=new Date().toISOString();this.drag=undefined;this.changed();};
  private cancel=()=>{if(!this.drag)return;const before=this.drag.before;this.drag=undefined;this.restore(before);};
  private editText=(event:MouseEvent)=>{const id=(event.target as Element).closest<SVGGElement>('[data-ink-id]')?.dataset.inkId;const item=this.editable().find(item=>item.id===id&&item.kind==='text');if(!item)return;void this.writeText(item.text??'').then(text=>{if(text===null)return;this.checkpoint();item.text=text;this.changed();});};
  private writeText(value:string):Promise<string|null>{return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='ink-text-dialog';const title=document.createElement('h3');title.textContent='文字注释';const input=document.createElement('textarea');input.value=value;input.rows=5;input.maxLength=20000;input.setAttribute('aria-label','注释文字');const save=document.createElement('button');save.className='primary-button';save.textContent='放到文档上';const cancel=document.createElement('button');cancel.textContent='取消';const finish=(text:string|null)=>{dialog.remove();resolve(text);};save.onclick=()=>finish(input.value.trim()||null);cancel.onclick=()=>finish(null);dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});dialog.append(title,input,cancel,save);document.body.append(dialog);dialog.showModal();input.focus();});}
  private chooseImage(item:InkItem){if(!this.options.upload)return;const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.onchange=()=>{const file=input.files?.[0];if(!file)return;void this.options.upload!(file,this.scope==='personal').then(path=>{this.checkpoint();item.assetPath=path;item.width=240;item.height=180;this.editable().push(item);this.selected=item.id;this.tool='select';this.svg.classList.remove('drawing');this.changed();}).catch(error=>{const message=document.createElement('span');message.setAttribute('role','alert');message.textContent=error instanceof Error?error.message:'贴图未能加入';this.controls.append(message);});};input.click();}
  private removeSelected(){const list=this.editable(),at=list.findIndex(item=>item.id===this.selected);if(at<0)return;this.checkpoint();list.splice(at,1);this.selected=null;this.changed();}
  private keydown=(event:KeyboardEvent)=>{if((event.target as HTMLElement).closest('input,textarea,[contenteditable=true]'))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.stopPropagation();event.shiftKey?this.redo():this.undo();}else if(event.key==='Delete'&&this.selected){event.preventDefault();this.removeSelected();}else if(event.key==='Escape'){this.selected=null;this.render();}};
  undo(){const value=this.undoStack.pop();if(value){this.redoStack.push(this.snapshot());this.restore(value);}}
  redo(){const value=this.redoStack.pop();if(value){this.undoStack.push(this.snapshot());this.restore(value);}}
  dispose(){this.observer.disconnect();this.mutations.disconnect();cancelAnimationFrame(this.frame);this.svg.remove();this.controls.remove();this.paper.classList.remove('ink-paper');this.paper.removeEventListener('keydown',this.keydown);}
}
