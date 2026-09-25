/** 定向协议验收：只创建独立虚构目录，不读取真实用户项目。手动执行，不挂默认 CI。 */
import {ProjectService} from '../server/projects.ts';
import {CreativeService} from '../server/creative/service.ts';
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setMetadata} from '../shared/editing.ts';
const home=process.env.CEWEN_MIGRATION_HOME??path.join(tmpdir(),'cewen-migrate-'+Date.now());await mkdir(home,{recursive:true});const source=path.join(home,'original-format-1');await cp(path.resolve('templates/example'),source,{recursive:true});
let entry=await readFile(path.join(source,'PROJECT.md'),'utf8');entry=setMetadata(entry,{id:'migration-example',format:1,minimumAppVersion:'0.7.1'});await writeFile(path.join(source,'PROJECT.md'),entry);
const p=new ProjectService(path.join(home,'registry'),path.resolve('templates/example'));try{await p.open(source);let s=await p.read('migration-example');assert.equal(s.project.format,1);const old=await p.versions(s.project.id);assert(old.length&&old.every(e=>e.valid));
 const oldManifest=await readFile(path.join(source,'versions',old[0].manifest.label,'manifest.json'));const parent=path.join(home,'upgraded');await mkdir(parent);
 const next=await p.upgradeCopy(s.project.id,parent);assert.equal(next.project.format,2);assert.equal(await readFile(path.join(source,'PROJECT.md'),'utf8'),entry);assert.deepEqual(await readFile(path.join(next.project.path,'versions',old[0].manifest.label,'manifest.json')),oldManifest);assert.deepEqual(await readFile(path.join(source,'versions',old[0].manifest.label,'manifest.json')),oldManifest);
 const historical=await p.revision(next.project.id,old[0].manifest.id);assert.equal(historical.project.format,1);assert(historical.historical);
 const c=new CreativeService(p);s=await c.createObjectDocument(next.project.id,{requestId:'migration-create-map',documentId:'doc-map-after',objectId:'map-after',type:'map',title:'升级后的地图'});assert.equal(s.project.format,2);assert((await p.versions(s.project.id)).every(v=>v.valid));
 console.log('PASS original unchanged; old history byte-preserved; historical format1 read; new format2 object commit',next.project.path);
}finally{p.close();}
