import type { CreativeIndex, CreativeObject, Data } from './model.ts';
import { asNumber, asRows, asString } from './model.ts';
export interface Frame { itemId:string; shotId:string; panelId:string; title:string; description:string; mediaId:string; startMs:number; endMs:number; speechIds:string[] }
export interface AudioCue { id:string; speechId:string; text:string; character:string; mediaId:string; startMs:number; offsetMs:number; durationMs:number }
export interface PlaybackPlan { sequence:CreativeObject; frames:Frame[]; audio:AudioCue[]; durationMs:number; warnings:string[] }
/** 固定的排演计划不借用播放器之后收到的新快照；声音与画面使用同一毫秒时间基准。 */
export function compileSequence(index:CreativeIndex,sequenceId:string):PlaybackPlan {
 const byId=new Map(index.objects.map(x=>[x.object.id,x.object])),sequence=byId.get(sequenceId);if(sequence?.type!=='sequence')throw new Error('请选择排演序列');
 const frames:Frame[]=[],audio:AudioCue[]=[],warnings:string[]=[];let cursor=0;
 for(const item of asRows(sequence.data.items)) {
  const shot=byId.get(asString(item.shotId));if(shot?.type!=='shot'){warnings.push(`镜头 ${item.shotId} 缺失，未推测画面`);continue;}
  const duration=Math.round(asNumber(item.durationMs)||asNumber(shot.data.estimatedMs,4000));if(duration<1||duration>3600000)throw new Error('单个镜头时长需为 1～3600000 毫秒');
  const panels=asRows(shot.data.panels), weights=panels.map(p=>Math.max(1,asNumber(p.durationMs,1))),sum=weights.reduce((a,b)=>a+b,0);let local=0;
  for(const [i,panel] of (panels.length?panels:[{id:'missing',caption:'尚未提供分镜图'} as Data]).entries()) {
   const next=panels.length?(i===panels.length-1?duration:Math.round(duration*weights.slice(0,i+1).reduce((a,b)=>a+b,0)/sum)):duration;
   frames.push({itemId:asString(item.id),shotId:shot.id,panelId:asString(panel.id),title:shot.title,description:[asString(shot.data.framing),asString(shot.data.movement),asString(shot.data.action),asString(panel.caption)].filter(Boolean).join(' · '),mediaId:asString(panel.mediaId),startMs:cursor+local,endMs:cursor+next,speechIds:Array.isArray(shot.data.speechIds)?shot.data.speechIds as string[]:[]});local=next;
  }
  cursor+=duration;
 }
 for(const cue of asRows(sequence.data.audio)) {
  const speech=byId.get(asString(cue.speechId));if(speech?.type!=='speech'){warnings.push(`台词 ${cue.speechId} 缺失`);continue;}
  const media=byId.get(asString(speech.data.mediaId)),duration=asNumber(media?.data.durationMs),start=asNumber(cue.startMs),offset=asNumber(cue.offsetMs);
  if(!media)warnings.push(`${speech.title}：无配音，仍显示字幕`);
  if(duration&&start+Math.max(0,duration-offset)>cursor)warnings.push(`${speech.title} 的声音长于当前画面，请确认延长还是缩短；播放器不会改稿`);
  audio.push({id:asString(cue.id),speechId:speech.id,text:asString(speech.data.text),character:byId.get(asString(speech.data.characterId))?.title??(speech.data.mode==='旁白'?'旁白':'未指定角色'),mediaId:asString(speech.data.mediaId),startMs:start,offsetMs:offset,durationMs:duration||4000});
 }
 return {sequence:structuredClone(sequence),frames,audio,durationMs:cursor,warnings};
}
export const timeLabel=(ms:number)=>`${Math.floor(ms/60000).toString().padStart(2,'0')}:${Math.floor(ms/1000%60).toString().padStart(2,'0')}.${Math.floor(ms%1000/100)}`;
