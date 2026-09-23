import * as THREE from 'three';
import type { KnowledgeEdge, KnowledgeNode } from '../shared/model';
import type { GraphEdit } from '../shared/graph-editing';

/** 交互只依赖场景的窄接口；三维摆放与二维文档命令在此明确分流。 */
export interface GraphSurface {
  container:HTMLElement;
  canvas:HTMLElement;
  camera:THREE.Camera;
  mode:()=>string;
  selected:()=>string|null;
  edge:()=>KnowledgeEdge|undefined;
  nodes:()=>{data:KnowledgeNode;point:THREE.Vector3;label:HTMLElement;visible:boolean;pinned?:boolean}[];
  edges:()=>{data:KnowledgeEdge;points:THREE.Vector3[]}[];
  core:()=>string|undefined;
  begin:()=>void;
  end:()=>void;
  move:(id:string,point:THREE.Vector3)=>void;
  capture:()=>unknown;
  restore:(value:unknown)=>void;
  record:()=>unknown;
  select:(id:string)=>void;
  clear:()=>void;
  commit:(edit:GraphEdit|undefined,before:unknown,after:unknown)=>void;
}
type Drag={id:string;pointer:number;x:number;y:number;mode:string;plane:THREE.Plane;anchor:THREE.Vector3;positions:Map<string,THREE.Vector3>;moving:Set<string>;before:unknown;port?:string;edge?:KnowledgeEdge;end?:'source'|'target';moved:boolean;target?:string;wire?:string;reversals:number;direction:number;lastX:number;lastTurn:number;targetPort?:string};
type BoxDrag={pointer:number;startX:number;startY:number;width:number;height:number;append:boolean;previous:Set<string>;base:Set<string>;moved:boolean};
type ShiftNode={pointer:number;id:string;x:number;y:number;moved:boolean};

export class GraphInteraction {
  private overlay=document.createElement('div');
  private feedback=document.createElement('div');
  private preview=document.createElementNS('http://www.w3.org/2000/svg','svg');
  private path=document.createElementNS('http://www.w3.org/2000/svg','path');
  private drag?:Drag;
  private box?:BoxDrag;
  private shiftNode?:ShiftNode;
  private boxElement=document.createElement('div');
  private signature='';
  private blockClick=false;
  private enabled=true;
  private multi=new Set<string>();
  shake=false;
  constructor(private surface:GraphSurface){
    this.overlay.className='graph-edit-overlay';this.feedback.className='graph-edit-feedback';this.feedback.hidden=true;
    this.boxElement.className='graph-selection-box';this.boxElement.hidden=true;
    this.preview.classList.add('graph-drag-wire');this.preview.append(this.path);this.preview.style.display='none';
    surface.container.append(this.overlay,this.preview,this.boxElement,this.feedback);
    surface.container.addEventListener('pointerdown',this.down,true);
    surface.container.addEventListener('click',this.click,true);
    window.addEventListener('pointermove',this.move,true);window.addEventListener('pointerup',this.up,true);window.addEventListener('pointercancel',this.cancel);window.addEventListener('blur',this.cancel);
    window.addEventListener('keydown',this.keydown,true);
  }
  setEditable(value:boolean){this.enabled=value;if(!value)this.cancel();this.signature='';this.update();}
  selectAll(){this.multi=new Set(this.surface.nodes().filter(n=>n.visible&&n.data.kind!=='system'&&n.data.id!==this.surface.core()).map(n=>n.data.id));this.update();}
  selectedIds(){const visible=new Set(this.surface.nodes().filter(n=>n.visible).map(n=>n.data.id));const multi=[...this.multi].filter(id=>visible.has(id));return multi.length?multi:this.surface.selected()&&visible.has(this.surface.selected()!)?[this.surface.selected()!]:[];}
  private screen(point:THREE.Vector3){const p=point.clone().project(this.surface.camera),box=this.surface.container.getBoundingClientRect();return{x:(p.x+1)*box.width/2,y:(1-p.y)*box.height/2,z:p.z};}
  private world(event:PointerEvent,plane:THREE.Plane){const box=this.surface.container.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1),this.surface.camera);return ray.ray.intersectPlane(plane,new THREE.Vector3());}
  private hit(x:number,y:number,exclude?:string|Set<string>){
    const box=this.surface.container.getBoundingClientRect();
    return this.surface.nodes().filter(n=>n.visible&&!(typeof exclude==='string'?n.data.id===exclude:exclude?.has(n.data.id))).map(n=>{const r=n.label.getBoundingClientRect(),p=this.screen(n.point);return{n,d:p.z>=-1&&p.z<=1?Math.hypot(p.x+box.left-x,p.y+box.top-y):Infinity,inside:!n.label.hidden&&x>=r.left-8&&x<=r.right+8&&y>=r.top-8&&y<=r.bottom+8};}).filter(item=>item.inside||item.d<18).sort((a,b)=>Number(b.inside)-Number(a.inside)||a.d-b.d)[0]?.n;
  }
  private notice(text:string){this.feedback.textContent=text;this.feedback.hidden=!text;}
  private click=(event:MouseEvent)=>{if(this.blockClick){event.preventDefault();event.stopImmediatePropagation();this.blockClick=false;}else if(event.shiftKey){const id=(event.target as HTMLElement).closest<HTMLElement>('[data-graph-node]')?.dataset.graphNode;if(id&&this.surface.nodes().some(n=>n.data.id===id&&n.visible&&!n.label.hidden)){event.preventDefault();event.stopImmediatePropagation();if(!this.multi.size&&this.surface.selected())this.multi.add(this.surface.selected()!);this.multi.has(id)?this.multi.delete(id):this.multi.add(id);this.update();}}};
  private down=(event:PointerEvent)=>{
    if(!this.enabled||!event.isPrimary||event.button!==0||document.querySelector('dialog[open]'))return;
    const port=(event.target as HTMLElement).closest<HTMLElement>('[data-port]');
    const label=(event.target as HTMLElement).closest<HTMLElement>('[data-graph-node]');
    const found=label?this.surface.nodes().find(n=>n.data.id===label.dataset.graphNode):this.hit(event.clientX,event.clientY);
    const edge=this.surface.edge(),id=port?.dataset.node??found?.data.id,node=this.surface.nodes().find(n=>n.data.id===id);
    if(!node){
      // 二维空白左键框选；三维仅 Shift+左键框选，普通左键仍旋转。右键和中键交给镜头平移。
      if(event.target!==this.surface.canvas || this.surface.container.classList.contains('graph-transitioning') || (this.surface.mode()==='galaxy'&&!event.shiftKey))return;
      event.preventDefault();event.stopImmediatePropagation();
      const rect=this.surface.container.getBoundingClientRect();
      const previous=new Set(this.multi),base=new Set(previous);
      if(event.shiftKey&&!base.size&&this.surface.selected())base.add(this.surface.selected()!);
      this.surface.begin();
      this.box={pointer:event.pointerId,startX:event.clientX-rect.left,startY:event.clientY-rect.top,width:rect.width,height:rect.height,append:event.shiftKey,previous,base,moved:false};
      return;
    }
    if(event.shiftKey){
      // 星点本身没有 DOM 按钮时也维持 Shift 点击累选，并截断画布的普通单选事件。
      if(event.target===this.surface.canvas){event.preventDefault();event.stopImmediatePropagation();this.shiftNode={pointer:event.pointerId,id:id!,x:event.clientX,y:event.clientY,moved:false};}
      return;
    }
    if(id===this.surface.core()){this.notice('总纲保持在最高层；可框选查看，不能拖动摆放或归类');return;}
    if(!port&&node.pinned){this.notice('此节点已固定；右键可解除固定');return;}
    if(port&&this.surface.mode()==='galaxy')return;
    // 在按下时截住 OrbitControls，避免同一次手势既拖节点又转镜头。
    event.preventDefault();event.stopImmediatePropagation();this.surface.begin();
    const positions=new Map(this.surface.nodes().map(n=>[n.data.id,n.point.clone()]));
    const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(this.surface.camera.getWorldDirection(new THREE.Vector3()),node.point),anchor=this.world(event,plane);
    if(!anchor){this.surface.end();return;}
    const moving=new Set([...(this.multi.has(id!)?this.multi:[id!])].filter(value=>this.surface.nodes().some(n=>n.data.id===value&&n.visible&&!n.pinned)));
    moving.delete(this.surface.core()??'');
    if(this.surface.mode()==='galaxy'&&node.data.kind==='system')this.surface.nodes().filter(n=>n.data.group===node.data.group&&n.data.id!==this.surface.core()&&!n.pinned).forEach(n=>moving.add(n.data.id));
    if(this.surface.mode()==='galaxy')moving.delete(this.surface.core()??'');
    this.drag={id:id!,pointer:event.pointerId,x:event.clientX,y:event.clientY,mode:this.surface.mode(),plane,anchor,positions,moving,before:this.surface.capture(),port:port?.dataset.port,edge:port?.dataset.end?edge:undefined,end:port?.dataset.end as 'source'|'target'|undefined,moved:false,reversals:0,direction:0,lastX:event.clientX,lastTurn:performance.now()};
  };
  private move=(event:PointerEvent)=>{
    if(this.shiftNode&&this.shiftNode.pointer===event.pointerId){if(Math.hypot(event.clientX-this.shiftNode.x,event.clientY-this.shiftNode.y)>6)this.shiftNode.moved=true;return;}
    if(this.box&&this.box.pointer===event.pointerId){this.moveBox(event);return;}
    const drag=this.drag;if(!drag||drag.pointer!==event.pointerId)return;
    if(this.surface.mode()!==drag.mode){this.cancel();return;}
    if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;
    drag.moved=true;event.preventDefault();event.stopImmediatePropagation();
    const point=this.world(event,drag.plane);if(!point)return;
    const hoverPort=document.elementsFromPoint(event.clientX,event.clientY).map(e=>e.closest<HTMLElement>('[data-port]')).find(e=>e&&e.dataset.node!==drag.id);
    const target=hoverPort?this.surface.nodes().find(n=>n.data.id===hoverPort.dataset.node):this.hit(event.clientX,event.clientY,drag.moving);drag.target=target?.data.id;drag.targetPort=hoverPort?.dataset.port;drag.wire=undefined;
    this.surface.nodes().forEach(n=>{n.label.classList.toggle('graph-drop-target',n.data.id===drag.target);n.label.classList.toggle('graph-dragging',drag.moving.has(n.data.id));});
    if(drag.port){
      const origin=this.screen(drag.positions.get(drag.edge?(drag.end==='source'?drag.edge.target:drag.edge.source):drag.id)!),box=this.surface.container.getBoundingClientRect();
      this.preview.style.display='block';this.path.setAttribute('d',`M${origin.x},${origin.y} L${event.clientX-box.left},${event.clientY-box.top}`);this.path.setAttribute('stroke-dasharray',drag.port==='classify'?'':'6 5');
      this.notice(drag.port==='classify'?target?.data.kind==='system'?`松开：移入「${target.data.title}」`:'拖到分类标题；空白松开取消归类':target&&target.data.kind!=='system'?`松开：连接「${target.data.title}」`:drag.edge?'空白松开：解除这条手工关联':'拖到另一个文档；空白松开取消');
      return;
    }
    const delta=point.sub(drag.anchor);
    if(drag.mode==='layers'){
      // 分层模式允许整组自由平移，但不能把分类或内容拖到总纲上方。
      const ceiling=[...drag.moving].map(id=>{const item=this.surface.nodes().find(n=>n.data.id===id)?.data,start=drag.positions.get(id);return item&&start?(item.kind==='system'?-105:-210)-start.y:Infinity;});
      delta.y=Math.min(delta.y,...ceiling);
    }
    // 每帧从按下快照计算，邻居只在局部受影响，避免拖动产生不断扩散的漂移。
    for(const [id,start] of drag.positions)this.surface.move(id,drag.moving.has(id)?start.clone().add(delta):start);
    const moved=this.surface.nodes().filter(n=>drag.moving.has(n.data.id));
    for(const n of this.surface.nodes())if(n.visible&&!n.pinned&&!drag.moving.has(n.data.id)&&n.data.id!==this.surface.core()&&n.data.kind!=='system'){
      for(const other of moved){const a=this.screen(n.point),b=this.screen(other.point),dx=a.x-b.x,dy=a.y-b.y;const distance=Math.hypot(dx,dy),radius=drag.mode==='network'?120:58;
        if(distance<radius){const offset=n.point.clone().sub(other.point);if(offset.lengthSq()<.1)offset.set(1,.5,0);if(drag.mode!=='galaxy')offset.z=0;n.point.add(offset.normalize().multiplyScalar((radius-distance)*.8));if(drag.mode==='layers')n.point.y=Math.min(n.point.y,-210);this.surface.move(n.data.id,n.point);}
      }
    }
    if(drag.mode==='galaxy'){this.notice('调整摆放 · 不修改分类和关系');return;}
    if(drag.targetPort==='connect'){this.notice('松开：将节点接入此关联端口');return;}
    if(target?.data.kind==='system'){this.notice(`松开：将文档归入「${target.data.title}」`);return;}
    // 仅普通手工关联提供插线候选；依赖与正文引用不能凭位置推断新语义。
    const box=this.surface.container.getBoundingClientRect();
    for(const wire of this.surface.edges())if(wire.data.origin?.kind==='manual'&&wire.data.type==='relates'&&wire.data.source!==drag.id&&wire.data.target!==drag.id&&wire.points.some(p=>{const q=this.screen(p);return Math.hypot(q.x+box.left-event.clientX,q.y+box.top-event.clientY)<12;})){drag.wire=wire.data.id;break;}
    const dx=event.clientX-drag.lastX,now=performance.now();
    if(this.shake&&Math.abs(dx)>20){const direction=Math.sign(dx);if(now-drag.lastTurn>900)drag.reversals=0;if(drag.direction&&direction!==drag.direction){drag.reversals++;drag.lastTurn=now;}drag.direction=direction;drag.lastX=event.clientX;}
    this.notice(drag.wire?'松开：选择是否插入这条普通关联':this.shake&&drag.reversals>=3?'松开：断开此节点的普通手工关联（保留分类与正文链接）':'调整摆放 · 拖到分类标题可改归属');
  };
  private up=(event:PointerEvent)=>{
    if(this.shiftNode&&this.shiftNode.pointer===event.pointerId){
      const gesture=this.shiftNode;this.shiftNode=undefined;event.preventDefault();event.stopImmediatePropagation();
      this.blockClick=true;setTimeout(()=>this.blockClick=false,250);
      if(!gesture.moved){if(!this.multi.size&&this.surface.selected())this.multi.add(this.surface.selected()!);this.multi.has(gesture.id)?this.multi.delete(gesture.id):this.multi.add(gesture.id);this.update();}
      return;
    }
    if(this.box&&this.box.pointer===event.pointerId){this.endBox(event);return;}
    const drag=this.drag;if(!drag||drag.pointer!==event.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();this.blockClick=true;setTimeout(()=>this.blockClick=false,250);this.drag=undefined;this.surface.end();this.clean();
    if(!drag.moved){if(!drag.port){this.multi.clear();this.surface.select(drag.id);}return;}
    let edit:GraphEdit|undefined;
    const node=this.surface.nodes().find(n=>n.data.id===drag.target)?.data;
    if(drag.mode!=='galaxy'){
      if(drag.port==='classify'&&(!node||node.kind==='system'))edit={kind:'classify',ids:[drag.edge?.target??drag.id],group:node?.id??'system-unassigned'};
      else if(drag.edge&&drag.port==='reconnect'&&(!node||node.kind!=='system'))edit=node?{kind:'reconnect',edgeId:drag.edge.id,end:drag.end!,nodeId:node.id}:{kind:'disconnect',edgeIds:[drag.edge.id]};
      else if(drag.port==='connect'&&node&&node.kind!=='system')edit={kind:'connect',source:drag.id,target:node.id};
      else if(!drag.port&&drag.targetPort==='connect'&&node)edit={kind:'connect',source:node.id,target:drag.id};
      else if(!drag.port&&node?.kind==='system'){
        const ids=[...drag.moving].filter(id=>{const item=this.surface.nodes().find(n=>n.data.id===id)?.data;return item?.kind==='rule'&&Boolean(item.anchor)||item?.kind==='document'&&item.documentType!=='gdd';});
        if(ids.length)edit={kind:'classify',ids,group:node.id};
        else this.notice('总纲和分类本身不能改变归属。');
      }
      else if(!drag.port&&drag.wire)edit={kind:'insert',edgeId:drag.wire,nodeId:drag.id};
      else if(!drag.port&&this.shake&&drag.reversals>=3){const edgeIds=this.surface.edges().filter(w=>w.data.origin?.kind==='manual'&&w.data.type==='relates'&&(w.data.source===drag.id||w.data.target===drag.id)).map(w=>w.data.id);if(edgeIds.length)edit={kind:'disconnect',edgeIds};}
    }
    if(drag.port&&!edit)return;
    const after=this.surface.record();this.surface.commit(edit,drag.before,after);
  };
  /** 框选统一使用画布局部坐标，标签和星点取并集，过滤不可见及转场节点。 */
  private boxCandidates(left:number,top:number,right:number,bottom:number){
    const bounds=this.surface.container.getBoundingClientRect();
    return this.surface.nodes().filter(n=>{
      if(!n.visible)return false;
      const point=this.screen(n.point),label=n.label.getBoundingClientRect();
      const pointInside=point.z>=-1&&point.z<=1&&point.x>=left&&point.x<=right&&point.y>=top&&point.y<=bottom;
      const labelInside=!n.label.hidden&&!n.label.inert&&label.right-bounds.left>=left&&label.left-bounds.left<=right&&label.bottom-bounds.top>=top&&label.top-bounds.top<=bottom;
      return pointInside||labelInside;
    }).map(n=>n.data.id);
  }
  private moveBox(event:PointerEvent){
    const box=this.box!;
    if(this.surface.container.classList.contains('graph-transitioning')){this.cancel();return;}
    const bounds=this.surface.container.getBoundingClientRect();
    if(bounds.width!==box.width||bounds.height!==box.height){this.cancel();return;}
    if(Math.hypot(event.clientX-bounds.left-box.startX,event.clientY-bounds.top-box.startY)<6&&!box.moved)return;
    box.moved=true;event.preventDefault();event.stopImmediatePropagation();
    const x=Math.max(0,Math.min(bounds.width,event.clientX-bounds.left)),y=Math.max(0,Math.min(bounds.height,event.clientY-bounds.top));
    const left=Math.min(box.startX,x),top=Math.min(box.startY,y),right=Math.max(box.startX,x),bottom=Math.max(box.startY,y);
    Object.assign(this.boxElement.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
    this.boxElement.hidden=false;
    this.multi=new Set(box.append?box.base:[]);
    this.boxCandidates(left,top,right,bottom).forEach(id=>this.multi.add(id));
    this.update();
  }
  private endBox(event:PointerEvent){
    const box=this.box!;event.preventDefault();event.stopImmediatePropagation();this.box=undefined;this.boxElement.hidden=true;this.surface.end();
    this.blockClick=true;setTimeout(()=>this.blockClick=false,250);
    if(!box.append){
      if(!box.moved)this.multi.clear();
      // 二维总览的旧单选焦点不应继续显示端口或影响下一次拖动；分析视图仍保留阅读焦点。
      this.surface.clear();
    }
    this.update();
  }
  private clean(){this.notice('');this.preview.style.display='none';this.surface.nodes().forEach(n=>n.label.classList.remove('graph-drop-target','graph-dragging'));this.signature='';this.update();}
  private cancel=()=>{this.shiftNode=undefined;if(this.box){this.multi=this.box.previous;this.box=undefined;this.boxElement.hidden=true;this.surface.end();this.update();}const drag=this.drag;if(!drag)return;this.drag=undefined;this.surface.restore(drag.before);this.surface.end();this.clean();};
  private keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(this.drag||this.box||this.shiftNode)){event.preventDefault();event.stopImmediatePropagation();this.cancel();}};
  /** 端口与相应卡片边缘同步投影，过渡中隐藏，避免端口先于卡片跳位。 */
  update(){
    const editing=this.enabled&&this.surface.mode()!=='galaxy'&&!this.multi.size,selected=this.surface.selected(),edge=this.surface.edge();
    const signature=`${editing}:${selected}:${edge?.id}:${this.surface.mode()}`;
    if(signature!==this.signature){this.signature=signature;this.overlay.replaceChildren();
      const add=(id:string,port:string,title:string,end?:string)=>{const b=document.createElement('button');b.className='graph-edit-port';b.dataset.node=id;b.dataset.port=port;if(end)b.dataset.end=end;b.title=title;b.setAttribute('aria-label',title);b.textContent=port==='classify'?'□':'+';this.overlay.append(b);};
      if(editing&&edge?.origin?.kind==='manual'){add(edge.source,'reconnect','拖动来源端点改接，空白松开断开','source');add(edge.target,'reconnect','拖动目标端点改接，空白松开断开','target');}
      else if(editing&&edge?.origin?.kind==='classification')add(edge.target,'classify','拖动归属端点改变分类；空白松开取消归类','target');
      else if(editing&&selected){const n=this.surface.nodes().find(n=>n.data.id===selected);if(n&&n.visible&&n.data.kind!=='system'){add(selected,'connect','拖出虚线，建立手工关联');if(n.data.kind==='rule'&&n.data.anchor||n.data.kind==='document'&&n.data.documentType!=='gdd')add(selected,'classify','拖出实线，改变主要分类');}}
    }
    const box=this.surface.container.getBoundingClientRect(),transition=this.surface.container.classList.contains('graph-transitioning');
    this.overlay.querySelectorAll<HTMLElement>('[data-port]').forEach(port=>{const n=this.surface.nodes().find(n=>n.data.id===port.dataset.node);if(!n){port.hidden=true;return;}const r=n.label.getBoundingClientRect(),p=this.screen(n.point);port.hidden=transition||!n.visible;port.style.left=`${!n.label.hidden?r.right-box.left+14:p.x+20}px`;port.style.top=`${!n.label.hidden?(r.top+r.bottom)/2-box.top:p.y}px`;if(port.dataset.port==='classify'){port.style.left=`${!n.label.hidden?(r.left+r.right)/2-box.left:p.x}px`;port.style.top=`${!n.label.hidden?r.top-box.top-14:p.y-20}px`;}});
    this.surface.nodes().forEach(n=>n.label.classList.toggle('graph-multi-selected',this.multi.has(n.data.id)));
  }
  dispose(){this.cancel();this.surface.container.removeEventListener('pointerdown',this.down,true);this.surface.container.removeEventListener('click',this.click,true);window.removeEventListener('pointermove',this.move,true);window.removeEventListener('pointerup',this.up,true);window.removeEventListener('pointercancel',this.cancel);window.removeEventListener('blur',this.cancel);window.removeEventListener('keydown',this.keydown,true);this.overlay.remove();this.preview.remove();this.boxElement.remove();this.feedback.remove();}
}
