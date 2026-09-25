/** 手动协议夹具：本地仿真 ComfyUI，不加载真实模型、不计费、不代表真实产线验收。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectService} from '../server/projects.ts';
import {CreativeService} from '../server/creative/service.ts';
import {ProductionService} from '../server/creative/production-service.ts';
import {ComfyConnector} from '../server/creative/comfy.ts';
import {buildCreativeIndex} from '../shared/creative/content.ts';
import {prepareWanleiExchange,validateWanleiReturn} from '../shared/creative/bridge.ts';
import {readJobReceipt} from '../shared/creative/production.ts';
const home=await mkdtemp(path.join(tmpdir(),'cewen-090-connectors-'));await mkdir(home,{recursive:true});
const service=new ProjectService(home,path.resolve('templates/example')),creative=new CreativeService(service),production=new ProductionService(service),connector=new ComfyConnector(service);
let uploads=0;let submissions=0,completed=false,uncertain=false,interrupted=false;let received:any;const pending:string[]=[];
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YGnZXMAAAAASUVORK5CYII=','base64');
const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const json=(v:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};const u=new URL(req.url!,'http://fixture');
 if(u.pathname==='/system_stats')return json({system:{os:'fixture'}});
 if(u.pathname==='/upload/image'){assert(req.headers['content-type']?.startsWith('multipart/form-data'));assert(data.includes('name="image"'));uploads++;return json({name:'reference.png',subfolder:'cewen',type:'input'});}
 if(u.pathname==='/prompt'){submissions++;received=JSON.parse(data);const id='fixture-'+submissions;pending.push(id);if(uncertain){res.destroy();return;}return json({prompt_id:id,number:submissions});}
 if(u.pathname==='/queue'){if(req.method==='POST'){const deleted=JSON.parse(data).delete;for(const id of deleted){const i=pending.indexOf(id);if(i>=0)pending.splice(i,1);}return json({});}return json({queue_pending:pending.map(id=>[1,id,{},{}]),queue_running:[]});}
 if(u.pathname.startsWith('/history/')){const id=u.pathname.split('/').pop()!;return json(completed?{[id]:{status:{status_str:'success'},outputs:{'9':{images:[{filename:'fixture.png',subfolder:'',type:'output'}]}}}}:{});}
 if(u.pathname==='/view'){res.setHeader('Content-Type','image/png');return res.end(image);}
 if(u.pathname==='/interrupt')interrupted=true;res.statusCode=404;res.end();});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
let projectId='';
try{
 let snapshot=await service.create('连接器协议虚构夹具','blank');projectId=snapshot.project.id;
 const make=(id:string)=>({id,type:'map',schema:1,title:id,status:'draft',data:{description:'二维空间示意',points:[],areas:[]}} as const);
 for(const id of ['map-first','map-cancel','map-uncertain'])snapshot=await creative.createObjectDocument(projectId,{requestId:'create-'+id,documentId:'doc-'+id,objectId:id,type:'map',title:id,data:make(id).data});
 const revision=snapshot.revision;await production.prepare(projectId,{requestId:'batch-create',batchId:'fixture-batch',title:'夹具批次',targetIds:['map-first','map-cancel','map-uncertain'],baseRevision:revision});
 const batch=await production.read(projectId,'fixture-batch');const workflow={'6':{class_type:'CLIPTextEncode',inputs:{text:'旧提示词',clip:['4',1]}}};
 const input=(i:number)=>({operation:'submit',url,batchId:'fixture-batch',jobId:batch.jobs[i].id,workflow,textNode:'6',confirmed:true});
 await assert.rejects(()=>connector.action(projectId,{...input(0),confirmed:false}),e=>(e as any).code==='CONSENT_REQUIRED');
 await assert.rejects(()=>connector.action(projectId,{operation:'check',url:'https://example.com'}),e=>(e as any).code==='CONNECTOR_URL_DENIED');
 assert.equal((await connector.action(projectId,{operation:'check',url}) as any).available,true);
 const [a,b]=await Promise.allSettled([connector.action(projectId,input(0)),connector.action(projectId,input(0))]);assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');assert.equal(submissions,1);assert.equal(received.prompt['6'].inputs.text,batch.jobs[0].prompt);
 const run=(a as PromiseFulfilledResult<any>).value;assert.equal((await connector.action(projectId,{operation:'collect',runId:run.id}) as any).state,'pending');
 completed=true;assert.equal((await connector.action(projectId,{operation:'collect',runId:run.id}) as any).candidates,1);assert.equal((await connector.action(projectId,{operation:'collect',runId:run.id}) as any).duplicate,true);
 const results=await production.read(projectId,'fixture-batch');assert.equal(results.jobs[0].state,'returned');assert.equal(results.jobs[0].adoptedMediaId,undefined);assert.equal(results.jobs[0].candidates.length,1);
 const second=await connector.action(projectId,input(1)) as any;assert.equal((await connector.action(projectId,{operation:'cancel',runId:second.id}) as any).canceled,true);assert.equal(interrupted,false);
 uncertain=true;await assert.rejects(()=>connector.action(projectId,input(2)),e=>(e as any).code==='SUBMISSION_UNCERTAIN');await assert.rejects(()=>connector.action(projectId,input(2)),e=>(e as any).code==='RUN_EXISTS');assert.equal(submissions,3);
 uncertain=false;const imported=await creative.registerMedia(projectId,{requestId:'reference-media',name:'reference.png',permission:'合成夹具'},image);
 snapshot=await creative.createObjectDocument(projectId,{requestId:'create-refchar',documentId:'doc-refchar',objectId:'refchar',type:'character',title:'参考角色',data:{identity:'夹具角色',mediaId:imported.mediaId}});
 snapshot=await creative.createObjectDocument(projectId,{requestId:'create-refscene',documentId:'doc-refscene',objectId:'refscene',type:'scene',title:'参考场次',data:{characterIds:['refchar']}});
 snapshot=await creative.createObjectDocument(projectId,{requestId:'create-refshot',documentId:'doc-refshot',objectId:'refshot',type:'shot',title:'参考镜头',data:{sceneId:'refscene',panels:[{id:'first',caption:'角色站在门边'}]}});
 const preview=await production.preview(projectId,{targetIds:['refshot'],batchId:'refbatch'});const refJob=(preview as any).jobs[0];
 await production.prepare(projectId,{requestId:'prepare-refbatch',targetIds:['refshot'],batchId:'refbatch',title:'参考图验证',baseRevision:snapshot.revision,overrides:{[refJob.id]:{negativePrompt:'无文字'}}});
 const refInput={url,operation:'submit',batchId:'refbatch',jobId:refJob.id,confirmed:true,textNode:'6',workflow:{...workflow,'7':{class_type:'CLIPTextEncode',inputs:{text:''}},'8':{class_type:'LoadImage',inputs:{image:''}}}};
 await assert.rejects(()=>connector.action(projectId,refInput),e=>(e as any).code==='NEGATIVE_MAPPING_REQUIRED');
 await assert.rejects(()=>connector.action(projectId,{...refInput,negativeNode:'7'}),e=>(e as any).code==='REFERENCE_MAPPING_REQUIRED');
 await connector.action(projectId,{...refInput,negativeNode:'7',referenceBindings:[{mediaId:imported.mediaId,nodeId:'8'}]});assert.equal(uploads,1);assert.equal(received.prompt['7'].inputs.text,'无文字');assert.equal(received.prompt['8'].inputs.image,'cewen/reference.png');
 console.log('PASS mocked reference upload, explicit binding, missing-mapping rejection and negative prompt');
 snapshot=await service.read(projectId);const index=buildCreativeIndex(snapshot),exchange=prepareWanleiExchange(index,projectId,snapshot.revision,['map-first']);assert.equal(exchange.coordinates.cameraTransform,null);
 const object=index.objects.find(o=>o.object.id==='map-first')!;const receipt={format:'cewen-wanlei-result-1',projectId,sourceRevision:snapshot.revision,mappings:[{objectId:'map-first',externalId:'external-map',sourceHash:object.hash}]};assert.equal(validateWanleiReturn(index,projectId,receipt).mappings[0].state,'matched');assert.equal(validateWanleiReturn(index,projectId,{...receipt,mappings:[{...receipt.mappings[0],sourceHash:'old'}]}).mappings[0].state,'stale');assert.throws(()=>validateWanleiReturn(index,'another-project',receipt));
 assert.throws(()=>readJobReceipt({format:'cewen-results-1',batchId:'fixture-batch',results:[{jobId:batch.jobs[0].id,candidateId:'outside',filename:'../secret.png'}]}));
 assert.throws(()=>readJobReceipt({format:'cewen-results-1',batchId:'fixture-batch',results:[{jobId:'j',candidateId:'c',filename:'ok.png'},null]}));
 console.log('PASS mocked ComfyUI: consent, URL, concurrent submit, prompt binding, pending, candidate-only import, duplicate collect, safe cancellation, uncertain submission');
 console.log('PASS Wanlei schema-only: exact identity/hash, stale return, wrong project; production receipt rejects traversal');
 console.log('REAL COMFYUI / MODEL EXECUTION / REAL WANLEI: NOT TESTED');
}finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
