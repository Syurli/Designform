import * as THREE from 'three';
import { GraphInteraction } from './graph-interaction';
import './graph-selection.css';
import './graph-mindmap.css';
import { hierarchyLayout, type GraphDirection } from './graph-hierarchy';
export type { GraphDirection } from './graph-hierarchy';
import type { GraphEdit } from '../shared/graph-editing';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { types, type KnowledgeData, type KnowledgeNode, type KnowledgeEdge } from './data';
import { buildAnalysis, edgeSentence, laneLabels, type AnalysisResult, type AnalysisLane } from './analysis';
import { currentTheme } from './theme';
import { categoryColor } from './category-color';

/** 四种空间模式共享同一场景；切换时只改变目标坐标，不重新创建节点。 */
export type GraphMode = 'galaxy' | 'network' | 'layers' | 'mindmap';
type DesignNode = KnowledgeNode;
type StarNode = { data: DesignNode; point: THREE.Sprite; halo: THREE.Sprite; label: HTMLButtonElement };
type Connection = { data: KnowledgeEdge; curve: THREE.QuadraticBezierCurve3; line: THREE.Line; material: THREE.LineBasicMaterial; particle: THREE.Sprite; path: SVGPathElement; hit: SVGPathElement; label: HTMLButtonElement };
type NodeAppearance = { point: number; halo: number };
/** 展开比例独立于卡片的位置；打断动画时从当前比例继续，不把整层文字清空。 */
type CardAppearance = { open: number; opacity: number };
type OverviewSnapshot = { mode: GraphMode; direction: GraphDirection; width:number; height:number; positions: Map<string, THREE.Vector3>; camera: THREE.Vector3; target: THREE.Vector3 };
/** 导航发生前的真实屏幕位置；使用视口坐标，允许工具栏与画布高度同时变化。 */
type NavigationFrame = {
  mode: GraphMode; rect: { left: number; top: number; width: number; height: number };
  projections: Map<string, THREE.Vector3>; camera: THREE.Vector3; target: THREE.Vector3;
  quaternion: THREE.Quaternion; appearance: Map<string, NodeAppearance>; lines: number[];
  scale: number; ambient: number;
  cards: Map<string, CardAppearance>; cardEdges: number[];
};
type LayoutTransition = {
  start: number; duration: number; from: Map<string, THREE.Vector3>; to: Map<string, THREE.Vector3>;
  cameraFrom: THREE.Vector3; cameraTo: THREE.Vector3; targetFrom: THREE.Vector3; targetTo: THREE.Vector3;
  cameraInterrupted: boolean; restoreOverview: boolean; analysisMorph: boolean;
  appearance: Map<string, NodeAppearance>; lines: number[]; scaleFrom: number; ambientFrom: number;
  refocus: boolean; cards: Map<string, CardAppearance>; cardEdges: number[];
};

/** 镜头围绕目标插值：方向走最短弧，镜距始终大于控制器下限。 */
function interpolateCamera(camera: THREE.Vector3, target: THREE.Vector3, from: THREE.Vector3, fromTarget: THREE.Vector3, to: THREE.Vector3, toTarget: THREE.Vector3, ratio: number) {
  target.lerpVectors(fromTarget, toTarget, ratio);
  const first = from.clone().sub(fromTarget);
  const last = to.clone().sub(toTarget);
  const distance = THREE.MathUtils.lerp(Math.max(first.length(), 150), Math.max(last.length(), 150), ratio);
  const direction = first.lengthSq() > 1e-6 ? first.normalize() : new THREE.Vector3(0, 0, 1);
  const destination = last.lengthSq() > 1e-6 ? last.normalize() : direction.clone();
  const dot = THREE.MathUtils.clamp(direction.dot(destination), -1, 1);
  if (dot < -.9995) {
    // 对向视角没有唯一最短弧，固定辅助轴避免快切时随机翻转。
    const axis = direction.clone().cross(new THREE.Vector3(0, 1, 0));
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0).cross(direction);
    direction.applyAxisAngle(axis.normalize(), Math.PI * ratio);
  } else {
    const rotation = new THREE.Quaternion().setFromUnitVectors(direction, destination);
    direction.applyQuaternion(new THREE.Quaternion().slerp(rotation, ratio));
  }
  camera.copy(target).addScaledVector(direction.normalize(), distance);
}

/** 用固定种子生成背景星点，使重新打开页面后的视觉位置保持稳定。 */
function randomGenerator(seed: number) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

/** 星空是知识节点的背景，实际规则使用可聚焦的原生按钮承载文字。 */
export class KnowledgeGraph {
  private scene = new THREE.Scene();
  private interaction?:GraphInteraction;
  private editHandler?:(edit:GraphEdit|undefined,before:unknown,after:unknown)=>void;
  /** 编辑适配器只发出动作，写入和版本统一交给应用的编辑会话。 */
  configureEditing(handler:(edit:GraphEdit|undefined,before:unknown,after:unknown)=>void,enabled=true){this.editHandler=handler;this.interaction?.setEditable(enabled);}
  setEditable(enabled:boolean){this.interaction?.setEditable(enabled);}
  setShake(enabled:boolean){if(this.interaction)this.interaction.shake=enabled;}
  selectAllNodes(){this.interaction?.selectAll();}
  selectedIds(){return this.interaction?.selectedIds()??[];}
  private layoutPrefix(mode=this.mode){
    if(mode==='galaxy')return 'galaxy-v2';
    if(mode==='network')return `network:${this.direction}:${this.selected}`;
    if(mode==='layers')return `layers-v4:${this.direction}`;
    // 筛选后的脑图重新压紧可见层级，同时不覆盖默认脑图的手工摆放。
    const scope=JSON.stringify([this.group,this.query,this.selected,this.directOnly,this.scopeIds,this.detailedGraph,this.includeArchived]);
    let hash=2166136261;for(const char of scope)hash=Math.imul(hash^char.charCodeAt(0),16777619);
    return `mindmap-v5:${this.direction}:${(hash>>>0).toString(36)}`;
  }
  private layoutKey(node:KnowledgeNode){return `${this.layoutPrefix()}:${node.id}:${node.group}`;}
  /** 同一场景内切换阅读方向，横纵坐标分别记忆，保留当前帧连续过渡。 */
  setDirection(direction:GraphDirection){if(this.direction===direction)return;this.direction=direction;if(this.mode!=='galaxy')this.setMode(this.mode);}
  /** 从快照恢复时替换旧位置，撤销不会留下刚才挤开的节点。 */
  restoreEditingLayout(value:unknown){this.layoutMemory.clear();this.restoreLayout(value);}
  togglePin(id:string){const node=this.stars.get(id);if(!node||id===this.coreId())return;const key=this.layoutKey(node.data),row=this.layoutMemory.get(key);this.layoutMemory.set(key,{group:node.data.group,point:node.point.position.clone(),pinned:!row?.pinned});this.labelsDirty=true;}
  resetPositions(){const prefix=`${this.layoutPrefix()}:`;for(const key of this.layoutMemory.keys())if(key.startsWith(prefix))this.layoutMemory.delete(key);this.setMode(this.mode);}

  private camera = new THREE.PerspectiveCamera(42, 1, 1, 8000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private stars = new Map<string, StarNode>();
  private connections: Connection[] = [];
  private backgrounds: THREE.Points[] = [];
  private clouds: THREE.Sprite[] = [];
  private labelLayer = document.createElement('div');
  private edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private analysis?: AnalysisResult;
  private relationIndex: number | null = null;
  private laneHeadings = new Map<string, HTMLDivElement>();
  private lanePositions = new Map<string, THREE.Vector3>();
  private frame = 0;
  private observer: ResizeObserver;
  private active = true;
  private mode: GraphMode = 'galaxy';
  private direction: GraphDirection = 'vertical';
  private hierarchyParent = new Map<string,string>();
  private selected: string | null = null;
  private group: string | null = null;
  private query = '';
  private directOnly = false;
  private scopeIds: string[] | null = null;
  private includeArchived = false;
  private labelsAll = false;
  private detailedGraph = false;
  private motionPaused = false;
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private labelsDirty = true;
  private labelSizes = new Map<string, { width: number; height: number }>();
  private previousSize = { width: 0, height: 0 };
  /** 隐藏的阅读页不具备有效画布尺寸，恢复显示后再计算布局。 */
  private layoutDeferred = false;
  private deferredModeOptions?: { restoreOverview?: boolean };
  private overview?: OverviewSnapshot;
  private navigationFrame?: NavigationFrame;
  private lastValidFrame?: NavigationFrame;
  private desiredAppearance = new Map<string, NodeAppearance>();
  private desiredLines: number[] = [];
  private currentScale = 1;
  private ambient = 1;
  private contentOpacity = 1;
  private cardAppearance = new Map<string, CardAppearance>();
  private cardEdgeOpacity: number[] = [];
  private texture: THREE.CanvasTexture;
  private transition: LayoutTransition | null = null;
  private selectionRing: THREE.Sprite;
  private raycaster = new THREE.Raycaster();
  /** 一次完整的主指针点击才触发选择；旋转、拖回原点、多指操作都不能误清空。 */
  private pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  private disposed = false;
  /** 历史布局按稳定身份复用，版本增删不让已有节点重新洗牌。 */
  private layoutMemory = new Map<string, { group: string; point: THREE.Vector3; pinned?:boolean }>();
  private retiring = new Set<string>();
  private versionChanging = false;
  private light = currentTheme() === 'light';
  /** 星系装饰只承担空间提示，不生成虚构的知识节点或关系。 */
  private galaxyDust?: THREE.Points;
  private galaxyCore?: THREE.Sprite;
  private primaryGdd?: string;
  /** 星尘按文档身份保存过渡权重；暂停使用累计时间，恢复时不跳相位。 */
  private dustWeights = new Map<string, number>();
  private dustOwners: string[] = [];
  private motionTime = 0;
  private lastMotionFrame = 0;
  private contextStart?: { x: number; y: number; moved: boolean };

  private findCore() {
    // 公开 PROJECT.md 指定的总纲优先；旧项目未指定时才从 GDD 类型推断。
    if(this.data.rootDocumentId && this.data.nodes.some(node=>node.id===this.data.rootDocumentId&&node.kind==='document'))return this.data.rootDocumentId;
    return this.data.nodes.filter(node => node.kind === 'document' && node.documentType === 'gdd' && node.status !== 'archived')
      .sort((a, b) => Number(/\/GDD\.md$/i.test(b.documentPath)) - Number(/\/GDD\.md$/i.test(a.documentPath)) || a.documentPath.localeCompare(b.documentPath, 'zh-CN'))[0]?.id;
  }
  private coreId() { return this.primaryGdd; }
  /** 总纲章节继承总纲金色；其他无分类节点使用中性色，避免空 group 使场景初始化失败。 */
  private nodeColor(node:KnowledgeNode){
    const core=this.coreId();if(core&&(node.id===core||node.kind!=='system'&&!node.group&&node.documentId===core))return '#CFB378';
    return node.color??this.data.groups.find(group=>group.id===node.group)?.color??'#94A5BC';
  }
  private nodeGroupLabel(node:KnowledgeNode){
    const core=this.coreId();if(core&&(node.id===core||node.kind!=='system'&&!node.group&&node.documentId===core))return '游戏总纲';
    return this.data.groups.find(group=>group.id===node.group)?.label??'未归组';
  }
  /** 父分类筛选包含所有下级分类，并用 visited 防止坏数据形成归属环。 */
  private matchesGroup(groupId:string,selected:string){
    let cursor:string|undefined=groupId;const visited=new Set<string>();
    while(cursor&&!visited.has(cursor)){
      if(cursor===selected)return true;
      visited.add(cursor);cursor=this.data.groups.find(group=>group.id===cursor)?.parent;
    }
    return false;
  }
  /** 脑图默认只陈列文档层；小节在详细模式或明确筛选/关联时才展开。 */
  private overviewNodeVisible(node:KnowledgeNode,related:Set<string>,mode=this.mode){
    const match=!this.query||`${node.id} ${node.title} ${node.summary} ${node.content.join(' ')}`.toLowerCase().includes(this.query);
    const showRule=mode==='mindmap'
      ? node.kind!=='rule'||Boolean(this.detailedGraph||this.group||this.query||this.scopeIds||related.has(node.id))
      : this.detailedGraph||this.data.nodes.length<=500||node.kind!=='rule'||Boolean(this.group||this.query||this.scopeIds||related.has(node.id));
    return !this.retiring.has(node.id)&&(this.includeArchived||node.status!=='archived')&&showRule&&(!this.scopeIds||this.scopeIds.includes(node.id))&&(!this.group||this.matchesGroup(node.group,this.group))&&match&&(!this.directOnly||!this.selected||related.has(node.id));
  }
  private starSize(node: KnowledgeNode, halo = false) {
    return node.id === this.coreId() ? halo ? 68 : 23 : halo ? node.kind === 'system' ? 95 : 43 : node.kind === 'system' ? 22 : node.kind === 'document' ? 15 : 10;
  }

  constructor(private container: HTMLElement, private select: (id: string) => void, private onCount: (count: number) => void, private selectRelation: (index: number) => void, private data: KnowledgeData, private clearSelection: () => void) {
    this.primaryGdd = this.findCore();
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setClearColor(0x080c18, 0);
    this.renderer.domElement.setAttribute('aria-label', '游戏策划关系图，可拖动旋转或平移；也可通过左侧目录和图上的文字选择节点');
    this.container.append(this.renderer.domElement);
    // 分析连线与 WebGL 使用相同的节点投影；SVG 为细线提供宽点击区域和清晰箭头。
    this.edgeLayer.classList.add('analysis-edges');
    this.edgeLayer.setAttribute('aria-hidden', 'true');
    const definitions = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    definitions.innerHTML = '<marker id="analysis-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#9dbbdd" stroke-width="1.6"/></marker>';
    this.edgeLayer.append(definitions);
    this.container.append(this.edgeLayer);
    this.labelLayer.className = 'star-labels';
    this.container.append(this.labelLayer);
    ['upstream', 'focus', 'downstream', 'context'].forEach(lane => {
      const heading = document.createElement('div');
      heading.className = `analysis-lane-heading ${lane}`;
      heading.hidden = true;
      this.labelLayer.append(heading);
      this.laneHeadings.set(lane, heading);
    });
    this.texture = this.makeGlowTexture();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 150;
    this.controls.maxDistance = 3400;
    this.controls.maxPolarAngle = Math.PI * .9;
    // 拖动只能接管镜头，节点继续完成变换，避免留下半三维、半分层的坐标。
    this.controls.addEventListener('start', () => {
      if (this.transition) this.transition.cameraInterrupted = true;
      this.controls.enableDamping = true;
    });
    this.controls.addEventListener('change', () => { this.labelsDirty = true; });
    this.createBackground();
    const geometry = this.layout('galaxy');
    data.nodes.forEach(node => {
      const color = this.nodeColor(node);
      const point = this.sprite(color, this.starSize(node), .98);
      const halo = this.sprite(color, this.starSize(node, true), .22);
      point.position.copy(geometry.get(node.id)!);
      halo.position.copy(point.position);
      const label = document.createElement('button');
      label.className = `star-label ${node.kind}`;
      label.type = 'button';
      label.textContent = node.title;
      label.style.setProperty('--node-color', categoryColor(color));label.dataset.graphNode=node.id;
      label.setAttribute('aria-label', `查看${node.title}`);
      label.addEventListener('click', () => this.select(node.id));
      this.labelLayer.append(label);
      this.stars.set(node.id, { data: node, point, halo, label });
    });
    data.edges.forEach((edge, index) => {
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
      const material = new (edge.type==='contains'?THREE.LineBasicMaterial:THREE.LineDashedMaterial)({ color: '#769cc1', transparent: true, opacity: .19, depthWrite: false, ...(edge.type==='contains'?{}:{dashSize:9,gapSize:7}) });
      const line = new THREE.Line(new THREE.BufferGeometry(), material);
      this.scene.add(line);
      const particle = this.sprite('#b8e5ff', 8, .85);
      particle.visible = false;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('analysis-edge', edge.type);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.classList.add('analysis-edge-hit');
      hit.addEventListener('click', () => { if (this.contentOpacity >= .35) this.selectEdge(edge.id); });
      this.edgeLayer.append(path, hit);
      const label = document.createElement('button');
      label.type = 'button';
      label.className = `analysis-edge-label ${edge.type}`;
      label.textContent = types.find(type => type.id === edge.type)?.label ?? '关联';
      label.setAttribute('aria-label', `查看关系依据：${edgeSentence(edge, data.nodes, data.edges)}`);
      label.addEventListener('click', () => this.selectEdge(edge.id));
      label.hidden = true;
      this.labelLayer.append(label);
      this.connections.push({ data: edge, curve, line, material, particle, path, hit, label });
    });
    this.selectionRing = this.sprite('#d1dcff', 58, .28);
    this.selectionRing.visible = false;
    const initialFraming = this.framing(geometry);
    this.camera.position.copy(initialFraming.position);
    this.controls.target.copy(initialFraming.target);
    this.controls.update();
    this.updateConnections();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.addEventListener('pointercancel', this.pointerCancel);
    this.container.addEventListener('contextmenu',this.contextMenu);
    this.container.addEventListener('pointerdown',this.contextDown);
    this.container.addEventListener('pointermove',this.contextMove);
    this.interaction=new GraphInteraction({container:this.container,canvas:this.renderer.domElement,camera:this.camera,mode:()=>this.mode,direction:()=>this.direction,selected:()=>this.selected,edge:()=>this.relationIndex===null?undefined:this.data.edges[this.relationIndex],core:()=>this.coreId(),
      nodes:()=>[...this.stars.values()].map(star=>({data:star.data,point:star.point.position,label:star.label,pinned:this.layoutMemory.get(this.layoutKey(star.data))?.pinned,visible:(this.desiredAppearance.get(star.data.id)?.point??0)>0})),
      edges:()=>this.connections.filter(c=>(this.desiredAppearance.get(c.data.source)?.point??0)>0&&(this.desiredAppearance.get(c.data.target)?.point??0)>0).map(c=>({data:c.data,points:c.curve.getPoints(40)})),
      begin:()=>{if(this.transition)this.advanceTransition(this.transition.start+this.transition.duration+1);this.controls.enabled=false;this.pointerStart=null;},
      end:()=>{this.controls.enabled=this.mode!=='network';},
      move:(id,point)=>{const star=this.stars.get(id);if(star){star.point.position.copy(point);star.halo.position.copy(point);this.labelsDirty=true;}},
      capture:()=>this.exportLayout(),restore:value=>this.restoreEditingLayout(value),
      record:()=>{this.stars.forEach(star=>{this.layoutMemory.set(this.layoutKey(star.data),{group:star.data.group,point:star.point.position.clone(),pinned:this.layoutMemory.get(this.layoutKey(star.data))?.pinned});});this.updateConnections();return this.exportLayout();},
      select:id=>this.select(id),clear:()=>this.clearSelection(),commit:(edit,before,after)=>this.editHandler?.(edit,before,after),
    });
    document.addEventListener('visibilitychange', this.visibilityChanged);
    window.addEventListener('cewen-theme-change', this.themeChanged);
    this.resize();
    this.refreshVisibility();
    this.themeChanged();
    document.fonts.ready.then(() => { if (!this.disposed) this.measureLabels(); });
    this.animate();
  }

  /** 径向透明贴图只生成一次；柔光使用叠加混合，不依赖外部图片或高成本全屏模糊。 */
  private makeGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(.1, 'rgba(255,255,255,.95)');
    gradient.addColorStop(.25, 'rgba(255,255,255,.5)');
    gradient.addColorStop(.5, 'rgba(255,255,255,.12)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }

  /** 创建始终面向镜头的星点，尺寸是场景单位，文字另由屏幕空间绘制。 */
  private sprite(color: string, size: number, opacity: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, color: this.graphColor(color), transparent: true, opacity, blending: this.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false }));
    sprite.userData.baseColor = color;
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    return sprite;
  }

  /** 浅色用有色实体点与普通混合，避免发光叠加在白底上消失；不改布局与镜头。 */
  private graphColor(color: string) { return new THREE.Color(categoryColor(color,this.light)); }
  private themeChanged = () => {
    this.light = currentTheme() === 'light';
    this.stars.forEach(star=>star.label.style.setProperty('--node-color',categoryColor(star.point.userData.baseColor,this.light)));
    this.scene.traverse(object => {
      if (object instanceof THREE.Sprite) {
        object.material.color.copy(this.graphColor(object.userData.baseColor ?? '#b8e5ff'));
        object.material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
        object.material.needsUpdate = true;
      }
    });
    this.backgrounds.forEach((field,index) => {
      const material = field.material as THREE.PointsMaterial;
      material.color.set(this.light ? '#738aa8' : index ? '#bed5ff' : '#899fcf');
      material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending; material.needsUpdate = true;
    });
    this.edgeLayer.querySelector('marker path')?.setAttribute('stroke', this.light ? '#547aa6' : '#9dbbdd');
    this.refreshVisibility(); this.labelsDirty = true;
  };

  /** 远近两层星尘产生空间感；星云强度始终低于知识节点，避免抢占阅读注意力。 */
  private createBackground() {
    const random = randomGenerator(20260921);
    [1000, 180].forEach((count, layer) => {
      const positions = new Float32Array(count * 3);
      for (let index = 0; index < count; index++) {
        positions[index * 3] = (random() - .5) * 4400;
        positions[index * 3 + 1] = (random() - .5) * 3200;
        positions[index * 3 + 2] = -1800 + random() * 2100;
      }
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: layer ? '#bed5ff' : '#899fcf', size: layer ? 3.2 : 1.7, sizeAttenuation: false, transparent: true, opacity: layer ? .85 : .6, map: this.texture, depthWrite: false, blending: THREE.AdditiveBlending });
      const field = new THREE.Points(geometry, material);
      this.scene.add(field);
      this.backgrounds.push(field);
    });
    this.data.groups.forEach((group, index) => {
      const cloud = this.sprite(group.color, 670, .042);
      const angle = index / this.data.groups.length * Math.PI * 2 - Math.PI / 2;
      cloud.position.set(Math.cos(angle) * 360, Math.sin(angle) * 245, -200);
      cloud.scale.y = 430;
      this.clouds.push(cloud);
    });
    // 四条渐疏旋臂围绕原点，倾斜薄盘保留三维纵深；粒子不参与点击与计数。
    this.galaxyDust = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms:{tone:{value:new THREE.Color('#a4b3d5')},ambient:{value:0},phase:{value:0},pixelRatio:{value:this.renderer.getPixelRatio()}},
      vertexShader:'attribute float weight; uniform float phase; uniform float pixelRatio; varying float fade; void main(){ vec3 p=position; p.x+=sin(phase*.11+position.y*.008)*2.0; p.y+=cos(phase*.09+position.x*.009)*1.5; fade=weight*(.91+.09*sin(phase*.25+position.x)); gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); gl_PointSize=2.4*pixelRatio; }',
      fragmentShader:'uniform vec3 tone; uniform float ambient; varying float fade; void main(){ float radius=length(gl_PointCoord-.5)*2.; float alpha=(1.-smoothstep(.1,1.,radius))*fade*ambient; gl_FragColor=vec4(tone,alpha); }',
      transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    }));
    this.scene.add(this.galaxyDust);
    this.rebuildDust();
    this.galaxyCore = this.sprite('#e6cda4', 165, .07); this.galaxyCore.position.set(0, 0, -45); this.galaxyCore.scale.y = 105;
  }

  /** 增长递减且封顶；同一文档的种子不受排序和筛选影响。 */
  private rebuildDust() {
    if(!this.galaxyDust)return;
    const ids=this.data.nodes.filter(node=>node.kind==='document'&&node.documentType==='dd'&&node.status!=='archived').map(node=>node.id);
    const live=new Set(ids),retired=[...this.dustWeights].filter(([id,weight])=>!live.has(id)&&weight>.005).map(([id])=>id);
    const owners=[...ids,...retired],perDocument=owners.length?Math.max(1,Math.min(104,Math.floor(9000/owners.length))):0;
    const positions:number[]=[],weights:number[]=[];this.dustOwners=[];
    for(const id of owners){let seed=17;for(const char of id)seed=(seed*31+char.charCodeAt(0))%2147483647;const random=randomGenerator(seed||1),arm=Math.floor(random()*4),center=90+random()*550;
      if(!this.dustWeights.has(id))this.dustWeights.set(id,0);
      for(let i=0;i<perDocument&&weights.length<9000;i++){const radius=Math.max(45,Math.min(720,center+(random()-.5)*240)),angle=arm*Math.PI/2+radius*.0048+(random()-.5)*.35;positions.push(Math.cos(angle)*radius,Math.sin(angle)*radius*.66,Math.sin(angle)*radius*.23+(random()-.5)*34-50);weights.push(this.dustWeights.get(id)!);this.dustOwners.push(id);}
    }
    for(const [id] of this.dustWeights)if(!owners.includes(id))this.dustWeights.delete(id);
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('weight',new THREE.Float32BufferAttribute(weights,1));this.galaxyDust.geometry.dispose();this.galaxyDust.geometry=geometry;
  }

  /** 布局是纯坐标计算。包含关系与跨系统关系均被保留，不把存在循环的图强制当成树。 */
  private layout(mode: GraphMode) {
    const result = new Map<string, THREE.Vector3>();
    const coreId = this.coreId();
    this.data.groups.forEach((group, groupIndex) => {
      const members = this.data.nodes.filter(node => node.group === group.id);
      const angle = groupIndex / this.data.groups.length * Math.PI * 2 + Math.PI / 2;
      const center = new THREE.Vector3(Math.cos(angle) * 330, Math.sin(angle) * 245, mode === 'galaxy' ? Math.sin(groupIndex * 2.1) * 140 : 0);
      members.forEach((node, index) => {
        if (mode === 'layers') {
          // 总纲统领分类，专项文档再位于分类之下；GDD 原文章节属于真实目录，不冒充分类。
          const documents = members.filter(item => item.kind === 'document' && item.id !== coreId);
          const rules = members.filter(item => item.kind === 'rule');
          const columnX = (groupIndex - (this.data.groups.length - 1) / 2) * 270;
          const level = node.id === coreId ? 0 : node.kind === 'system' ? 1 : node.kind === 'document' ? 2 + documents.indexOf(node) : 2 + documents.length + rules.indexOf(node);
          result.set(node.id, new THREE.Vector3(node.id === coreId ? 0 : columnX, -level * 105, 0));
        } else if (index === 0) {
          result.set(node.id, center.clone());
        } else {
          const orbit = members.length > 20 ? index * 2.399963 : (index - 1) / Math.max(members.length - 1, 1) * Math.PI * 2 + groupIndex * .38;
          const radius = members.length > 20 ? 35 * Math.sqrt(index) : mode === 'galaxy' ? 113 + index % 2 * 12 : 117;
          result.set(node.id, center.clone().add(new THREE.Vector3(Math.cos(orbit) * radius, Math.sin(orbit) * radius * .82, mode === 'galaxy' ? Math.sin(orbit * 1.4) * 86 : 0)));
        }
      });
    });
    if (mode === 'galaxy') {
      const core = this.coreId();
      // 总纲固定在中心，规则在近核轨道；系统为旋臂上的星团，DD 与规则由内向外展开。
      this.data.groups.forEach((group, groupIndex) => {
        const angle = groupIndex / Math.max(this.data.groups.length, 1) * Math.PI * 2 + .4;
        const radius = 340 + groupIndex % 2 * 55;
        const center = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * .7, Math.sin(angle) * radius * .24);
        const members = this.data.nodes.filter(node => node.group === group.id && node.id !== core && (node.kind === 'system' || node.documentId !== core));
        const documents = members.filter(node => node.kind === 'document');
        members.forEach(node => {
          if (node.kind === 'system') { result.set(node.id, center.clone()); return; }
          const docIndex = Math.max(0, documents.findIndex(doc => doc.id === node.documentId));
          const orbit = angle + .9 + docIndex * 2.399963;
          const docRadius = 85 + Math.sqrt(docIndex) * 35;
          const point = center.clone().add(new THREE.Vector3(Math.cos(orbit) * docRadius, Math.sin(orbit) * docRadius * .8, Math.sin(orbit) * 40));
          if (node.kind === 'rule') {
            const siblings = members.filter(other => other.kind === 'rule' && other.documentId === node.documentId);
            const index = siblings.findIndex(other => other.id === node.id), local = index * 2.399963 + orbit;
            const distance = 43 + Math.sqrt(index) * 22;
            point.add(new THREE.Vector3(Math.cos(local) * distance, Math.sin(local) * distance * .85, Math.sin(local * 1.4) * 34));
          }
          result.set(node.id, point);
        });
      });
      const coreRules = this.data.nodes.filter(node => node.kind === 'rule' && node.documentId === core);
      coreRules.forEach((node, index) => { const angle = index / coreRules.length * Math.PI * 2 + .5; const radius = 115 + Math.floor(index / 6) * 38; result.set(node.id, new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * .7, Math.sin(angle) * 32)); });
      if (core) result.set(core, new THREE.Vector3());
    }
    if (mode === 'layers' || mode === 'mindmap') {
      const related=mode==='mindmap'?this.neighbors():new Set<string>();
      const visibleIds=mode==='mindmap'?new Set(this.data.nodes.filter(node=>this.overviewNodeVisible(node,related,mode)).map(node=>node.id)):undefined;
      hierarchyLayout(this.data, coreId, this.direction, mode === 'layers', this.hierarchyParent, visibleIds).forEach((point,id)=>result.set(id,point));
    }
    if (mode === 'network') {this.analysisLayout(result);this.data.nodes.forEach(node=>{const saved=this.layoutMemory.get(`${this.layoutPrefix(mode)}:${node.id}:${node.group}`);if(saved)result.set(node.id,saved.point.clone());});}
    else {
      const layoutKey = this.layoutPrefix(mode);
      const occupied = [...this.layoutMemory].filter(([key]) => key.startsWith(`${layoutKey}:`)).map(([,value]) => value.point);
      this.data.nodes.forEach(node => {
        if(mode==='mindmap'&&!result.has(node.id)){
          result.set(node.id,(result.get(node.documentId)??result.get(coreId??''))?.clone()??new THREE.Vector3());
          return;
        }
        const key = `${layoutKey}:${node.id}:${node.group}`, saved = this.layoutMemory.get(key)??(mode==='galaxy'?[...this.layoutMemory].find(([k])=>k.startsWith(`${layoutKey}:${node.id}:`))?.[1]:undefined);
        if ((mode === 'galaxy' || mode === 'layers' || mode === 'mindmap') && node.id === this.coreId()) { result.set(node.id, new THREE.Vector3()); this.layoutMemory.set(key, { group: node.group, point: new THREE.Vector3() }); return; }
        if (saved) {
          const point=saved.point.clone();
          // 导入或恢复的旧坐标同样遵守层级边界，不能让缓存覆盖总纲最高层。
          if(mode==='layers'){const limit=node.kind==='system'?-105:-210;if(this.direction==='vertical')point.y=Math.min(point.y,limit);else point.x=Math.max(point.x,-limit);}
          result.set(node.id,point);
          if(!point.equals(saved.point))this.layoutMemory.set(key,{...saved,point});
        }
        else {
          const point = result.get(node.id)??new THREE.Vector3();
          // 新条目避开已有槽位；旧节点始终复用自己的坐标，不随数组下标漂移。
          if (this.layoutMemory.size) for (let attempt = 0; attempt < 2000 && occupied.some(old => old.distanceToSquared(point) < 900); attempt++) {
            if (mode === 'layers' || mode === 'mindmap') {if(this.direction==='vertical')point.x+=92;else point.y-=92;}
            else { const angle = attempt * 2.399963; point.x += Math.cos(angle) * 35; point.y += Math.sin(angle) * 35; point.z += 12; }
          }
          result.set(node.id,point);
          this.layoutMemory.set(key, { group: node.group, point: point.clone() }); occupied.push(point.clone());
        }
      });
    }
    // 空分类与不完整旧项目也必须为每个节点提供坐标；构造函数会直接读取这张表。
    this.data.nodes.forEach(node=>{
      if(result.has(node.id))return;
      const owner=this.data.edges.find(edge=>edge.type==='contains'&&edge.target===node.id)?.source;
      result.set(node.id,(owner?result.get(owner)?.clone():undefined)??result.get(node.documentId)?.clone()??result.get(node.group)?.clone()??result.get(coreId??'')?.clone()??new THREE.Vector3());
    });
    return result;
  }

  /** 转场必须覆盖场景内每个节点；筛选、旧总览快照与退出节点可能缺少目标坐标。 */
  private completeTransitionCoordinates(from:Map<string,THREE.Vector3>,to:Map<string,THREE.Vector3>){
    const valid=(point:THREE.Vector3|undefined)=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&Number.isFinite(point.z);
    this.stars.forEach((star,id)=>{if(!valid(from.get(id)))from.set(id,star.point.position.clone());});
    this.stars.forEach((star,id)=>{
      if(valid(to.get(id)))return;
      // 公开包含边是首选锚点；无父节点时沿用旧位置，避免凭空跳到画布原点。
      const owner=this.data.edges.find(edge=>edge.type==='contains'&&edge.target===id)?.source;
      const anchor=(owner&&to.get(owner))||to.get(star.data.documentId)||to.get(star.data.group)||from.get(id)||star.point.position;
      to.set(id,valid(anchor)?anchor.clone():star.point.position.clone());
    });
  }

  /** 自定义阅读坐标属于编辑器视图；没有此缓存仍可从公开内容重建图谱。 */
  exportLayout() { return [...this.layoutMemory].map(([key, value]) => ({ key, group: value.group, point: value.point.toArray(), pinned:value.pinned===true })); }
  restoreLayout(value: unknown) {
    if (!Array.isArray(value) || value.length > 20000) return;
    for (const row of value) if (row && typeof row.key === 'string' && typeof row.group === 'string' && Array.isArray(row.point) && row.point.length === 3 && row.point.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1000000)) this.layoutMemory.set(row.key, { group: row.group, point: new THREE.Vector3(...row.point as [number,number,number]),pinned:row.pinned===true });
    this.setMode(this.mode);
  }

  /** 边的回调查询当前身份，避免增删版本后旧数组下标选中别的关系。 */
  private selectEdge(id: string) { const index = this.data.edges.findIndex(edge => edge.id === id); if (index >= 0) this.selectRelation(index); }

  private createStar(node: KnowledgeNode, position: THREE.Vector3): StarNode {
    const color = this.nodeColor(node);
    const point = this.sprite(color, this.starSize(node), 0);
    const halo = this.sprite(color, this.starSize(node, true), 0);
    point.position.copy(position); halo.position.copy(position);
    const label = document.createElement('button'); label.type = 'button'; label.className = `star-label ${node.kind}`;
    label.textContent = node.title; label.style.setProperty('--node-color', categoryColor(color)); label.setAttribute('aria-label', `查看${node.title}`);label.dataset.graphNode=node.id;
    label.addEventListener('click', () => { if (!this.retiring.has(node.id)) this.select(node.id); }); this.labelLayer.append(label);
    return { data: node, point, halo, label };
  }

  private createConnection(edge: KnowledgeEdge): Connection {
    const material = new (edge.type==='contains'?THREE.LineBasicMaterial:THREE.LineDashedMaterial)({ color: '#769cc1', transparent: true, opacity: 0, depthWrite: false, ...(edge.type==='contains'?{}:{dashSize:9,gapSize:7}) });
    const line = new THREE.Line(new THREE.BufferGeometry(), material); this.scene.add(line);
    const particle = this.sprite('#b8e5ff', 8, 0); particle.visible = false;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.classList.add('analysis-edge', edge.type);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path'); hit.classList.add('analysis-edge-hit'); hit.addEventListener('click', () => this.selectEdge(edge.id)); this.edgeLayer.append(path, hit);
    const label = document.createElement('button'); label.type = 'button'; label.className = `analysis-edge-label ${edge.type}`; label.textContent = types.find(type => type.id === edge.type)?.label ?? '关联'; label.hidden = true; label.addEventListener('click', () => this.selectEdge(edge.id)); this.labelLayer.append(label);
    return { data: edge, curve: new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()), material, line, particle, path, hit, label };
  }

  /** 数据版本沿用当前场景与镜头；新增从归属节点展开，删除保留到收拢完成。 */
  updateData(data: KnowledgeData) {
    this.interaction?.flush();
    const previousCore=this.coreId();
    const before = new Map([...this.stars].map(([id, star]) => [id, star.data]));
    const from = new Map([...this.stars].map(([id, star]) => [id, star.point.position.clone()]));
    const appearance = new Map([...this.stars].map(([id, star]) => [id, { point: star.point.material.opacity, halo: star.halo.material.opacity }]));
    const oldConnections = new Map(this.connections.map(connection => [connection.data.id, connection]));
    this.data = data; this.primaryGdd = this.findCore(); this.transition = null; this.retiring.clear();
    this.rebuildDust();
    if (this.selected && !data.nodes.some(node => node.id === this.selected)) this.selected = null;
    if (this.group && !data.groups.some(group => group.id === this.group)) this.group = null;
    this.analysis = this.selected ? buildAnalysis(this.selected, data.nodes, data.edges) : undefined;
    const to = this.layout(this.mode);
    for (const node of data.nodes) {
      let star = this.stars.get(node.id);
      if (!star) {
        const origin = from.get(node.group) ?? to.get(node.group) ?? to.get(node.documentId) ?? to.get(node.id) ?? new THREE.Vector3();
        star = this.createStar(node, origin); this.stars.set(node.id, star); from.set(node.id, origin.clone()); appearance.set(node.id, { point: 0, halo: 0 });
      }
      const changed = before.has(node.id) && JSON.stringify(before.get(node.id)) !== JSON.stringify(node);
      star.data = node; star.label.inert = false;
      // 结构编辑时沿用完整卡片，不能清空子元素后仍保留 analysis-card 状态。
      if(star.label.classList.contains('analysis-card')&&star.label.querySelector('strong')){
        star.label.querySelector('strong')!.textContent=node.title;
        star.label.querySelector('.analysis-card-summary')!.textContent=node.summary;
        star.label.querySelector('.analysis-card-meta')!.textContent=`${this.nodeGroupLabel(node)} · ${{confirmed:'已确认',draft:'草稿',question:'待确认',archived:'已归档'}[node.status]}`;
      }else star.label.textContent = node.title;
      star.label.classList.toggle('version-changed', changed);
      const color = this.nodeColor(node);
      star.point.userData.baseColor = star.halo.userData.baseColor = color;
      star.point.material.color.copy(this.graphColor(color)); star.halo.material.color.copy(this.graphColor(color)); star.label.style.setProperty('--node-color', categoryColor(color));
    }
    const ids = new Set(data.nodes.map(node => node.id));
    for (const [id, star] of this.stars) if (!ids.has(id)) { this.retiring.add(id); to.set(id, to.get(star.data.group)?.clone() ?? from.get(id)?.clone() ?? star.point.position.clone()); star.label.inert = true; }
    this.connections = data.edges.map(edge => {
      const existing = oldConnections.get(edge.id); oldConnections.delete(edge.id);
      if (existing) { existing.data = edge; existing.label.textContent = types.find(type => type.id === edge.type)?.label ?? '关联'; return existing; }
      return this.createConnection(edge);
    });
    this.connections.push(...oldConnections.values());
    const lines = this.connections.map(connection => connection.material.opacity);
    this.prepareAnalysis(true); this.refreshVisibility(false);
    this.versionChanging = true;
    this.completeTransitionCoordinates(from,to);
    this.transition = { start: performance.now(), duration: this.reduceMotion.matches ? 0 : this.mode === 'network' ? 360 : 850, from, to, cameraFrom: this.camera.position.clone(), cameraTo: this.camera.position.clone(), targetFrom: this.controls.target.clone(), targetTo: this.controls.target.clone(), cameraInterrupted: true, restoreOverview: false, analysisMorph: this.mode === 'network', appearance, lines, scaleFrom: this.currentScale, ambientFrom: this.ambient, refocus: false, cards: new Map(this.cardAppearance), cardEdges: [...this.cardEdgeOpacity] };
    // 第一份总纲出现时将新中心纳入视野；普通版本迭代继续保留用户镜头。
    if(previousCore!==this.coreId()&&this.mode==='galaxy') {const framing=this.framing(to);this.transition.cameraTo=framing.position;this.transition.targetTo=framing.target;this.transition.cameraInterrupted=false;}
    this.controls.enableDamping=this.transition.cameraInterrupted;
    this.measureLabels(); this.advanceTransition(this.transition.start);
  }

  /** 完成后才释放离开的图元，避免新旧版本之间出现整屏空白。 */
  private clearRetired() {
    for (const id of this.retiring) {
      const star = this.stars.get(id); if (!star) continue;
      this.scene.remove(star.point, star.halo); star.point.material.dispose(); star.halo.material.dispose(); star.label.remove(); this.stars.delete(id); this.cardAppearance.delete(id); this.labelSizes.delete(id); this.desiredAppearance.delete(id);
    }
    this.retiring.clear();
    const ids = new Set(this.data.edges.map(edge => edge.id));
    this.connections = this.connections.filter(connection => {
      if (ids.has(connection.data.id)) return true;
      this.scene.remove(connection.line, connection.particle); connection.line.geometry.dispose(); connection.material.dispose(); connection.particle.material.dispose(); connection.path.remove(); connection.hit.remove(); connection.label.remove(); return false;
    });
    this.versionChanging = false;
  }

  /** 以一屏一个稳定字号的分析桌面组织卡片；关系较多时向下延伸，滚动阅读而不缩小文字。 */
  private analysisLayout(result: Map<string, THREE.Vector3>) {
    this.lanePositions.clear();
    if (!this.analysis) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const narrow = width < 560;
    const lanes: AnalysisLane[] = ['upstream', 'downstream', 'context'];
    const position = (x: number, y: number) => new THREE.Vector3(x - width / 2, height / 2 - y, 0);
    if (narrow) {
      result.set(this.analysis.focus.id, position(width / 2, 110));
      this.lanePositions.set('focus', position(width / 2, 22));
      let cursor = 230;
      lanes.forEach(lane => {
        const entries = this.analysis!.entries.filter(entry => entry.lane === lane);
        this.lanePositions.set(lane, position(width / 2, cursor));
        cursor += 88;
        entries.forEach(entry => { result.set(entry.node.id, position(width / 2, cursor)); cursor += 170; });
        if (!entries.length) cursor += 35;
      });
    } else if (this.direction === 'vertical') {
      const upstream=this.analysis.entries.filter(entry=>entry.lane==='upstream');
      const downstream=this.analysis.entries.filter(entry=>entry.lane==='downstream');
      const context=this.analysis.entries.filter(entry=>entry.lane==='context');
      const columns=Math.max(1,Math.min(3,Math.floor(width/250)));
      const row=(entries:typeof upstream,top:number)=>entries.forEach((entry,index)=>result.set(entry.node.id,position(width*(index%columns+.5)/columns,top+Math.floor(index/columns)*174)));
      if(upstream.length){this.lanePositions.set('upstream',position(width/2,22));row(upstream,110);}
      const focusY=upstream.length?110+Math.ceil(upstream.length/columns)*174+55:114;
      this.lanePositions.set('focus',position(width/2,focusY-85));
      result.set(this.analysis.focus.id,position(width/2,focusY));
      let cursor=focusY+170;
      if(downstream.length){this.lanePositions.set('downstream',position(width/2,cursor));row(downstream,cursor+70);cursor+=70+Math.ceil(downstream.length/columns)*174+35;}
      if(context.length){this.lanePositions.set('context',position(width/2,cursor));row(context,cursor+70);}
    } else {
      const step = width / 3;
      result.set(this.analysis.focus.id, position(width / 2, 114));
      this.lanePositions.set('focus', position(width / 2, 22));
      (['upstream', 'downstream'] as const).forEach((lane, laneIndex) => {
        const x = step * (laneIndex === 0 ? .5 : 2.5);
        this.lanePositions.set(lane, position(x, 22));
        this.analysis!.entries.filter(entry => entry.lane === lane).forEach((entry, index) => result.set(entry.node.id, position(x, 114 + index * 174)));
      });
      const sideRows = Math.max(1, ...lanes.slice(0, 2).map(lane => this.analysis!.entries.filter(entry => entry.lane === lane).length));
      const contextTop = sideRows * 174 + 50;
      this.lanePositions.set('context', position(width / 2, contextTop));
      const context = this.analysis.entries.filter(entry => entry.lane === 'context');
      const columns = Math.min(3, Math.max(context.length, 1));
      // 每列按等宽单元居中；收窄窗口或打开详情后，卡片间距仍大于卡片宽度。
      context.forEach((entry, index) => result.set(entry.node.id, position(width / columns * (index % columns + .5), contextTop + 95 + Math.floor(index / columns) * 174)));
    }
  }

  /** 在进入分析或更换焦点时建立摘要卡片；其正文始终来自同一个节点对象。 */
  private prepareAnalysis(keepOutgoingCards = false) {
    this.analysis = this.selected ? buildAnalysis(this.selected, this.data.nodes, this.data.edges) : undefined;
    const enabled = this.mode === 'network';
    const cardEnabled = enabled || this.mode === 'mindmap';
    this.container.parentElement!.classList.toggle('analysis-mode', enabled);
    this.container.parentElement!.classList.toggle('mindmap-mode', this.mode === 'mindmap');
    this.edgeLayer.style.display = enabled || keepOutgoingCards ? '' : 'none';
    if (enabled) {
      const width = this.container.clientWidth;
      const entries = this.analysis?.entries ?? [];
      const narrow = width < 560;
      this.controls.enablePan = !narrow;
      this.renderer.domElement.style.touchAction = narrow ? 'pan-y' : 'none';
      const sideRows = Math.max(1, ...(['upstream', 'downstream'] as const).map(lane => entries.filter(entry => entry.lane === lane).length));
      const contextRows = Math.ceil(entries.filter(entry => entry.lane === 'context').length / 3);
      const verticalColumns=Math.max(1,Math.min(3,Math.floor(width/250)));
      const upstreamRows=Math.ceil(entries.filter(entry=>entry.lane==='upstream').length/verticalColumns);
      const downstreamRows=Math.ceil(entries.filter(entry=>entry.lane==='downstream').length/verticalColumns);
      const verticalContextRows=Math.ceil(entries.filter(entry=>entry.lane==='context').length/verticalColumns);
      const focusY=upstreamRows?110+upstreamRows*174+55:114;
      const verticalHeight=Math.max(450,focusY+170+(downstreamRows?70+downstreamRows*174+35:0)+(verticalContextRows?70+verticalContextRows*174+35:0)+95);
      const height = !this.analysis ? 450 : narrow ? 430 + entries.length * 170 + 3 * 88 : this.direction==='vertical' ? verticalHeight : sideRows * 174 + 190 + Math.max(1, contextRows) * 174;
      this.container.style.height = `${height}px`;
      this.container.style.setProperty('--analysis-card-width', `${narrow ? Math.min(width - 110, 260) : Math.min(226, (width - 112) / 3)}px`);
    } else {
      this.container.style.height = '';
      if (this.mode === 'mindmap') this.container.style.setProperty('--analysis-card-width', '192px');
      else this.container.style.removeProperty('--analysis-card-width');
      this.controls.enablePan = true;
      this.renderer.domElement.style.touchAction = 'none';
    }
    this.stars.forEach(star => {
      const wasCard = star.label.classList.contains('analysis-card');
      if (!cardEnabled && keepOutgoingCards && wasCard && (this.cardAppearance.get(star.data.id)?.open ?? 0) > .001) return;
      star.label.classList.toggle('analysis-card', cardEnabled);
      star.label.classList.toggle('mindmap-card', this.mode === 'mindmap');
      if (!cardEnabled) {
        star.label.textContent = star.data.title;
        star.label.style.removeProperty('clip-path');
        star.label.style.removeProperty('opacity');
        star.label.style.removeProperty('--card-inset');
        star.label.style.removeProperty('--card-text-opacity');
        star.label.style.removeProperty('--card-corners-opacity');
        star.label.inert = false;
        this.cardAppearance.set(star.data.id, { open: 0, opacity: 0 });
        return;
      }
      const entry = this.analysis?.entries.find(item => item.node.id === star.data.id);
      // 共同卡片沿用同一个内容元素，退出卡片也保留原说明直至收拢结束。
      if (wasCard && star.label.querySelector('.analysis-card-role')) {
        star.label.querySelector('.analysis-card-role')!.textContent = enabled ? star.data.id === this.selected ? '当前焦点' : entry ? laneLabels[entry.lane] : '' : star.data.kind === 'system' ? '分类' : star.data.kind === 'rule' ? '小节' : '文档';
        return;
      }
      const meta = document.createElement('span');
      meta.className = 'analysis-card-meta';
      meta.textContent = `${this.nodeGroupLabel(star.data)} · ${{ confirmed: '已确认', draft: '草稿', question: '待确认', archived: '已归档' }[star.data.status]}`;
      const title = document.createElement('strong');
      title.textContent = star.data.title;
      const summary = document.createElement('span');
      summary.className = 'analysis-card-summary';
      summary.textContent = star.data.summary;
      const role = document.createElement('span');
      role.className = 'analysis-card-role';
      role.textContent = enabled ? star.data.id === this.selected ? '当前焦点' : entry ? laneLabels[entry.lane] : '' : star.data.kind === 'system' ? '分类' : star.data.kind === 'rule' ? '小节' : '文档';
      star.label.replaceChildren(meta, title, summary, role);
    });
    this.laneHeadings.forEach((heading, lane) => {
      const count = this.analysis?.entries.filter(entry => entry.lane === lane).length ?? 0;
      heading.hidden = !enabled || !this.analysis || this.direction==='vertical'&&lane!=='focus'&&count===0;
      heading.textContent = lane === 'focus' ? '当前分析条目' : `${laneLabels[lane as AnalysisLane]} · ${count}${count ? '' : ' / 暂无记录'}`;
    });
    this.measureLabels();
  }

  /** 根据当前画布比例计算总览镜头；窄屏仍允许缩放和平移查看局部。 */
  private framing(positions: Map<string, THREE.Vector3>) {
    // 分析坐标按可读像素设计，默认一场景单位对应一个屏幕像素，超出视口的内容可滚动。
    if (this.mode === 'network') return { target: new THREE.Vector3(), position: new THREE.Vector3(0, 0, this.container.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) };
    if (this.mode === 'mindmap') {
      // 初始按 85% 投影，五张首层卡片可完整横排；总纲卡片顶部至少留出 72px。
      const height=this.container.clientHeight;
      const scale=.85;
      const distance=height/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))*scale);
      const core=positions.get(this.coreId()??'')??new THREE.Vector3();
      const target=core.clone().add(this.direction==='vertical'?new THREE.Vector3(0,-(height/2-72)/scale,0):new THREE.Vector3((this.container.clientWidth/2-110)/scale,0,0));
      return {target,position:target.clone().add(new THREE.Vector3(0,0,distance))};
    }
    if (this.mode === 'layers') {
      // 分层目录可向下很长：默认只取总纲、分类和首层内容取景，深层通过平移阅读。
      const visible=[...positions].filter(([id])=>(this.desiredAppearance.get(id)?.point??Number(this.stars.get(id)?.point.visible))>0);
      const upper=visible.filter(([id,point])=>id===this.coreId()||this.stars.get(id)?.data.kind==='system'||(this.direction==='vertical'?point.y>=-340:point.x<=640));
      const points=(upper.length?upper:visible.length?visible:[...positions]).map(([,point])=>point);
      if(!points.length)return {target:new THREE.Vector3(),position:new THREE.Vector3(0,0,650)};
      const frame=new THREE.Box3().setFromPoints(points);
      const size=frame.getSize(new THREE.Vector3()),aspect=Math.max(this.container.clientWidth/Math.max(this.container.clientHeight,1),.45);
      const tangent=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
      // 1300×720 窗口内的实际画布约 1300×510，五列系统约占画布宽度的 75%。
      const distance=Math.min(2200,Math.max(620,(size.x+300)/(2*tangent*aspect*.86),(size.y+230)/(2*tangent*.86)));
      const center=frame.getCenter(new THREE.Vector3());
      const target=this.direction==='vertical'?new THREE.Vector3(center.x,frame.max.y-175,0):new THREE.Vector3(frame.min.x+240,center.y,0);
      return {target,position:target.clone().add(new THREE.Vector3(0,0,distance))};
    }
    // 只对当前可见对象取景；没有结果时使用完整布局，空状态由界面负责显示。
    const visible = [...positions].filter(([id]) => (this.desiredAppearance.get(id)?.point ?? Number(this.stars.get(id)?.point.visible)) > 0).map(([, point]) => point);
    const box = new THREE.Box3().setFromPoints(visible.length ? visible : [...positions.values()]);
    const size = box.getSize(new THREE.Vector3());
    const target = box.getCenter(new THREE.Vector3());
    if (this.mode === 'galaxy' && this.coreId() && !this.group && !this.query && !this.scopeIds && !this.directOnly) { target.set(0, 0, 0); size.x = Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * 2; size.y = Math.max(Math.abs(box.min.y), Math.abs(box.max.y)) * 2; }
    const aspect = Math.max(this.container.clientWidth / Math.max(this.container.clientHeight, 1), .45);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max((size.x + 150) / aspect, size.y + 160) / (2 * tangent) + size.z * .5;
    return { target, position: target.clone().add(new THREE.Vector3(0, this.mode === 'galaxy' ? 100 : 0, Math.min(Math.max(distance, 450), 3300))) };
  }

  /** 仅保存真实镜头与节点坐标；隐藏视图没有有效尺寸，也不会用零尺寸重新取景。 */
  rememberOverview() {
    if (this.mode === 'network' || this.disposed) return;
    // 返回动画尚未结束又进入分析时，继续保留原总览，避免把半途坐标当成新的基线。
    if (this.transition?.restoreOverview && this.overview?.mode === this.mode) return;
    this.overview = {
      mode: this.mode, direction:this.direction,width:this.container.clientWidth,height:this.container.clientHeight,
      positions: new Map([...this.stars].map(([id, star]) => [id, star.point.position.clone()])),
      camera: this.camera.position.clone(), target: this.controls.target.clone()
    };
  }

  /** 由导航入口在修改工具栏、滚动位置或页面样式之前调用，下一次 setMode 消费一次。 */
  captureNavigationFrame() {
    if (!this.disposed) this.navigationFrame = this.captureFrame() ?? this.lastValidFrame;
  }

  /** 投影仅在画面变化时保存；隐藏时沿用最后一次有效画面，不制造零尺寸坐标。 */
  private captureFrame(): NavigationFrame | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    this.camera.updateMatrixWorld();
    const frame: NavigationFrame = {
      mode: this.mode, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      projections: new Map(), camera: this.camera.position.clone(), target: this.controls.target.clone(),
      quaternion: this.camera.quaternion.clone(), appearance: new Map(), lines: [],
      scale: this.currentScale, ambient: this.ambient,
      cards: new Map([...this.cardAppearance].map(([id, value]) => [id, { ...value }])), cardEdges: [...this.cardEdgeOpacity]
    };
    this.stars.forEach((star, id) => {
      const point = star.point.position.clone().project(this.camera);
      frame.projections.set(id, new THREE.Vector3(rect.left + (point.x + 1) * rect.width / 2, rect.top + (1 - point.y) * rect.height / 2, point.z));
      frame.appearance.set(id, { point: star.point.visible ? star.point.material.opacity : 0, halo: star.halo.visible ? star.halo.material.opacity : 0 });
    });
    frame.lines = this.connections.map(connection => connection.line.visible ? connection.material.opacity : 0);
    this.lastValidFrame = frame;
    return frame;
  }

  /** 动画从当前屏幕位置出发；返回时使用保存的用户视角，不重新缩放到全图。 */
  setMode(mode: GraphMode, options: { restoreOverview?: boolean } = {}) {
    if (this.disposed) return;
    this.interaction?.flush();
    if (this.versionChanging) this.clearRetired();
    const frame = this.navigationFrame ?? this.captureFrame() ?? this.lastValidFrame;
    this.mode = mode;
    if (!this.active || !this.container.clientWidth || !this.container.clientHeight) {
      this.layoutDeferred = true;
      this.deferredModeOptions = options;
      this.navigationFrame = frame;
      return;
    }
    this.navigationFrame = undefined;
    this.layoutDeferred = false;
    this.deferredModeOptions = undefined;
    this.transition = null;
    // 返回途中又切总览布局时，模式名已变化，但尚未收拢的卡片仍需续接。
    const hasOutgoingCards = [...(frame?.cards.values() ?? [])].some(card => card.open > .001);
    this.prepareAnalysis(mode !== 'network' && hasOutgoingCards);
    this.controls.enableRotate = mode === 'galaxy';
    this.controls.enableZoom = mode !== 'network';
    this.controls.maxDistance = mode === 'network' ? 10000 : 3400;
    this.controls.mouseButtons.LEFT = mode === 'galaxy' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.touches.ONE = mode === 'galaxy' ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
    this.container.dataset.mode = mode;

    // 先更新真实画布比例，再把导航前的屏幕点反投影到新的画布，避免高度切换时跳位。
    const width = this.container.clientWidth, height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.previousSize = { width, height };
    if (frame) {
      // 清空上次拖动剩余的阻尼，随后恢复捕获的镜头，防止旧惯性偏移返回位置。
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = true;
      this.camera.position.copy(frame.camera);
      this.controls.target.copy(frame.target);
      this.camera.quaternion.copy(frame.quaternion);
      this.camera.updateMatrixWorld();
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const from = new Map([...this.stars].map(([id, star]) => {
      const projected = frame?.projections.get(id);
      const point = projected
        ? new THREE.Vector3((projected.x - rect.left) / rect.width * 2 - 1, 1 - (projected.y - rect.top) / rect.height * 2, projected.z).unproject(this.camera)
        : star.point.position.clone();
      return [id, point] as const;
    }));
    this.refreshVisibility(false);
    const saved = options.restoreOverview && this.overview?.mode === mode && this.overview.direction===this.direction ? this.overview : undefined;
    const to = saved ? new Map([...saved.positions].map(([id, point]) => [id, point.clone()])) : this.layout(mode);
    // 返回焦点前若窗口尺寸变了，沿用原位置但重新取景，避免旧镜距裁掉卡片。
    const resizedOverview=saved && (Math.abs(saved.width-width)>4 || Math.abs(saved.height-height)>4);
    const framing = saved && !resizedOverview ? { position: saved.camera.clone(), target: saved.target.clone() } : this.framing(to);
    const analysisMorph = mode === 'network' || mode === 'mindmap' || frame?.mode === 'network' || frame?.mode === 'mindmap';
    const refocus = mode === 'network' && frame?.mode === 'network';
    if (refocus) {
      this.stars.forEach((_, id) => {
        const previous = frame?.cards.get(id)?.open ?? 0;
        const visible = this.analysis?.visibleIds.has(id);
        // 新邻居从被选中的知识节点向外出现；旧卡片在自己的节点处收拢，不飞回隐藏布局。
        if (visible && previous < .001 && this.selected) from.set(id,(from.get(this.selected)??from.get(id)??this.stars.get(id)!.point.position).clone());
        if (!visible && previous > 0) to.set(id,(from.get(id)??this.stars.get(id)!.point.position).clone());
      });
    }
    this.completeTransitionCoordinates(from,to);
    // 较长分析页的镜头可能远于总览缩放上限；迁移期间放宽范围，防止控制器截断动画起点。
    this.controls.maxDistance = Math.max(mode === 'network' ? 10000 : 3400, this.camera.position.distanceTo(this.controls.target), framing.position.distanceTo(framing.target)) + 1;
    this.transition = {
      start: performance.now(), duration: this.reduceMotion.matches ? 0 : refocus ? 360 : analysisMorph ? 520 : 1150, from, to,
      cameraFrom: this.camera.position.clone(), cameraTo: framing.position,
      targetFrom: this.controls.target.clone(), targetTo: framing.target, cameraInterrupted: false,
      restoreOverview: Boolean(saved), analysisMorph,
      appearance: frame?.appearance ?? new Map(this.desiredAppearance), lines: frame?.lines ?? [...this.desiredLines],
      scaleFrom: frame ? frame.scale * frame.rect.height / height : this.currentScale,
      ambientFrom: frame?.ambient ?? this.ambient,
      refocus, cards: frame?.cards ?? new Map(), cardEdges: frame?.cardEdges ?? []
    };
    // 程序控制镜头时暂停 OrbitControls 的残余惯性；用户接管后再恢复。
    this.controls.enableDamping = false;
    this.container.classList.add('graph-transitioning');
    this.container.dataset.transition = refocus ? 'refocus-analysis' : mode === 'network' ? 'enter-analysis' : frame?.mode === 'network' ? 'leave-analysis' : 'layout';
    // 分析卡片采用固定像素布局，镜头抵达前暂不接收平移，避免停在错误阅读比例。
    this.controls.enabled = mode !== 'network' || this.reduceMotion.matches;
    this.advanceTransition(this.transition.start);
    this.labelsDirty = true;
  }

  /** 选择、查询与分组过滤只影响可见性，始终保留稳定的节点 ID 和布局坐标。 */
  setState(state: { selected: string | null; group: string | null; query: string; directOnly: boolean; labelsAll: boolean; paused: boolean; relationIndex?: number | null; scopeIds?: string[] | null; includeArchived?: boolean; detailedGraph?: boolean }, options: { deferLayout?: boolean; preserveCamera?: boolean } = {}) {
    const detailChanged=this.detailedGraph!== (state.detailedGraph===true) || this.includeArchived!== (state.includeArchived===true) || JSON.stringify(this.scopeIds)!==JSON.stringify(state.scopeIds??null);
    this.detailedGraph = state.detailedGraph === true; this.scopeIds = state.scopeIds ?? null; this.includeArchived = state.includeArchived === true;
    const scopeChanged = detailChanged || this.group !== state.group || this.query !== state.query.trim().toLowerCase() || this.directOnly !== state.directOnly || (state.directOnly && this.selected !== state.selected);
    const focusChanged = this.selected !== state.selected;
    this.selected = state.selected;
    this.group = state.group;
    this.query = state.query.trim().toLowerCase();
    this.directOnly = state.directOnly;
    this.labelsAll = state.labelsAll;
    this.motionPaused = state.paused;
    this.relationIndex = state.relationIndex ?? null;
    // 导航会紧接着调用 setMode，避免先用旧页面模式生成一次过渡布局。
    if (options.deferLayout) return;
    if (!options.preserveCamera && (this.mode === 'network' ? focusChanged : scopeChanged || (this.mode==='mindmap'&&focusChanged))) this.reset();
    else this.refreshVisibility();
  }

  private neighbors() {
    const related = new Set<string>();
    if (this.selected) {
      related.add(this.selected);
      this.data.edges.forEach(edge => { if (edge.source === this.selected) related.add(edge.target); if (edge.target === this.selected) related.add(edge.source); });
    }
    return related;
  }

  private refreshVisibility(applyAppearance = true) {
    this.labelsDirty = true;
    const related = this.neighbors();
    let count = 0;
    this.stars.forEach(star => {
      const visible = !this.retiring.has(star.data.id) && (this.mode === 'network' ? Boolean(this.analysis?.visibleIds.has(star.data.id)) : this.overviewNodeVisible(star.data,related));
      const core = star.data.id === this.coreId();
      const highlighted = core || !this.selected || related.has(star.data.id);
      star.label.classList.toggle('galaxy-core', core && this.mode === 'galaxy');
      this.desiredAppearance.set(star.data.id, { point: visible ? highlighted ? 1 : .38 : 0, halo: visible ? highlighted ? .25 : .055 : 0 });
      star.label.classList.toggle('selected', star.data.id === this.selected);
      star.label.classList.toggle('related', related.has(star.data.id));
      star.label.setAttribute('aria-pressed', String(star.data.id === this.selected));
      if (visible) count++;
    });
    const currentEdges = new Set(this.data.edges.map(edge => edge.id));
    const classifiedRules = new Set(this.data.edges.filter(edge => edge.origin?.kind === 'classification' && this.data.nodes.some(node => node.id === edge.target && node.kind === 'rule')).map(edge => edge.target));
    this.connections.forEach((connection, index) => {
      const { source, target } = connection.data;
      // 分层视图按分类展示已归类规则；GDD→章节的真实目录边仍保留在数据及关系分析中。
      const supersededSection = this.mode === 'layers' && connection.data.origin?.kind === 'section' && classifiedRules.has(target);
      const hierarchyVisible = this.mode !== 'mindmap' || connection.data.type === 'contains' && this.hierarchyParent.get(target) === source;
      const overviewVisible = hierarchyVisible && !supersededSection && currentEdges.has(connection.data.id) && this.mode !== 'network' && (this.desiredAppearance.get(source)?.point ?? 0) > 0 && (this.desiredAppearance.get(target)?.point ?? 0) > 0;
      connection.path.classList.toggle('selected', index === this.relationIndex);
      connection.label.setAttribute('aria-pressed', String(index === this.relationIndex));
      const focused = source === this.selected || target === this.selected;
      connection.material.color.set(this.light ? focused ? '#37669a' : '#6b86a3' : focused ? '#9cc8f2' : '#6a8ba8');
      const galaxyLine = source === this.coreId() ? .3 : connection.data.type === 'contains' ? .2 : .09;
      this.desiredLines[index] = overviewVisible ? focused ? .65 : this.selected ? .07 : this.mode === 'galaxy' ? galaxyLine : .24 : 0;
      // 普通“关联”没有因果方向，不绘制方向粒子，避免视觉暗示出不存在的依赖。
      connection.particle.visible = overviewVisible && focused && connection.data.type !== 'relates';
    });
    const current = this.selected && this.stars.get(this.selected);
    this.selectionRing.visible = Boolean(current && this.desiredAppearance.get(current.data.id)!.point > 0);
    if (current) this.selectionRing.position.copy(current.point.position);
    if (applyAppearance) {
      const ratio = this.transition ? this.transitionRatio(performance.now()) : 1;
      this.applyAppearance(ratio);
      this.applyCardAppearance(ratio);
    }
    this.onCount(count);
  }

  /** 可见数量使用最终筛选结果；退出中的节点仍可短暂绘制，但不再接受选择。 */
  private applyAppearance(ratio: number) {
    const change = this.transition;
    const ease = (value: number) => { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); };
    this.stars.forEach((star, id) => {
      const target = this.desiredAppearance.get(id) ?? { point: 0, halo: 0 };
      const source = change?.appearance.get(id) ?? target;
      const alpha = change?.analysisMorph ? ease(target.point === 0 ? ratio / .42 : ratio / .72) : ease(ratio);
      star.point.material.opacity = THREE.MathUtils.lerp(source.point, target.point, alpha);
      star.halo.material.opacity = THREE.MathUtils.lerp(source.halo, target.halo, alpha);
      star.point.visible = star.point.material.opacity > .002;
      star.halo.visible = star.halo.material.opacity > .002;
    });
    this.connections.forEach((connection, index) => {
      const target = this.desiredLines[index] ?? 0;
      const source = change?.lines[index] ?? target;
      connection.material.opacity = THREE.MathUtils.lerp(source, target, ease(change?.analysisMorph ? ratio / .55 : ratio));
      connection.line.visible = connection.material.opacity > .001;
    });
    const selected = this.selected && this.stars.get(this.selected);
    this.selectionRing.material.opacity = selected ? .28 * selected.point.material.opacity : 0;
  }

  /** 动画进度统一处理减少动态效果设置；用户中途开启该设置时也会立即完成。 */
  private transitionRatio(now: number) {
    const change = this.transition;
    return !change || change.duration === 0 || this.reduceMotion.matches ? 1 : THREE.MathUtils.clamp((now - change.start) / change.duration, 0, 1);
  }

  /** 清理整体文字层的旧透明状态；逐张卡片的展开与点击资格由各自进度决定。 */
  private setContentOpacity(opacity: number) {
    this.contentOpacity = opacity;
    const settled = opacity >= 1;
    this.labelLayer.style.opacity = this.edgeLayer.style.opacity = settled ? '' : String(opacity);
    this.labelLayer.inert = opacity < .35;
    this.connections.forEach(connection => { connection.hit.style.pointerEvents = opacity < .35 ? 'none' : ''; });
    this.container.style.setProperty('--graph-content-opacity', String(opacity));
  }

  /** 卡片各自展开或收拢。共同卡片保持完整，离开的卡片保留到收拢完成后再隐藏。 */
  private applyCardAppearance(ratio: number) {
    const change = this.transition;
    const outCubic = (value: number) => 1 - (1 - THREE.MathUtils.clamp(value, 0, 1)) ** 3;
    this.stars.forEach((star, id) => {
      if (!star.label.classList.contains('analysis-card')) return;
      const desired = this.mode === 'network' ? Boolean(this.analysis?.visibleIds.has(id)) : this.mode === 'mindmap' && (this.desiredAppearance.get(id)?.point ?? 0) > 0;
      const source = change?.cards.get(id) ?? { open: desired && !change ? 1 : 0, opacity: desired && !change ? 1 : 0 };
      const closingShare = Math.min(.68, 240 / Math.max(change?.duration ?? 1, 1));
      const progress = outCubic(ratio / (desired ? .92 : closingShare));
      const open = THREE.MathUtils.lerp(source.open, desired ? 1 : 0, progress);
      const opacity = THREE.MathUtils.lerp(source.opacity, desired ? 1 : 0, progress);
      this.cardAppearance.set(id, { open, opacity });
      star.label.style.setProperty('--card-inset', `${(1 - open) * 50}%`);
      star.label.style.setProperty('--card-text-opacity', String(THREE.MathUtils.smoothstep(open, .2, .78)));
      star.label.style.setProperty('--card-corners-opacity', String(4 * open * (1 - open)));
      star.label.style.opacity = String(opacity);
      // 即使仍在收拢，旧卡片也不再接收点击；共同卡片不锁定，允许继续追踪。
      star.label.inert = !desired || open < .3;
      star.label.hidden = open < .001;
      if (this.mode !== 'network' && this.mode !== 'mindmap' && open < .001) {
        // 收拢到节点后立即接回总览标签，不在动画末尾再突然补上一整批标题。
        star.label.classList.remove('analysis-card','mindmap-card');
        star.label.textContent = star.data.title;
        star.label.style.removeProperty('opacity');
        star.label.inert = false;
        star.label.hidden = false;
        this.labelSizes.set(id, { width: star.label.offsetWidth, height: star.label.offsetHeight });
      }
    });
    this.connections.forEach((connection, index) => {
      const desired = this.mode === 'network' && Boolean(this.analysis?.edgeIndices.includes(index));
      const source = change?.cardEdges[index] ?? (desired && !change ? 1 : 0);
      const opacity = THREE.MathUtils.lerp(source, desired ? 1 : 0, outCubic(ratio));
      this.cardEdgeOpacity[index] = opacity;
      connection.path.style.display = opacity > .001 ? '' : 'none';
      connection.path.style.opacity = String(opacity * (index === this.relationIndex ? 1 : .64));
      connection.label.style.opacity = String(opacity);
      connection.label.inert = !desired || opacity < .3;
      connection.hit.style.display = desired && opacity >= .3 ? '' : 'none';
      connection.label.hidden = opacity < .001;
    });
  }

  /** 镜头与节点共享一条可打断时间线；无需额外计时器，快速往返不会留下旧回调。 */
  private advanceTransition(now: number) {
    const change = this.transition;
    if (!change) return;
    const ratio = this.transitionRatio(now);
    // 外层星图与分层维持原有缓动；分析页面快速响应，不等待一段空白再展示。
    const eased = change.analysisMorph ? 1 - (1 - ratio) ** 3 : ratio < .5 ? 4 * ratio ** 3 : 1 - (-2 * ratio + 2) ** 3 / 2;
    this.currentScale = THREE.MathUtils.lerp(change.scaleFrom, 1, eased);
    this.stars.forEach((star, id) => {
      const start=change.from.get(id)??star.point.position.clone();
      const end=change.to.get(id)??start;
      // 数据变更或旧总览快照留下缺项时只停在当前稳定点，不在每帧抛错。
      if(!change.from.has(id))change.from.set(id,start.clone());
      if(!change.to.has(id))change.to.set(id,end.clone());
      star.point.position.lerpVectors(start,end,eased);
      star.halo.position.copy(star.point.position);
      star.point.scale.setScalar(this.starSize(star.data) * this.currentScale);
      star.halo.scale.setScalar(this.starSize(star.data, true) * this.currentScale);
    });
    this.selectionRing.scale.setScalar(58 * this.currentScale);
    if (!change.cameraInterrupted) {
      interpolateCamera(this.camera.position, this.controls.target, change.cameraFrom, change.targetFrom, change.cameraTo, change.targetTo, eased);
      // 立即同步朝向，连续快切时抓取的屏幕帧与本帧镜头保持一致。
      this.camera.lookAt(this.controls.target);
    }
    this.ambient = THREE.MathUtils.lerp(change.ambientFrom, this.mode === 'galaxy' ? 1 : .24, eased);
    this.applyAppearance(ratio);
    this.setContentOpacity(1);
    this.applyCardAppearance(ratio);
    this.updateConnections();
    this.labelsDirty = true;
    if (ratio === 1) {
      this.transition = null;
      this.controls.enableDamping = true;
      if (this.versionChanging) this.clearRetired();
      this.controls.enabled = true;
      this.controls.maxDistance = this.mode === 'network' ? 10000 : 3400;
      this.setContentOpacity(1);
      if (this.mode !== 'network' && this.mode !== 'mindmap' && change.analysisMorph) this.prepareAnalysis();
      this.container.classList.remove('graph-transitioning');
      delete this.container.dataset.transition;
      this.container.style.removeProperty('--graph-content-opacity');
    }
  }

  /** 对弧线的起点、终点与控制点一并更新，使连线始终跟随正在变换的节点。 */
  private updateConnections() {
    this.connections.forEach(connection => {
      const from = this.stars.get(connection.data.source)!.point.position;
      const to = this.stars.get(connection.data.target)!.point.position;
      connection.curve.v0.copy(from);
      connection.curve.v2.copy(to);
      connection.curve.v1.copy(from).lerp(to, .5);
      connection.curve.v1.z += this.mode === 'galaxy' ? Math.min(from.distanceTo(to) * .15, 70) : 0;
      // 同一端点对可以同时有手工关联与正文引用，二维分开走线，避免来源不可点选。
      if(this.mode!=='galaxy'){const siblings=this.connections.filter(c=>(c.data.source===connection.data.source&&c.data.target===connection.data.target)||(c.data.source===connection.data.target&&c.data.target===connection.data.source));if(siblings.length>1){const slot=siblings.indexOf(connection)-(siblings.length-1)/2,normal=new THREE.Vector3(-(to.y-from.y),to.x-from.x,0).normalize();connection.curve.v1.addScaledVector(normal,slot*48);}}
      const points = connection.curve.getPoints(28);
      const existing = connection.line.geometry.getAttribute('position');
      if (existing) {
        points.forEach((point, index) => existing.setXYZ(index, point.x, point.y, point.z));
        existing.needsUpdate = true;
        connection.line.geometry.computeBoundingSphere();
      } else connection.line.geometry.setFromPoints(points);
      if(connection.material instanceof THREE.LineDashedMaterial)connection.line.computeLineDistances();
    });
    if (this.selected) this.selectionRing.position.copy(this.stars.get(this.selected)!.point.position);
  }

  /** 屏幕标签按“选中→相关→系统→其他”排序，并避让已经放置的标签。 */
  private updateLabels() {
    this.camera.updateMatrixWorld();
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (this.mode === 'network' || this.mode === 'mindmap') { this.updateAnalysisLabels(width, height, this.mode === 'mindmap'); this.labelsDirty = false; return; }
    if ([...this.stars.values()].some(star => star.label.classList.contains('analysis-card'))) this.updateAnalysisLabels(width, height, true);
    const related = this.neighbors();
    const bounds: { x: number; y: number; width: number; height: number }[] = [];
    const score = (star: StarNode) => this.mode === 'layers'
      ? star.data.id === this.coreId() ? -1 : star.data.kind === 'system' ? 0 : star.data.id === this.selected ? 1 : related.has(star.data.id) ? 2 : 3
      : this.mode === 'galaxy' && star.data.id === this.coreId() ? -1 : star.data.id === this.selected ? 0 : related.has(star.data.id) ? 1 : star.data.kind === 'system' ? 2 : 3;
    [...this.stars.values()].sort((a, b) => score(a) - score(b)).forEach(star => {
      if (star.label.classList.contains('analysis-card')) return;
      const point = star.point.position.clone().project(this.camera);
      const eligible = this.labelsAll || this.mode === 'layers' || star.data.kind !== 'rule' || related.has(star.data.id) || Boolean(this.query);
      if (!this.desiredAppearance.get(star.data.id)?.point || !eligible || point.z > 1 || point.z < -1) { star.label.hidden = true; return; }
      star.label.hidden = false;
      const size = this.labelSizes.get(star.data.id)!;
      const labelWidth = size.width;
      const labelHeight = size.height;
      const centerX = (point.x + 1) * width / 2;
      const centerY = (1 - point.y) * height / 2;
      // 总纲与其他节点共用文字避让位置，保留优先级，不再固定挂一张居中的大标签。
      const candidates = this.mode === 'layers'
        ? [{ x: centerX - labelWidth / 2, y: centerY + 9 }, { x: centerX - labelWidth / 2, y: centerY - labelHeight - 10 }, { x: centerX + 12, y: centerY - labelHeight / 2 }, { x: centerX - labelWidth - 12, y: centerY - labelHeight / 2 }]
        : [{ x: centerX + 11, y: centerY - labelHeight / 2 }, { x: centerX - labelWidth - 11, y: centerY - labelHeight / 2 }, { x: centerX - labelWidth / 2, y: centerY + 12 }, { x: centerX - labelWidth / 2, y: centerY - labelHeight - 12 }];
      let choice = candidates.find(candidate => candidate.x >= 8 && candidate.y >= 8 && candidate.x + labelWidth < width - 8 && candidate.y + labelHeight < height - 8 && !bounds.some(bound => candidate.x < bound.x + bound.width + 5 && candidate.x + labelWidth + 5 > bound.x && candidate.y < bound.y + bound.height + 4 && candidate.y + labelHeight + 4 > bound.y));
      if(!choice&&this.mode==='layers'&&(star.data.id===this.coreId()||star.data.kind==='system')&&centerX>=0&&centerX<=width&&centerY>=0&&centerY<=height){
        // 标题位于画面内时，核心和分类即使遇到拥挤也保留可点击文字。
        choice={x:THREE.MathUtils.clamp(centerX-labelWidth/2,8,Math.max(8,width-labelWidth-8)),y:THREE.MathUtils.clamp(centerY+9,8,Math.max(8,height-labelHeight-8))};
      }
      if (!choice) { star.label.hidden = true; return; }
      star.label.style.transform = `translate(${choice.x}px, ${choice.y}px)`;
      bounds.push({ ...choice, width: labelWidth, height: labelHeight });
    });
    this.labelsDirty = false;
  }

  /** 卡片位置与场景节点投影一致，连线截在卡片边缘，点击线或文字均可读完整依据。 */
  private updateAnalysisLabels(width: number, height: number, outgoingOnly = false) {
    const projected = new Map<string, { x: number; y: number; width: number; height: number }>();
    this.stars.forEach(star => {
      const open = this.cardAppearance.get(star.data.id)?.open ?? 0;
      if (!star.label.classList.contains('analysis-card')) {
        if (outgoingOnly) {
          const point = star.point.position.clone().project(this.camera);
          projected.set(star.data.id, { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, width: 0, height: 0 });
        }
        return;
      }
      if (open < .001) { star.label.hidden = true; return; }
      const point = star.point.position.clone().project(this.camera);
      const size = this.labelSizes.get(star.data.id)!;
      const x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
      // 脑图缩放时卡片与节点间距同倍率投影，缩远也不会变成一片重叠的固定像素卡片。
      const defaultDistance=height/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)));
      const cardScale=this.mode==='mindmap'?THREE.MathUtils.clamp(defaultDistance/Math.max(this.camera.position.distanceTo(this.controls.target),150),.08,1.25):1;
      const cardWidth=size.width*cardScale,cardHeight=size.height*cardScale;
      star.label.hidden = point.z > 1 || point.z < -1;
      star.label.style.transformOrigin='top left';
      star.label.style.transform = `translate(${x - cardWidth / 2}px, ${y - cardHeight / 2}px) scale(${cardScale})`;
      // 线的端点追随正在展开的四角边界，不悬在尚未长成的完整卡片边缘。
      projected.set(star.data.id, { x, y, width: cardWidth * open, height: cardHeight * open });
    });
    this.laneHeadings.forEach((heading, lane) => {
      const anchor = this.lanePositions.get(lane);
      if (outgoingOnly || !anchor || !this.analysis) { heading.hidden = true; return; }
      const point = anchor.clone().project(this.camera);
      heading.hidden = false;
      heading.style.left = `${(point.x + 1) * width / 2}px`;
      heading.style.top = `${(1 - point.y) * height / 2}px`;
    });
    this.edgeLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.connections.forEach((connection, index) => {
      if ((this.cardEdgeOpacity[index] ?? 0) < .001) return;
      const from = projected.get(connection.data.source), to = projected.get(connection.data.target);
      if (!from || !to) { connection.label.hidden = true; return; }
      let sx: number, sy: number, tx: number, ty: number, c1x: number, c1y: number, c2x: number, c2y: number;
      if (width < 560) {
        // 窄屏把路径绕到卡片左侧，不让长连接穿过中间的正文。
        sx = from.x - from.width / 2 - 3; sy = from.y;
        tx = to.x - to.width / 2 - 3; ty = to.y;
        c1x = c2x = 15 + index % 3 * 6; c1y = sy; c2y = ty;
      } else {
        const dx = to.x - from.x, dy = to.y - from.y;
        const neighborId = connection.data.source === this.selected ? connection.data.target : connection.data.source;
        const neighborLane = this.analysis?.entries.find(entry => entry.node.id === neighborId)?.lane;
        const sideLane = neighborLane === 'upstream' || neighborLane === 'downstream';
        const sourceRatio = Math.min((from.width / 2 + 5) / Math.max(Math.abs(dx), .01), (from.height / 2 + 5) / Math.max(Math.abs(dy), .01), .45);
        const targetRatio = Math.min((to.width / 2 + 5) / Math.max(Math.abs(dx), .01), (to.height / 2 + 5) / Math.max(Math.abs(dy), .01), .45);
        sx = from.x + dx * sourceRatio; sy = from.y + dy * sourceRatio;
        tx = to.x - dx * targetRatio; ty = to.y - dy * targetRatio;
        // 左右分区始终从卡片侧面进出，使长关系沿列间留白走线，不穿过上方卡片。
        if (sideLane) {
          const direction = dx >= 0 ? 1 : -1;
          sx = from.x + direction * (from.width / 2 + 5); sy = from.y;
          tx = to.x - direction * (to.width / 2 + 5); ty = to.y;
        }
        const horizontal = sideLane || Math.abs(dx) > Math.abs(dy) * .6;
        c1x = horizontal ? (sx + tx) / 2 : sx; c2x = horizontal ? (sx + tx) / 2 : tx;
        c1y = horizontal ? sy : (sy + ty) / 2; c2y = horizontal ? ty : (sy + ty) / 2;
      }
      const siblings=this.connections.filter(c=>(c.data.source===connection.data.source&&c.data.target===connection.data.target)||(c.data.source===connection.data.target&&c.data.target===connection.data.source));
      const laneOffset=(siblings.indexOf(connection)-(siblings.length-1)/2)*54;
      if(siblings.length>1){if(Math.abs(tx-sx)>Math.abs(ty-sy)){c1y+=laneOffset;c2y+=laneOffset;}else{c1x+=laneOffset;c2x+=laneOffset;}}
      const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
      connection.path.setAttribute('d', d); connection.hit.setAttribute('d', d);
      connection.path.setAttribute('marker-end', connection.data.type === 'relates' ? '' : 'url(#analysis-arrow)');
      // 关系标签靠近相邻卡片，减少多个关系在焦点附近重叠。
      const t = connection.data.source === this.selected ? .87 : .13;
      const u = 1 - t;
      const x = u ** 3 * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * tx;
      const y = u ** 3 * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * ty;
      connection.label.hidden = false;
      connection.label.style.left = `${x}px`;
      connection.label.style.top = `${y+laneOffset*.5}px`;
    });
  }

  /** 只在尺寸或字体改变时批量测量标签，避免动画每一帧触发同步页面排版。 */
  private measureLabels() {
    this.stars.forEach(star => { star.label.hidden = false; });
    this.stars.forEach(star => { this.labelSizes.set(star.data.id, { width: star.label.offsetWidth, height: star.label.offsetHeight }); });
    this.labelsDirty = true;
  }

  /** 页面隐藏或切到文档时停止渲染；回到图谱后恢复，避免后台占用显卡。 */
  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (!this.active || document.hidden) {this.lastMotionFrame=0;return;}
    const now = performance.now();
    const delta=this.lastMotionFrame?Math.min((now-this.lastMotionFrame)/1000,.05):0;this.lastMotionFrame=now;
    if(!this.motionPaused&&!this.reduceMotion.matches)this.motionTime+=delta;
    this.advanceTransition(now);
    if(this.labelsDirty)this.updateConnections();
    this.controls.update();
    this.backgrounds.forEach((field, index) => {
      (field.material as THREE.PointsMaterial).opacity = this.ambient * (this.light ? index ? .25 : .13 : index ? .85 : .6);
    });
    this.clouds.forEach(cloud => { cloud.material.opacity = this.ambient * (this.light ? .025 : .055); });
    const galaxyOpacity = Math.max(0, (this.ambient - .24) / .76);
    if (this.galaxyDust) {
      const material=this.galaxyDust.material as THREE.ShaderMaterial;material.uniforms.ambient.value=galaxyOpacity*(this.light?.22:.4);material.uniforms.phase.value=this.motionTime;material.uniforms.tone.value.set(this.light?'#61768d':'#a4b3d5');material.blending=this.light?THREE.NormalBlending:THREE.AdditiveBlending;
      const live=new Set(this.data.nodes.filter(node=>node.kind==='document'&&node.documentType==='dd'&&node.status!=='archived').map(node=>node.id));
      for(const [id,value] of this.dustWeights){const desired=live.has(id)?(this.desiredAppearance.get(id)?.point??1)>0?1:.14:0;this.dustWeights.set(id,this.reduceMotion.matches||this.motionPaused?desired:THREE.MathUtils.lerp(value,desired,1-Math.exp(-delta*5)));}
      const weights=this.galaxyDust.geometry.getAttribute('weight');if(weights){this.dustOwners.forEach((id,i)=>weights.setX(i,this.dustWeights.get(id)??0));weights.needsUpdate=true;}
    }
    const breath=1+Math.sin(this.motionTime*Math.PI/4)*.045;
    if (this.galaxyCore) {this.galaxyCore.material.opacity=galaxyOpacity*Number(Boolean(this.coreId()))*(this.light?.025:.065)*breath;this.galaxyCore.scale.set(165*breath,105*breath,1);}
    const core=this.coreId()?this.stars.get(this.coreId()!):undefined;if(core&&this.mode==='galaxy')core.halo.scale.setScalar(this.starSize(core.data,true)*this.currentScale*breath);
    this.connections.forEach((connection, index) => {
      if (connection.particle.visible) connection.particle.position.copy(connection.curve.getPoint(this.motionPaused || this.reduceMotion.matches ? .52 : (now * .00012 + index * .2) % 1));
    });
    if (this.labelsDirty) { this.updateLabels(); this.captureFrame(); this.interaction?.update(); }
    this.renderer.render(this.scene, this.camera);
  };

  private pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) { if (this.pointerStart) this.pointerStart.moved = true; return; }
    this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  };
  /** 右键拖动仍交给镜头，只有未移动的点击才打开上下文菜单。 */
  private contextDown = (event: PointerEvent) => {if(event.button===2)this.contextStart={x:event.clientX,y:event.clientY,moved:false};};
  private contextMove = (event: PointerEvent) => {if(this.contextStart&&Math.hypot(event.clientX-this.contextStart.x,event.clientY-this.contextStart.y)>5)this.contextStart.moved=true;};
  private contextMenu = (event: MouseEvent) => {
    event.preventDefault();const start=this.contextStart;this.contextStart=undefined;if(start?.moved)return;
    let id=(event.target as HTMLElement).closest<HTMLElement>('[data-graph-node]')?.dataset.graphNode;
    if(!id){const box=this.container.getBoundingClientRect();this.raycaster.setFromCamera(new THREE.Vector2((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1),this.camera);const targets=[...this.stars.values()].filter(star=>star.point.visible&&(this.desiredAppearance.get(star.data.id)?.point??0)>0);const hit=this.raycaster.intersectObjects(targets.map(star=>star.point))[0];id=targets.find(star=>star.point===hit?.object)?.data.id;}
    window.dispatchEvent(new CustomEvent('cewen:graph-context',{detail:{id,x:event.clientX,y:event.clientY}}));
  };
  setContextMenuOpen(open: boolean) {this.controls.enabled=!open&&(this.mode!=='network'||this.reduceMotion.matches);}
  private pointerMove = (event: PointerEvent) => { if (this.pointerStart && Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) this.pointerStart.moved = true; };
  private pointerCancel = () => { this.pointerStart = null; };
  private pointerUp = (event: PointerEvent) => {
    const start = this.pointerStart; this.pointerStart = null;
    if (!start || start.id !== event.pointerId || start.moved || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const box = this.container.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return;
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1), this.camera);
    const targets = [...this.stars.values()].filter(star => star.point.visible && this.desiredAppearance.get(star.data.id)?.point);
    const hit = this.raycaster.intersectObjects(targets.map(star => star.point))[0];
    if (hit) this.select(targets.find(star => star.point === hit.object)!.data.id);
    else if (this.mode !== 'network') {this.raycaster.params.Line.threshold=6;const wires=this.connections.filter(c=>c.line.visible&&c.material.opacity>.05),edgeHit=this.raycaster.intersectObjects(wires.map(c=>c.line))[0];const edge=wires.find(c=>c.line===edgeHit?.object);if(edge)this.selectEdge(edge.data.id);else this.clearSelection();}
  };
  private visibilityChanged = () => { if (!document.hidden) this.controls.update(); };

  private resize() {
    if (this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!this.active || !width || !height) return;
    if (this.layoutDeferred || (this.mode === 'network' && width !== this.previousSize.width)) {
      // 响应式分区变化后仍从当前坐标移动，避免卡片瞬间改列。
      this.setMode(this.mode, this.deferredModeOptions);
      return;
    }
    this.camera.aspect = width / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, this.container.clientHeight);
    this.measureLabels();
    // 宽高变化后更新总览距离；动画途中沿用当前目标，避免镜头裁掉两侧系统。
    if (this.transition && !this.transition.restoreOverview) {
      const framing = this.framing(this.transition.to);
      this.transition.cameraTo.copy(framing.position);
      this.transition.targetTo.copy(framing.target);
    }
    else if (!this.transition && (width !== this.previousSize.width || height !== this.previousSize.height)) {
      // 侧栏开合只改变画布比例，保留用户正在使用的观察方向与缩放。
      this.controls.update();
    }
    this.previousSize = { width, height: this.container.clientHeight };
  }

  /** 总览与缩放不改变任何设计数据；返回总览会平滑恢复当前布局。 */
  reset() { this.setMode(this.mode); }

  /** 仅正文、标题或依据变化时原位更新；节点增删由调用方安排结构更新。 */
  updateText(data: KnowledgeData): boolean {
    if (data.nodes.length !== this.data.nodes.length || data.edges.length !== this.data.edges.length || data.groups.length !== this.data.groups.length) return false;
    if (data.nodes.some((node, index) => node.id !== this.data.nodes[index]?.id || node.group !== this.data.nodes[index]?.group || node.kind !== this.data.nodes[index]?.kind || node.documentType !== this.data.nodes[index]?.documentType || node.status !== this.data.nodes[index]?.status)) return false;
    if (data.edges.some((edge, index) => edge.id !== this.data.edges[index]?.id || edge.source !== this.data.edges[index]?.source || edge.target !== this.data.edges[index]?.target || edge.type !== this.data.edges[index]?.type)) return false;
    if (data.rootDocumentId!==this.data.rootDocumentId||data.groups.some((group, index) => group.id !== this.data.groups[index]?.id || group.color !== this.data.groups[index]?.color || group.parent!==this.data.groups[index]?.parent || group.label!==this.data.groups[index]?.label)) return false;
    this.data = data;
    data.nodes.forEach(node => {
      const star = this.stars.get(node.id)!; star.data = node;
      const color=this.nodeColor(node);
      if(star.point.userData.baseColor!==color){
        star.point.userData.baseColor=star.halo.userData.baseColor=color;
        star.point.material.color.copy(this.graphColor(color));star.halo.material.color.copy(this.graphColor(color));
        star.label.style.setProperty('--node-color',categoryColor(color,this.light));
      }
      star.label.setAttribute('aria-label', `查看${node.title}`);
      if (star.label.classList.contains('analysis-card')) {
        star.label.querySelector('strong')!.textContent = node.title;
        star.label.querySelector('.analysis-card-summary')!.textContent = node.summary;
        star.label.querySelector('.analysis-card-meta')!.textContent = `${this.nodeGroupLabel(node)} · ${{ confirmed: '已确认', draft: '草稿', question: '待确认', archived: '已归档' }[node.status]}`;
      } else star.label.textContent = node.title;
    });
    data.edges.forEach((edge, index) => { this.connections[index].data = edge; this.connections[index].label.setAttribute('aria-label', `查看关系依据：${edgeSentence(edge, data.nodes, data.edges)}`); });
    this.analysis = this.selected ? buildAnalysis(this.selected, data.nodes, data.edges) : undefined;
    this.measureLabels(); this.refreshVisibility();
    return true;
  }
  zoom(factor: number) {
    // 分析卡片保持固定字号，采用滚动阅读；只缩小节点间距会使卡片互相遮挡。
    if (this.mode === 'network') return;
    if (this.transition) this.transition.cameraInterrupted = true;
    this.camera.position.sub(this.controls.target).multiplyScalar(factor).add(this.controls.target);
    this.controls.update();
  }
  /** 导航可先恢复显示，再由紧接着的 setMode 统一处理最终尺寸，避免多算一轮旧布局。 */
  setActive(active: boolean, options: { deferLayout?: boolean } = {}) { this.active = active; if (active && !options.deferLayout) this.resize(); }

  /** 在热更新或宿主卸载时释放纹理、几何、监听和动画帧，防止重复场景泄漏。 */
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.transition = null;
    this.navigationFrame = this.lastValidFrame = undefined;
    this.overview = undefined;
    this.setContentOpacity(1);
    this.container.classList.remove('graph-transitioning');
    delete this.container.dataset.transition;
    this.container.style.removeProperty('--graph-content-opacity');
    this.container.style.removeProperty('--analysis-card-width');
    this.container.style.height = '';
    this.container.parentElement?.classList.remove('analysis-mode','mindmap-mode');
    delete this.container.dataset.mode;
    this.controls.dispose();
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    window.removeEventListener('cewen-theme-change', this.themeChanged);
    this.interaction?.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.removeEventListener('pointercancel', this.pointerCancel);
    this.container.removeEventListener('contextmenu',this.contextMenu);this.container.removeEventListener('pointerdown',this.contextDown);this.container.removeEventListener('pointermove',this.contextMove);
    this.scene.traverse(object => {
      const renderable = object as THREE.Mesh;
      renderable.geometry?.dispose();
      if (Array.isArray(renderable.material)) renderable.material.forEach(material => material.dispose());
      else renderable.material?.dispose();
    });
    this.texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
    this.edgeLayer.remove();
  }
}
