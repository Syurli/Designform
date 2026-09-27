import { createTransient,transientApi,transientUpload } from './transient-projects';
import { instantiateDocumentPreset,builtinDocumentPresets } from '../shared/document-presets';
import { moduleRegistry } from '../shared/creative/registry';
import { objectBlock } from '../shared/creative/content';
import { readHeader } from '../shared/markdown';
import { setMetadata } from '../shared/editing';
import type { ProjectSnapshot,FileChange } from '../shared/model';

/** 入门示例只含一个学习目标和少量文档；所有服务操作均在内存文件树运行。 */
export async function createLearningExample(kind:string){
  if(kind==='mixed')return createTransient('雾港来信 · 综合学习示例','example','mixed');
  const names:Record<string,string>={documents:'纸上远行 · 文档、分类与引用',game:'雾港来信 · 游戏设计',narrative:'雾港来信 · 世界观',film:'最后一盏灯 · 短片',cards:'学习基础文档预设',maps:'学习共享地图与覆盖层',screenplay:'雨夜候车室 · 场次与对白'};
  let snapshot=await createTransient(names[kind]??'文档练习','example');
  // 示例媒体读取发行包内虚构素材，只注册到当前内存会话。
  const media=async(name:string)=>{const {sampleMedia}=await import('../shared/creative/sample-media.generated');const sample=sampleMedia.find(m=>m.name===name)!;const bytes=Uint8Array.from(atob(sample.data),c=>c.charCodeAt(0));const result=await transientUpload(snapshot.project.id,new File([bytes],name,{type:sample.mime}),{requestId:crypto.randomUUID(),permission:'虚构教学示意素材，合成演示声音，非真人表演',durationMs:sample.durationMs});snapshot=result.snapshot;return {id:result.mediaId,text:sample.text};};
  const prefix='learn-'+crypto.randomUUID().slice(0,8),changes:FileChange[]=[];
  const add=(key:string,title:string,body:string,category:string)=>{const id=prefix+'-'+key;changes.push({path:`docs/dd/${key}.md`,baseHash:null,text:`---\nid: ${id}\ntype: dd\nstatus: draft\nsystem: ${category}\n---\n\n# ${title}\n\n${body}\n`});return id;};
  add('start','从这里开始','## 这是一份可编辑的学习文档\n\n双击文字块编辑，拖动块顶部调整位置。空白区域左键拖动平移，右键拖动框选。\n\n## 试一试\n\n1. 从左侧打开另一份文档。\n2. 使用右侧插入菜单添加模块。\n3. 保存时另存为你自己的项目。关闭此示例不会保留编辑。','learn');
  if(kind==='cards'){
    for(const key of ['character','item']){const preset=builtinDocumentPresets.find(p=>p.id==='builtin-'+key)!,value=instantiateDocumentPreset(preset,key==='character'?'虚构角色 · 灯塔守望者':'虚构道具 · 信号灯');changes.push({path:`docs/dd/${key}.md`,baseHash:null,text:setMetadata(value.markdown,{system:'materials'})});}
  }else if(kind==='maps'){
    const map=moduleRegistry.get('map')!.create(prefix+'-map','港口底图');map.data.points=[{id:prefix+'-point',x:.25,y:.5,label:'灯塔',objectId:''}];
    const local=moduleRegistry.get('map-use')!.create(prefix+'-overlay','追逐段落的路线');local.data.mapId=map.id;local.data.purpose='只服务这段虚构追逐';local.data.points=[{id:prefix+'-local',x:.7,y:.3,label:'临时集合点',objectId:''}];
    add('map','共享港口地图','所有使用位置共享这份基础地图。\n\n'+objectBlock(map),'materials');
    add('scene','追逐段落','下面的标记只属于这个覆盖层；编辑它不会改变港口底图。\n\n'+objectBlock(local),'work');
  }else if(kind==='screenplay'||kind==='film'){
    const image=await media('board-2.png'),audio=await media('demo-voice-1.mp3');
    const character=moduleRegistry.get('character')!.create(prefix+'-character','虚构人物 · 守灯人'),location=moduleRegistry.get('location')!.create(prefix+'-location',kind==='film'?'灯塔门口':'雨夜候车室');
    add('people','人物与地点资料',objectBlock(character)+'\n\n'+objectBlock(location),'materials');
    const speech=moduleRegistry.get('speech')!.create(prefix+'-speech','一句虚构对白');speech.data.text=audio.text||'灯还亮着。';speech.data.mediaId=audio.id;speech.data.characterId=character.id;
    const scene=moduleRegistry.get('scene')!.create(prefix+'-scene','灯塔入口');scene.data.goal='通过一句话建立希望';scene.data.speechIds=[speech.id];scene.data.characterIds=[character.id];scene.data.locationId=location.id;
    const shot=moduleRegistry.get('shot')!.create(prefix+'-shot','中景 · 门口');shot.data.sceneId=scene.id;shot.data.speechIds=[speech.id];shot.data.action='人物转身，看向远处的灯光。';shot.data.panels=[{id:prefix+'-panel',mediaId:image.id,caption:'虚构教学分镜，非成品',durationMs:5000}];
    const sequence=moduleRegistry.get('sequence')!.create(prefix+'-sequence','文字排演');sequence.data.items=[{id:prefix+'-take',shotId:shot.id,durationMs:5000}];sequence.data.audio=[{id:prefix+'-audio',speechId:speech.id,startMs:200,offsetMs:0}];
    add('scene','场次与对白',objectBlock(scene)+'\n\n'+objectBlock(speech),'work');add('boards','分镜与排演',objectBlock(shot)+'\n\n'+objectBlock(sequence),'work');
  }else if(kind==='narrative'){
    const character=moduleRegistry.get('character')!.create(prefix+'-character','守灯人');character.data.description='担心灯光熄灭，但尚未说出原因。';const location=moduleRegistry.get('location')!.create(prefix+'-location','雾港灯塔');add('world','世界与地点',objectBlock(location)+'\n\n这片虚构海岸通过灯光约定彼此的消息。','materials');add('people','人物与动机',objectBlock(character)+'\n\n[查看世界与地点](world.md)','work');
  }else{
    add('idea','灯塔设想','## 目标体验\n\n让探索者通过光线找到路径。\n\n## 相关设计\n\n[信号规则](rules.md)','work');add('rules','信号规则','## 一条待讨论的规则\n\n每次点亮信号灯会暴露一条新路径。这个虚构规则尚未经过验证。\n\n[返回设想](idea.md)','work');
  }
  changes.push({path:'PROJECT.md',baseHash:snapshot.projectEntry!.hash,text:setMetadata(snapshot.projectEntry!.text,{systems:[{id:'learn',title:'开始学习',color:'#EBC58D'},{id:'materials',title:'共享资料',color:'#7CBFFF'},{id:'work',title:'创作内容',color:'#79D9C3'}].filter(g=>changes.some(c=>c.text&&readHeader(c.text).metadata.system===g.id))})});
  return transientApi(`/api/projects/${snapshot.project.id}/commit`,{projectId:snapshot.project.id,requestId:crypto.randomUUID(),baseRevision:snapshot.revision,actor:'user',reason:'准备内存学习示例',changes}) as Promise<ProjectSnapshot>;
}
