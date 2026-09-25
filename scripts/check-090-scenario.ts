import { ProjectService } from '../server/projects.ts';
import { CreativeService } from '../server/creative/service.ts';
import { PresetService } from '../server/creative/preset-service.ts';
import { ProductionService } from '../server/creative/production-service.ts';
import { buildCreativeIndex } from '../shared/creative/content.ts';
import { compileSequence } from '../shared/creative/sequence.ts';
import { mkdir,rm,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const home=process.env.CEWEN_CHECK_HOME??path.join(tmpdir(),'cewen-090-check-'+Date.now());
await mkdir(home,{recursive:true});const service=new ProjectService(home,path.resolve('templates/example')),creative=new CreativeService(service);
let snapshot=await service.create('0.9 专项验收副本','blank');const id=snapshot.project.id;
console.log('PROJECT',id,snapshot.project.path);
try {
 snapshot=await new PresetService(service,creative).apply(id,{requestId:'check-mixed-preset',instanceId:'check',preset:'mixed',sample:true});
 const index=buildCreativeIndex(snapshot);console.log('COUNTS',JSON.stringify({documents:snapshot.documents.length,objects:index.objects.length,media:Object.keys(snapshot.media??{}).length,errors:snapshot.diagnostics.filter(d=>d.severity==='error')}));
 assert.equal(snapshot.project.format,2);assert.equal(index.diagnostics.filter(x=>x.severity==='error').length,0);assert(index.references.filter(r=>r.targetId==='check-map-station').length>=3);
 const plan=compileSequence(index,'check-sequence');assert.equal(plan.frames.length,18);assert.equal(plan.durationMs,78000);console.log('PLAYBACK',plan.frames.length,plan.audio.length,plan.durationMs);
 for(let i=0;i<4;i++){const q=await creative.questRead(id,`check-quest${i}`);console.log('QUEST',i,q.questions.length,q.answerState,q.implementationState,q.proposals.map(p=>p.state));}
 const object=await creative.readObject(id,'check-use-combat');const beforeMap=index.objects.find(o=>o.object.id==='check-map-station')!.hash;
 object.object.data.purpose='只修改战斗覆盖层';snapshot=await creative.saveObject(id,{requestId:'check-overlay',documentId:object.documentId,baseHash:object.documentHash,object:object.object});assert.equal(buildCreativeIndex(snapshot).objects.find(o=>o.object.id==='check-map-station')!.hash,beforeMap);
 const retry=await creative.saveObject(id,{requestId:'check-overlay',documentId:object.documentId,baseHash:object.documentHash,object:object.object});assert.equal(retry.revision,snapshot.revision);
 await assert.rejects(()=>creative.saveObject(id,{requestId:'check-stale',documentId:object.documentId,baseHash:object.documentHash,object:object.object}));
 const production=new ProductionService(service);const batch=await production.read(id,'check-production');assert.equal(batch.jobs.length,3);const image=buildCreativeIndex(snapshot).objects.find(o=>o.object.type==='media'&&o.object.data.mime==='image/png')!;
 snapshot=await production.recordResult(id,{requestId:'check-result',batchId:'check-production',jobId:batch.jobs[0].id,candidateId:'check-candidate',mediaId:image.object.id});
 const target=buildCreativeIndex(snapshot).objects.find(o=>o.object.id===batch.jobs[0].targetId)!;snapshot=await production.adopt(id,{requestId:'check-adopt',batchId:'check-production',jobId:batch.jobs[0].id,candidateId:'check-candidate',baseHash:target.hash});
 const adopted=await production.read(id,'check-production');assert.equal(adopted.jobs[0].state,'adopted');assert(!adopted.jobs[1].stale,'Adoption must not invalidate sibling job');
 const versions=await service.versions(id);assert(versions.every(v=>v.valid));const revision=await service.revision(id,versions[1].manifest.id);assert(revision.historical);
 const mediaPath=Object.keys(snapshot.media!)[0],file=await service.asset(id,mediaPath);assert.equal(createHash('sha256').update(file).digest('hex'),snapshot.media![mediaPath]);
 const exportParent=path.join(home,'exports');await mkdir(exportParent,{recursive:true});const pack=await service.exportProject(id,exportParent,'full',false);const packageData=JSON.parse(await readFile(path.join(pack.directory,'PACKAGE.json'),'utf8'));assert(Object.keys(packageData.files).some(p=>p.startsWith('assets/objects/')));
 console.log('PASS overlay-isolation, conflict, retry, candidate/adoption, history, media hash, full export',snapshot.revision);
 console.log('RESULT',JSON.stringify({id,path:snapshot.project.path,revision:snapshot.revision,versions:versions.length}));
}finally{service.close();}
