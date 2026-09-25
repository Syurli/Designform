import { asRows, asString, asStrings, objectIdPattern, type CreativeObject, type ModuleDefinition, type ModuleField, type Data } from './model.ts';
const text = (key:string,label:string,kind:ModuleField['kind']='text',extra:Partial<ModuleField>={}):ModuleField => ({key,label,kind,...extra});
const ref = (key:string,label:string,objectType?:string):ModuleField => text(key,label,'object',{objectType});
const rows = (key:string,label:string,fields:ModuleField[]):ModuleField => text(key,label,'rows',{fields});
const num = (key:string,label:string,max=86400000):ModuleField => text(key,label,'number',{min:0,max});
const point = [text('id','稳定身份'),num('x','X（0～1）',1),num('y','Y（0～1）',1),text('label','标注'),ref('objectId','关联对象')];
const fields: {type:string;title:string;description:string;fields:ModuleField[];defaults:Data}[] = [
 {type:'character',title:'角色卡',description:'共享人物设定、视觉版本与声音方案。',fields:[text('identity','身份'),text('motivation','动机','longtext'),text('personality','性格与语言习惯','longtext'),ref('voiceId','声音方案','voice'),ref('mediaId','默认形象','media'),rows('variants','造型 / 场景状态',[text('id','版本身份'),text('name','名称'),text('description','说明','longtext'),ref('mediaId','形象图','media')])],defaults:{identity:'',motivation:'',personality:'',variants:[]}},
 {type:'location',title:'地点卡',description:'空间、时间、光照与场景资料；不是场次。',fields:[text('space','空间关系','longtext'),text('time','时段 / 天气'),text('lighting','光线'),ref('mapId','平面地图','map'),ref('mediaId','参考图','media')],defaults:{space:'',time:'',lighting:''}},
 {type:'map',title:'地图卡',description:'共享二维底图与基础标记；没有标尺时只表示示意。',fields:[ref('mediaId','底图','media'),text('units','单位说明'),rows('points','基础地点标记',point),rows('paths','基础路线',[text('id','路线身份'),text('label','名称'),text('points','归一化坐标 x,y; x,y; …')]),rows('areas','基础区域',[text('id','区域身份'),text('label','名称'),text('points','归一化坐标 x,y; x,y; …')])],defaults:{units:'归一化二维示意，未标定真实距离',points:[],areas:[]}},
 {type:'map-use',title:'地图引用与覆盖层',description:'同源地图可用于战斗、剧情或分镜；标注仅修改此使用实例。',fields:[ref('mapId','共享地图','map'),text('purpose','本处用途'),rows('points','当前用途标记',point),rows('paths','路线 / 机位示意',[text('id','路线身份'),text('label','名称'),text('points','坐标 x,y; x,y; …')]),rows('areas','当前用途区域',[text('id','区域身份'),text('label','名称'),text('points','坐标 x,y; x,y; …')])],defaults:{purpose:'',points:[],paths:[],areas:[]}},
 {type:'storyline',title:'剧情线',description:'事件与显式分支，可关联地点、场次、地图。',fields:[ref('mapUseId','地图覆盖层','map-use'),text('start','起点节点身份'),rows('nodes','剧情事件',[text('id','节点身份'),text('title','事件'),text('text','内容','longtext'),ref('sceneId','关联场次','scene'),text('next','下一节点 ID，逗号分隔')]),text('selectedPath','当前排演路径 ID，逗号分隔')],defaults:{start:'',nodes:[],selectedPath:''}},
 {type:'scene',title:'场次',description:'一段发生在某个地点的戏，引用角色与台词。',fields:[text('interior','内 / 外景','select',{options:['内景','外景','内外景']}),ref('locationId','地点','location'),text('time','时段'),text('goal','场次目的','longtext'),text('action','动作 / 内容','longtext'),text('characterIds','出场角色','objects',{objectType:'character'}),text('speechIds','对白 / 旁白','objects',{objectType:'speech'})],defaults:{interior:'内景',time:'',goal:'',action:'',characterIds:[],speechIds:[]}},
 {type:'voice',title:'声音档案',description:'声音风格、授权和试音；不绑定单一生成厂商。',fields:[text('language','语言'),text('style','声音风格','longtext'),text('pronunciation','专名读音与停顿','longtext'),text('permission','授权来源 / 使用范围','longtext'),ref('sampleMediaId','试音','media')],defaults:{language:'zh-CN',style:'',pronunciation:'',permission:''}},
 {type:'speech',title:'对白 / 旁白行',description:'台词只有一份来源，镜头和配音均引用它。',fields:[ref('characterId','角色','character'),ref('voiceId','声音方案','voice'),text('mode','声音类型','select',{options:['对白','旁白','声音说明']}),text('text','原文','longtext',{required:true}),text('performance','表演 / 情绪 / 停顿','longtext'),ref('mediaId','采用配音','media')],defaults:{mode:'对白',text:'',performance:''}},
 {type:'shot',title:'镜头 / 分镜',description:'稳定镜头身份，一镜可含多个连续画面，每画面可有多个候选。',fields:[ref('sceneId','所属场次','scene'),ref('mapUseId','机位示意','map-use'),text('framing','景别 / 角度'),text('movement','运动意图'),rows('characterVariants','本镜角色造型',[text('id','本处身份'),ref('characterId','角色','character'),text('variantId','造型版本身份')]),text('action','镜头描述','longtext'),num('estimatedMs','预计时长（毫秒）'),text('speechIds','关联台词','objects',{objectType:'speech'}),rows('panels','连续画面（不是候选）',[text('id','画面身份'),text('caption','画面内容','longtext'),num('durationMs','画面时长（毫秒）'),ref('mediaId','采用图片','media')])],defaults:{framing:'中景',movement:'固定',action:'',estimatedMs:5000,speechIds:[],panels:[]}},
 {type:'sequence',title:'排演序列',description:'引用镜头而不复制镜头正文，所有时间统一使用整数毫秒。',fields:[text('path','已选择的剧情路径'),rows('items','镜头顺序',[text('id','出现实例身份'),ref('shotId','镜头','shot'),num('durationMs','时长（毫秒）')]),rows('audio','独立声音位置',[text('id','音轨身份'),ref('speechId','台词','speech'),num('startMs','序列起点（毫秒）'),num('offsetMs','音频裁切起点（毫秒）'),text('timingMode','时间锁定','select',{options:['follow-shot','absolute']})])],defaults:{path:'',items:[],audio:[]}},
 {type:'decision',title:'决定记录',description:'建议、用户确认与逐目标落实分开；确认必须来自工作台。',fields:[text('text','决定内容','longtext'),text('questionIds','来源问题 ID，逗号分隔'),text('targetIds','落实目标','objects'),text('rationale','理由','longtext')],defaults:{text:'',questionIds:'',targetIds:[],rationale:''}},
 {type:'reference',title:'共享对象引用',description:'本处只引用同一源对象，不复制正文。',fields:[ref('objectId','源对象'),text('note','本处说明','longtext')],defaults:{objectId:'',note:''}},
 {type:'quest',title:'Quest / 问策',description:'围绕一个创作目标逐轮收敛，不是自由聊天或游戏任务执行器。',fields:[text('goal','目标','longtext',{required:true}),text('scope','范围 / 约束','longtext'),text('targetIds','关联创作对象','objects'),text('documentIds','关联文档 ID，逗号分隔'),text('state','任务状态','select',{options:['open','paused','closed','archived']}),text('closureReason','关闭原因','longtext')],defaults:{goal:'',scope:'',targetIds:[],documentIds:'',state:'open',closureReason:'',rounds:[]}},
 {type:'media',title:'媒体版本',description:'不可变图片或声音。用媒体导入创建，不直接编辑字节。',fields:[text('originalName','来源文件'),text('mime','格式'),text('permission','许可 / 使用范围','longtext')],defaults:{originalName:'',mime:'',path:'',sha256:'',bytes:0}},
 {type:'production',title:'素材生产批次',description:'固定任务身份和依赖，生成完成仅进入候选，采用由用户确认。',fields:[text('purpose','本轮目标','longtext'),text('provider','目标产线'),text('externalScope','拟外发资料','longtext')],defaults:{purpose:'',provider:'通用文件包',jobs:[]}},
];
/** 白名单字段描述同时服务于表单、参数校验与模型能力发现。 */
function checkFields(data:Data, definitions:ModuleField[], prefix=''):string[] {
 const errors:string[]=[];
 for(const f of definitions){const v=data[f.key],name=prefix+f.label;if(v===undefined||v===''){if(f.required)errors.push(`${name}不能为空`);continue;}
  if(['text','longtext','select','object'].includes(f.kind)&&typeof v!=='string')errors.push(`${name}必须是文字`);
  if(f.kind==='number'&&(typeof v!=='number'||!Number.isFinite(v)||v<(f.min??0)||v>(f.max??Number.MAX_SAFE_INTEGER)))errors.push(`${name}数值超出范围`);
  if(f.key.endsWith('Ms')&&typeof v==='number'&&!Number.isInteger(v))errors.push(`${name}必须为整数毫秒`);
  if(f.kind==='select'&&f.options&&!f.options.includes(asString(v)))errors.push(`${name}选项无效`);
  if(f.kind==='object'&&v&&!objectIdPattern.test(asString(v)))errors.push(`${name}对象身份无效`);
  if(f.kind==='objects'&&(!Array.isArray(v)||v.some(id=>typeof id!=='string'||!objectIdPattern.test(id))))errors.push(`${name}需要对象身份列表`);
  if(f.kind==='rows'){
   if(!Array.isArray(v)||v.some(r=>!r||typeof r!=='object'||Array.isArray(r))){errors.push(`${name}需要行列表`);continue;}
   const seen=new Set<string>(); for(const row of asRows(v)) {const id=asString(row.id);if(!objectIdPattern.test(id)||seen.has(id))errors.push(`${name}行身份缺失或重复`);seen.add(id);errors.push(...checkFields(row,f.fields??[],name+' / '));}
  }
 }
 return errors;
}
function deps(data:Data, definitions:ModuleField[], prefix=''):{id:string;role:string}[]{return definitions.flatMap(f=>f.kind==='object'&&data[f.key]?[{id:asString(data[f.key]),role:prefix+f.label}]:f.kind==='objects'?asStrings(data[f.key]).map(id=>({id,role:prefix+f.label})):f.kind==='rows'?asRows(data[f.key]).flatMap(r=>deps(r,f.fields??[],prefix+f.label+' / ')):[]);}
export const moduleRegistry = new Map<string,ModuleDefinition>(fields.map(d=>[d.type,{
 type:d.type,title:d.title,description:d.description,schemaVersion:1,fields:d.fields,
 create:(id,title)=>({schema:1,id,type:d.type,title:title||d.title,status:'draft',tags:[],data:structuredClone(d.defaults)}),
 validate:(o)=>checkFields(o.data,d.fields),dependencies:(o)=>deps(o.data,d.fields),summary:o=>o.description||asString(o.data.goal)||asString(o.data.text)||asString(o.data.action)||asString(o.data.space)||d.description,
}]));
export function validateObject(o:CreativeObject):string[]{
 const errors:string[]=[];
 if(!o||typeof o!=='object'||Array.isArray(o))return ['创作对象必须为字段对象'];
 if(!objectIdPattern.test(o.id))errors.push('对象身份无效');if(!o.title?.trim()||o.title.length>200)errors.push('对象标题需为 1～200 字符');
 if(!o.data||typeof o.data!=='object'||Array.isArray(o.data))return [...errors,'data 必须为字段对象'];
 if(o.schema!==1)return [...errors,'未知模块 schema，保留原文但不能编辑'];
 if(!moduleRegistry.has(o.type))return [...errors,'未知模块类型，保留原文但不能编辑'];
 if(o.type==='storyline'){
  const nodes=asRows(o.data.nodes),ids=new Set(nodes.map(n=>asString(n.id))),start=asString(o.data.start),selected=asString(o.data.selectedPath).split(',').map(s=>s.trim()).filter(Boolean);
  if(start&&!ids.has(start))errors.push('剧情起点不存在');
  for(const node of nodes)for(const id of asString(node.next).split(',').map(s=>s.trim()).filter(Boolean))if(!ids.has(id))errors.push(`剧情节点 ${node.id} 的后续节点不存在：${id}`);
  for(let i=0;i<selected.length;i++){if(!ids.has(selected[i]))errors.push('所选剧情路径包含缺失节点');if(i>0&&!asString(nodes.find(n=>n.id===selected[i-1])?.next).split(',').map(s=>s.trim()).includes(selected[i]))errors.push('所选剧情路径没有对应显式连接');}
 }
 if(o.type==='map'||o.type==='map-use')for(const row of [...asRows(o.data.areas),...asRows(o.data.paths)]){const points=asString(row.points);if(points&&points.split(';').some(pair=>{const parts=pair.trim().split(',').map(Number);return parts.length!==2||parts.some(n=>!Number.isFinite(n)||n<0||n>1);}))errors.push('二维坐标需为 0～1 的 x,y 点列');}
 return [...errors,...moduleRegistry.get(o.type)!.validate(o)];
}
export function moduleCatalog(){return [...moduleRegistry.values()].map(({type,title,description,schemaVersion,fields})=>({type,title,description,schemaVersion,fields}));}
