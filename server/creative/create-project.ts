import type { ProjectService } from '../projects.ts';
import { CreativeService } from './service.ts';
import { PresetService } from './preset-service.ts';
import { presets } from '../../shared/creative/presets.ts';
import { asString } from '../../shared/creative/model.ts';
import { runtimeKind } from '../platform.ts';
import { ProjectError } from '../files.ts';
export async function createPresetProject(projects:ProjectService,input:Record<string,unknown>){
 const name=asString(input.name).trim(),directory=asString(input.directory),preset=asString(input.preset),demo=input.demo===true,requestId=asString(input.requestId);
 if(!name||name.length>100||!presets.some(p=>p.id===preset)||!/^[A-Za-z0-9_-]{1,60}$/.test(requestId))throw new ProjectError('INVALID_PROJECT_SETUP','项目名称、预设或请求身份无效');
 if(runtimeKind==='web'&&!demo&&!directory.startsWith('/folders/'))throw new ProjectError('FOLDER_REQUIRED','正式项目必须选择本机目录；未静默回退浏览器存储');
 const library=await projects.list(),parent=demo?library.defaultDirectory:directory;if(!parent)throw new ProjectError('FOLDER_REQUIRED','请选择保存位置');
 const project=await projects.create(name,'blank',parent,{brief:`${demo?'【虚构练习副本】\n':''}预设仅提供起步内容，所有模块始终可用。`,creationRequestId:requestId,example:demo});
 return new PresetService(projects,new CreativeService(projects)).apply(project.project.id,{requestId:`${requestId}-preset`,instanceId:`sample-${requestId.slice(0,16)}`,preset,sample:input.sample===true});
}
