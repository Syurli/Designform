/** 0.9 收尾的定向检查；只操作内存及独立临时虚构项目，不属于默认自动测试套件。 */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import type {ProjectSnapshot,ProjectDocument} from '../shared/model.ts';
import {moduleRegistry} from '../shared/creative/registry.ts';
import {buildCreativeIndex,objectBlock,contentHash} from '../shared/creative/content.ts';
import {anchorFromText,parseAnchor,resolveAnchor} from '../shared/creative/anchors.ts';
import {decisionState,decisionBasis} from '../shared/creative/decisions.ts';
import {changeShotDuration,TapTimingSession} from '../shared/creative/timing.ts';
import {cloneCreativeObject} from '../shared/creative/clone.ts';
import {prepareJobs,jobStale} from '../shared/creative/production.ts';
import {asRows,asString,type CreativeObject} from '../shared/creative/model.ts';
import {queryObjects,creativeStatistics} from '../shared/creative/query.ts';
import {TutorialCore} from '../src/tutorial/core.ts';
import type {TutorialAdapter,TutorialFrame,TutorialStore,TutorialProgress} from '../src/tutorial/types.ts';
import {ProjectService} from '../server/projects.ts';
import {CreativeService} from '../server/creative/service.ts';
import {PresetService} from '../server/creative/preset-service.ts';
const home=path.join(tmpdir(),'cewen-completion-'+Date.now());await mkdir(home,{recursive:true});
const projects=new ProjectService(home,path.resolve('templates/example')),creative=new CreativeService(projects);
try {
 let snap=await projects.create('0.9 收尾验证副本','blank');const id=snap.project.id;
 snap=await new PresetService(projects,creative).apply(id,{requestId:'completion-preset',instanceId:'final',preset:'mixed',sample:true});
 const index=buildCreativeIndex(snap);assert.equal(index.diagnostics.filter(d=>d.severity==='error').length,0);
 const doc=snap.documents.find(d=>d.text.includes('玩家利用仓库'))!,excerpt='玩家利用仓库之间的遮挡穿过站台';
 const anchor=anchorFromText(snap,doc.id,excerpt);assert.equal(resolveAnchor(snap,anchor).state,'matched');
 const changed=(text:string)=>({...snap,documents:snap.documents.map(d=>d.id===doc.id?{...d,text,hash:contentHash(text)}:d)});
 assert.equal(resolveAnchor(changed('新标题\n\n'+doc.text),anchor).state,'relocated');
 assert.equal(resolveAnchor(changed('重复\n'+excerpt+'\n'+excerpt),{documentId:doc.id,excerpt}).state,'ambiguous');
 assert.equal(resolveAnchor(changed(doc.text.replace(excerpt,'删除后的内容')),anchor).state,'missing');
 assert.equal(resolveAnchor(snap,{documentId:doc.id,objectId:'final-map-station',subObjectId:'不是真正的点位ID'}).state,'missing');
 assert.equal(parseAnchor({documentId:doc.id,sequenceId:'final-sequence',itemId:'take-1',panelId:'p',localMs:700,draft:true}).localMs,700);
 const sequence=index.objects.find(x=>x.object.id==='final-sequence')!.object;
 const ripple=changeShotDuration(sequence,'take-0',7500,'ripple');assert.equal(asRows(ripple.sequence.data.items)[0].durationMs,7500);assert.equal(asRows(sequence.data.items)[0].durationMs,6500);
 assert(changeShotDuration(sequence,'take-0',7500,'keep-next').conflicts.length);
 let clock=0;const tap=new TapTimingSession(asRows(sequence.data.items).map(i=>asString(i.id)),()=>clock);tap.start();assert.throws(()=>tap.tap());
 for(const _ of asRows(sequence.data.items)){clock+=5000;tap.tap();}const recorded=tap.preview(sequence);assert(recorded.changes.every(c=>c.afterMs===5000));assert.equal(asRows(recorded.sequence.data.audio)[2].startMs,8250);
 let counter=0;const copied=cloneCreativeObject(index.objects.find(x=>x.object.type==='storyline')!.object,'copy-story',()=>`new-${counter++}`);assert.notEqual(copied.data.start,'beat0');assert(asRows(copied.data.nodes).some(n=>n.id===copied.data.start));assert(asString(asRows(copied.data.nodes)[0].sceneId).startsWith('final-'));
 const jobs=prepareJobs(index,['final-scene0'],'test-batch',snap.revision);assert(jobs.some(j=>j.kind==='voice')&&jobs.some(j=>j.kind==='image'));
 const image=jobs.find(j=>j.kind==='image')!,edited=prepareJobs(index,['final-scene0'],'test-batch',snap.revision,{selectedJobIds:[image.id],overrides:{[image.id]:{prompt:'这是经过审核的自定义镜头提示词',negativePrompt:'不要文字'}}});assert.equal(edited.length,1);assert.equal(edited[0].promptEdited,true);
 const speech=index.objects.find(x=>x.object.type==='speech')!;const changedIndex={...index,objects:index.objects.map(x=>x===speech?{...x,object:{...x.object,data:{...x.object.data,text:asString(x.object.data.text)+'！'}}}:x)};
 assert(!jobStale(changedIndex,image),'台词改写不得使图片任务过期');assert(jobStale(changedIndex,jobs.find(j=>j.targetId===speech.object.id)!));
 assert.equal(prepareJobs(index,['final-shot0'],'missing',snap.revision,{scope:'missing'}).length,0);
 const latest=await creative.readObject(id,'final-speech0');latest.object.data.text=asString(latest.object.data.text)+'（定向验证）';snap=await creative.saveObject(id,{requestId:'change-text',documentId:latest.documentId,baseHash:latest.documentHash,object:latest.object});
 const events=await creative.questEvents(id,{questId:'final-quest0',cursor:jobs[0].sourceRevision});
 assert('changedDocuments' in events);assert(!('questions' in events),'增量不应重新返回整段问答');
 const decision=moduleRegistry.get('decision')!.create('final-decision','确认验证');decision.data.text='保留桥下出口';decision.data.targetIds=['final-map-station'];
 const targetDoc=snap.documents.find(d=>d.id===doc.id)!;snap=await creative.saveObject(id,{requestId:'create-decision',documentId:doc.id,baseHash:targetDoc.hash,object:decision});
 const located=await creative.readObject(id,'final-decision');snap=await creative.confirmDecision(id,{requestId:'confirm-decision',objectId:'final-decision',baseHash:located.hash,confirmed:true});
 const accepted=buildCreativeIndex(snap).objects.find(x=>x.object.id==='final-decision')!;assert.equal(decisionState(accepted.object,snap),'confirmed');
 const mutated=structuredClone(accepted.object);mutated.data.text='更改后的决定';assert.equal(decisionState(mutated,snap),'needs-review');
 console.log('PASS anchors, timing/taps, cloned identities, semantic production, scoped jobs, incremental Quest, decision confirmation');
 // 编排器使用注入式适配器，练习未操作、跳过和暂停恢复具有不同结果。
 let frame:TutorialFrame|undefined,feedback='',ready=false;let progress:Record<string,TutorialProgress>={};
 const adapter:TutorialAdapter={canHandle:()=>true,show:async v=>{frame=v;},clear:()=>{},feedback:m=>{feedback=m;}};
 const store:TutorialStore={read:()=>structuredClone(progress),write:v=>{progress=structuredClone(v);}};
 const core=new TutorialCore([{id:'test',version:1,title:'真实操作验证',steps:[{id:'do',chapter:'a',title:'操作',description:'',check:()=>ready||'尚未完成'},{id:'end',chapter:'b',title:'结束',description:''}]}],[adapter],store);
 await core.start('test');frame!.controls.next();await new Promise(r=>setTimeout(r,0));assert.equal(progress.test.step,0);assert.equal(feedback,'尚未完成');ready=true;frame!.controls.next();await new Promise(r=>setTimeout(r,0));assert.equal(progress.test.stepId,'end');core.pause();assert.equal(progress.test.status,'paused');await core.start('test');assert.equal(frame!.step.id,'end');frame!.controls.skipStep();await new Promise(r=>setTimeout(r,0));assert.equal(progress.test.status,'partial');assert.deepEqual(progress.test.completed,['do']);core.dispose();
 console.log('PASS tutorial event gate, stable step resume, explicit skip vs completion');
 // 大型合成索引只验证解析与查询，不虚称 1 GiB 真媒体 I/O、GPU 或浏览器内存基准。
 const docs:ProjectDocument[]=[];for(let i=0;i<500;i++){const objects:CreativeObject[]=[];for(let j=0;j<10;j++){const o=moduleRegistry.get(j===0?'map':'reference')!.create(`large-${i}-${j}`);if(j)o.data.objectId=`large-${i}-0`;objects.push(o);}const text=objects.map(objectBlock).join('\n\n');docs.push({id:`document-${i}`,path:`docs/dd/${i}.md`,type:'dd',title:`大型文档${i}`,text,hash:contentHash(text),status:'draft',system:''});}
 const fixture={documents:docs},start=performance.now(),large=buildCreativeIndex(fixture),cold=performance.now()-start,warmStart=performance.now();for(let i=0;i<10;i++)assert.equal(buildCreativeIndex(fixture),large);const warm=performance.now()-warmStart;
 assert.equal(creativeStatistics(large).sourceObjects,5000);assert.equal(queryObjects(large,{type:'reference',offset:0,limit:100}).objects.length,100);assert.equal(large.references.length,4500);
 console.log('PERFORMANCE',JSON.stringify({documents:500,objects:5000,references:4500,coldIndexMs:Math.round(cold),tenCachedLookupsMs:Math.round(warm*100)/100,heapUsedMiB:Math.round(process.memoryUsage().heapUsed/1048576)}));
} finally {projects.close();}
