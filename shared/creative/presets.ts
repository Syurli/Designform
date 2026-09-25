import { moduleRegistry } from './registry.ts';
import { asString,type CreativeObject,type Data } from './model.ts';
export const presets = [
 {id:'blank',title:'空白创作',description:'从空白开始；随时使用所有模块。',sample:'空白练习'},
 {id:'game',title:'游戏设计',description:'规则、战斗与关卡设计；也可以插入分镜和配音。',sample:'雾港来信 · 游戏章节'},
 {id:'narrative',title:'叙事与世界观',description:'角色、地点、剧情分支与创作问策。',sample:'雾港来信 · 世界观'},
 {id:'screenplay',title:'剧本开发',description:'场次、角色、对白与剧情线；不限制地图和其他模块。',sample:'雨夜候车室'},
 {id:'film',title:'微电影制作',description:'分镜、配音、素材任务与二维有声排演。',sample:'最后一盏灯'},
 {id:'mixed',title:'综合创作',description:'同源地图连通战斗设计、剧情和影像。',sample:'雾港来信'},
] as const;
/** 分类属于公开项目结构，预设只决定初始目录，不限制后续可插入的模块。 */
export const presetGroups = [
 {key:'start',title:'创作起点',color:'#EBC58D'},
 {key:'world',title:'共享世界',color:'#7CBFFF'},
 {key:'space',title:'地点与地图',color:'#7CBFFF',parent:'world'},
 {key:'people',title:'角色与声音',color:'#B5A3F5',parent:'world'},
 {key:'story',title:'故事与规则',color:'#79D9C3'},
 {key:'design',title:'设计专题',color:'#79D9C3',parent:'story'},
 {key:'scenes',title:'剧情与场次',color:'#79D9C3',parent:'story'},
 {key:'film',title:'影像表达',color:'#ED9FAD'},
 {key:'boards',title:'分镜与排演',color:'#ED9FAD',parent:'film'},
 {key:'collaboration',title:'协作与制作',color:'#D9B58C'},
 {key:'quests',title:'Quest 与问题',color:'#D9B58C',parent:'collaboration'},
 {key:'media',title:'演示素材',color:'#D9B58C',parent:'collaboration'},
] as const;
export type PresetGroupKey = typeof presetGroups[number]['key'];
/** 根据内容职责归组，分镜随影像、场次随剧情，地图使用层仍引用共享地图。 */
function documentGroup(key:string):PresetGroupKey {
 if(key==='brief')return 'start';
 if(/^map|^location/.test(key))return 'space';
 if(/^character|^voice/.test(key))return 'people';
 if(/^dd/.test(key))return 'design';
 if(/^scene|^storyline|^speech/.test(key))return 'scenes';
 if(/^shots|^camera-map|^sequence|^shot/.test(key))return 'boards';
 if(/^quest/.test(key))return 'quests';
 return 'start';
}
export interface PresetDocument {id:string;title:string;purpose:string;group:PresetGroupKey;body:string;objects:CreativeObject[]}
export interface PresetContent {title:string;documents:PresetDocument[];questIds:string[];standaloneTargets:string[];prefix:string}
export function buildPreset(presetId:string,prefix:string,sample:boolean,media:Record<string,string>={}):PresetContent {
 const preset=presets.find(p=>p.id===presetId);if(!preset)throw new Error('未知预设');
 const id=(s:string)=>`${prefix}-${s}`,documents:PresetDocument[]=[],questIds:string[]=[];
 const object=(type:string,key:string,title:string,data:Data={})=>{const o=moduleRegistry.get(type)!.create(id(key),title);o.data={...o.data,...data};o.description=sample?'完全虚构的演示内容，非用户真实决定。':'';return o;};
 const doc=(key:string,title:string,objects:CreativeObject[],body='',purpose='creative')=>documents.push({id:id('doc-'+key),title,purpose,group:documentGroup(key),objects,body});
 if(presetId==='blank')return {title:preset.sample,documents,questIds,standaloneTargets:[],prefix};
 if(!sample){
  doc('brief','创作目标',[],'## 目标体验\n\n## 约束与范围\n\n## 尚未决定\n\n此预设仅提供起步结构。全部模块可在任意文档使用。');
  const types=presetId==='game'?['map','character','quest']:presetId==='narrative'?['character','location','storyline']:presetId==='screenplay'?['character','scene','speech']:['character','scene','shot','sequence'];
  for(const [i,type] of types.entries()){const o=object(type,`start-${i}`,moduleRegistry.get(type)!.title,type==='quest'?{goal:'明确本项目的首个创作目标'}:type==='speech'?{text:'在这里编写第一句台词'}:{});doc(type,o.title,[o]);if(type==='quest')questIds.push(o.id);}
  return {title:preset.title,documents,questIds,standaloneTargets:[documents[0].id],prefix};
 }
 const sceneCount=presetId==='screenplay'?3:presetId==='film'?2:4,shotCount=presetId==='film'?8:12;
 const focus=({game:'从战斗路线与资源风险切入，再观察同一地图如何服务剧情和镜头。',narrative:'从人物动机、地点与分支切入，再核对地图和场次的共同来源。',screenplay:'从雨夜候车室的场次、对白与潜台词切入，再检查分镜和声音。',film:'从灯下信件的连续画面、声音和排演节奏切入，再追溯剧情依据。',mixed:'从共享地图开始，贯通战斗 DD、剧情线、Quest、分镜和素材生产。'} as Record<string,string>)[presetId]??'';
 doc('brief','创作总览',[],`## 一个雨夜，一封没有收件人的信\n\n送信人来到雾港货运站，在灯灭之前决定从哪条路离开。游戏章节、剧本和短片共用角色与地图。\n\n**这是演示资料，不是真实项目。示意图不是最终美术，合成配音不是表演成品。**\n\n## 本示例的学习重点\n\n${focus}\n\n## 练习主线\n\n先阅读对应专题，再从共享地图发起 Quest，调整出口暴露时机，查看分镜与排演，导出生产任务并回导候选。`);
 doc('map','货运站共享地图',[object('map','map-station','货运站',{mediaId:media['map-0.png']??'',points:[{id:'gate',x:.12,y:.66,label:'正门'},{id:'bridge',x:.88,y:.55,label:'桥下出口'},{id:'platform',x:.50,y:.83,label:'站台'}]})]);
 doc('map2','街区共享地图',[object('map','map-town','旧城街区',{mediaId:media['map-1.png']??'',points:[{id:'lamp',x:.45,y:.30,label:'最后一盏灯'}]})]);
 const overlay=(key:string,title:string,purpose:string)=>object('map-use',key,title,{mapId:id('map-station'),purpose,points:[{id:`${key}-focus`,x:key==='use-combat'?.30:.70,y:.5,label:purpose}],paths:[{id:`${key}-path`,label:purpose,points:key==='use-combat'?'0.12,0.66;0.35,0.60;0.50,0.83':'0.50,0.83;0.72,0.64;0.88,0.55'}]});
 const gameLike=['game','mixed'].includes(presetId);
 const ddNames=gameLike?['战斗遭遇设计','撤离路线设计','交互与线索','资源与风险','过场衔接','音画反馈']:presetId==='screenplay'?['主题与基调','人物动机','场景调度','对白策略','节拍调整','潜台词与回收']:presetId==='narrative'?['世界设定','人物关系','地点与事件','信息释放','分支衔接','主题回收']:['影像意图','场次衔接','视觉线索','表演方向','镜头节奏','音画同步'];
 const filmNotes=['先建立人物与出口的相对位置，再决定何时让观众注意到桥下。','人物进入和离开均通过同一地点与地图解释，避免空间连续性混乱。','信封、灯光与远处列车声构成线索链。','允许通过停顿、回避视线和动作表达动机，不将所有内心活动变成旁白。','切镜围绕信息与情绪节拍，镜头和台词各自保持唯一来源。','配音可以跨镜；留白与环境声音共同参与叙事。'];
 for(const [i,title] of ddNames.entries())doc('dd'+i,title,i===0?[overlay('use-combat',gameLike?'战斗部署覆盖层':'场景调度覆盖层',gameLike?'掩体与撤离路线':'人物站位与场景动线')]:[object('reference',`ref-map-dd${i}`,'货运站引用',{objectId:id('map-station'),note:'只引用基础地图，不复制它。'})],`## 设计目标\n\n${(gameLike?['玩家利用仓库之间的遮挡穿过站台；提前暴露桥下出口可能削弱探索。','正门是明显但危险的路线，桥下是需要观察才能发现的选择。','信封、灯光与远处列车声构成线索链。','不增加永久数值成长，以局内选择表达风险。','游戏交互结束后接续短片，角色与场景身份不变。','用局部声音和留白提示方向，不替玩家作出决定。']:filmNotes)[i]}\n\n## 待复核\n\n同一地图的基础地点来自共享源，当前文档只保留本处规则。`,gameLike?'game-design':'creative-notes');
 const names=['阿灯','岑禾','站务员','回信人'];
 const lines=['请关灯。','这封信，给你。','走桥下。','我会留下。','雨停了。','收好地图。','那是信号。','天快亮了。','你为什么还在等？','因为有人会回来。','正门不能走了。','那就听列车的声音。','灯灭之前能赶上吗？','走吧，我记得路。','信不该留在这里。','我们会把它送到。'];
 doc('voice','演示声音方案',[object('voice','voice','普通话合成演示音',{language:'zh-CN',style:'机械合成音，仅验证对白、时间轴与音轨，不代表最终演技。',permission:'eSpeak 内置 Mandarin 声音生成；不含真人克隆。',sampleMediaId:media['demo-voice-1.mp3']??''})]);
 for(let i=0;i<4;i++)doc(`character${i}`,names[i],[object('character',`char${i}`,names[i],{identity:['夜间送信人','等待回信的人','知道桥下通道的站务员','尚未出现的回信人'][i],motivation:'在雨停之前完成自己的选择。',voiceId:id('voice'),mediaId:media[`board-${i+2}.png`]??'',variants:[{id:'dry',name:'进入货运站',description:'深色外套，尚未淋湿'},{id:'rain',name:'雨夜离开',description:'同一外套，被雨淋湿'}]})]);
 doc('location0','货运站',[object('location','location0','货运站',{space:'仓库位于两侧，站台在南面，桥下出口在东面。',time:'雨夜',lighting:'站台冷光与一盏旧灯',mapId:id('map-station')})]);
 doc('location1','候车室',[object('location','location1','候车室',{space:'长椅面对站台，门在右侧。',time:'黎明前',lighting:'微弱窗光',mapId:id('map-town')})]);
 for(let i=0;i<sceneCount;i++){
  const speeches=lines.slice(i*4,i*4+4).map((text,j)=>object('speech',`speech${i*4+j}`,`台词 ${i*4+j+1}`,{text,characterId:id(`char${j%3}`),voiceId:id('voice'),performance:'短句之后留出观察时间',mediaId:media[`demo-voice-${i*4+j+1}.mp3`]??''}));
  doc(`scene${i}`,['抵达','交接','选择','离开'][i],[object('scene',`scene${i}`,['抵达','交接','选择','离开'][i],{interior:i%2?'内景':'外景',locationId:id('location'+i%2),time:i===3?'黎明':'夜',goal:['建立来意','改变原本计划','做出路线选择','留下余味'][i],action:'人物通过动作与停顿表达不确定，而不是解释所有信息。',characterIds:[id('char0'),id('char1')],speechIds:speeches.map(s=>s.id)}),...speeches],'本场对白是唯一原文来源；分镜和声音位置都引用它。','scene');
 }
 doc('storyline','剧情线与路线',[overlay('use-story','剧情路线覆盖层','事件发生与角色路线'),object('storyline','storyline','送信主线',{mapUseId:id('use-story'),start:'beat0',selectedPath:'beat0,beat1,beat2,beat4,beat6,beat7',nodes:Array.from({length:8},(_,i)=>({id:`beat${i}`,title:['抵达','观察灯光','得到信件','正门受阻','发现桥下','留下等待','选择离开','天亮'][i],text:'本节点可发起独立 Quest。',sceneId:id(`scene${Math.min(sceneCount-1,Math.floor(i/2))}`),next:i===2?'beat3,beat4':i===4?'beat5,beat6':i<7?`beat${i+1}`:''}))})]);
 doc('camera-map','机位与画面示意',[overlay('use-shot','镜头覆盖层','机位方向；非三维坐标')]);
 for(let scene=0;scene<sceneCount;scene++){
  const shots:CreativeObject[]=[];for(let i=scene;i<shotCount;i+=sceneCount){const panelCount=i<shotCount/2?2:1;shots.push(object('shot',`shot${i}`,`镜头 ${String(i+1).padStart(2,'0')}`,{sceneId:id(`scene${scene}`),mapUseId:id('use-shot'),framing:i%3===0?'远景':i%3===1?'中景':'近景',movement:i%2?'缓慢推进意图':'固定',action:['雨中货运站建立空间','人物发现灯下的信','视线转向桥下出口','停顿后向站台走去'][i%4],estimatedMs:presetId==='film'?6000:6500,speechIds:[id(`speech${i%(sceneCount*4)}`)],panels:Array.from({length:panelCount},(_,j)=>({id:`panel-${i}-${j}`,caption:j?'动作结束，保留环境空镜':'动作开始，角色面向站台',durationMs:Math.round((presetId==='film'?6000:6500)/panelCount),mediaId:media[`board-${2+(i+j)%8}.png`]??''}))}));}
  doc('shots'+scene,`场次 ${scene+1} · 分镜`,shots,'每个镜头可含连续画面；生成候选不要追加为连续画面。','storyboard');
 }
 doc('sequence','有声分镜排演',[object('sequence','sequence',preset.sample+' · 初稿排演',{path:'选择桥下出口的线性路径；其他分支不自动拼接',items:Array.from({length:shotCount},(_,i)=>({id:`take-${i}`,shotId:id('shot'+i),durationMs:presetId==='film'?6000:6500})),audio:Array.from({length:sceneCount*4},(_,i)=>({id:`cue-${i}`,speechId:id('speech'+i),startMs:Math.round(i*(presetId==='film'?48000:78000)/(sceneCount*4)),offsetMs:0}))})]);
 const goals=['是否提前展示桥下出口？','阿灯留下的动机是否足够？','交接段的停顿与镜头长度','告别段需要多少信息？'];
 for(let i=0;i<4;i++){const q=object('quest',`quest${i}`,goals[i],{goal:goals[i],scope:'明确区分游戏体验、剧情信息和镜头表达。',targetIds:i===0?[id('map-station'),id('use-combat'),id('storyline'),id('shot0')]:[id('shot'+i),id('speech'+i)],documentIds:id('doc-dd0')});questIds.push(q.id);doc('quest'+i,goals[i],[q], '所有初始轮次和回答均为演示数据，可在副本中练习。','quest');}
 return {title:preset.sample,documents,questIds,standaloneTargets:[id('doc-dd0'),id('doc-scene0')],prefix};
}
