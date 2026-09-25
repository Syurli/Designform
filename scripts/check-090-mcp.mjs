/** 手动 MCP 协议检查。先在独立虚构项目中心启动本地服务；此脚本不发布问题或采纳内容。 */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import path from 'node:path';
const url=process.env.CEWEN_URL;if(!url)throw new Error('请设置 CEWEN_URL，指向隔离验证服务');
const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('runtime/mcp.js')],env:{...process.env,CEWEN_URL:url},stderr:'pipe'}),client=new Client({name:'Designform-090-protocol-check',version:'1.0.0'},{capabilities:{}});let log='';transport.stderr?.on('data',b=>{log+=b;});
try{await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,32);const names=tools.tools.map(t=>t.name);for(const name of ['cewen_quest_read','cewen_quest_events','cewen_production_preview','cewen_media'])assert(names.includes(name));for(const name of ['cewen_answer','cewen_accept_proposal','cewen_commit','cewen_production_adopt'])assert(!names.includes(name));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(JSON.stringify(r));return r;};
 const caps=JSON.parse((await call('cewen_capabilities')).content[0].text);assert.equal(caps.creativeFormat,2);
 const library=JSON.parse((await call('cewen_projects')).content[0].text),projectId=library.current;
 const list=JSON.parse((await call('cewen_objects',{projectId,limit:100})).content[0].text);console.log('OBJECTS_SHAPE',Object.keys(list));
 for(const [query,kind] of [['image/','image'],['audio/','audio']]){const media=JSON.parse((await call('cewen_objects',{projectId,type:'media',query,limit:1})).content[0].text).objects[0];if(media){const payload=await call('cewen_media',{projectId,mediaId:media.id,includeContent:true});assert(payload.content.some(c=>c.type===kind));console.log('MEDIA_CONTENT',kind);}else console.log('NOT_COVERED media content:',kind);}
 const resources=await client.listResources();assert(resources.resources.some(r=>r.uri==='cewen://schemas/modules'));
 const schema=await client.readResource({uri:'cewen://schemas/modules'});assert(schema.contents.length);
 const prompts=await client.listPrompts();assert(prompts.prompts.some(p=>p.name==='continue-quest'));
 const bad=await client.callTool({name:'cewen_quest_events',arguments:{projectId,questId:list.objects.find(o=>o.type==='quest')?.id??'absent-quest',cursor:'not-a-revision'}});assert(bad.isError);
 console.log('PASS 32 tools; no approval/answer/commit tools; capabilities; media content; resource; prompt; invalid cursor error');
}finally{await client.close();await transport.close();if(log.trim())console.error('Adapter stderr:',log.trim());}
