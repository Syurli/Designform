import {objectContext} from './content.ts';
import {asString,asRows,asData,type CreativeIndex} from './model.ts';
/** 万类交接只传创作意图与稳定身份，二维示意不能伪造实际 3D 摄影机坐标。 */
export function prepareWanleiExchange(index:CreativeIndex,projectId:string,revision:string|null,ids:string[]){
 const objects=objectContext(index,ids,200000);
 return {format:'cewen-wanlei-exchange-1',projectId,sourceRevision:revision,targetIds:ids,objects,
  coordinates:{space:'unspecified',map:'normalized-2d',cameraTransform:null},
  requirements:'接收方自行建立场景、相机与对象映射。返回原 projectId/sourceRevision/objectId/sourceHash；图片或片段仍先回导为候选，不覆盖源文档。'};
}
/** 返回清单先预检；不执行外部脚本，不把外部场景引用直接变成正式内容。 */
export function validateWanleiReturn(index:CreativeIndex,projectId:string,value:unknown){
 const raw=asData(value);if(raw.format!=='cewen-wanlei-result-1'||raw.projectId!==projectId)throw new Error('万类返回包的格式或项目身份不匹配');
 if(!Array.isArray(raw.mappings)||raw.mappings.length>500)throw new Error('映射清单无效或超过 500 项');
 const seen=new Set<string>();const mappings=asRows(raw.mappings).map(row=>{const id=asString(row.objectId),externalId=asString(row.externalId),sourceHash=asString(row.sourceHash);if(!id||!externalId||externalId.length>240||seen.has(id))throw new Error('对象身份或外部映射无效 / 重复');seen.add(id);const object=index.objects.find(o=>o.object.id===id);return {objectId:id,externalId,sourceHash,state:!object?'missing':object.hash===sourceHash?'matched':'stale'};});
 if(mappings.length!==raw.mappings.length)throw new Error('映射列表包含无效行，未忽略错误内容');
 return {projectId,sourceRevision:asString(raw.sourceRevision),mappings,applied:false,instructions:'仅完成预检。三维坐标、资产和相机仍需实际万类接口实现及用户确认。'};
}
