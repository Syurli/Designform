import type { ProjectSnapshot } from '../model.ts';
import type { CreativeObject } from './model.ts';
import {asData,asString,asStrings} from './model.ts';
import {contentHash} from './content.ts';
import {section} from '../inquiry.ts';
/** 确认以决定文本及用户原始回答为基准；落实记录追加不使确认失效，改答则失效。 */
export function decisionBasis(object:CreativeObject,snapshot:ProjectSnapshot){
 const questionIds=asString(object.data.questionIds).split(/[,，\s]+/).filter(Boolean),answers:Record<string,string>={};
 for(const id of questionIds){const doc=snapshot.documents.find(d=>d.id===id&&d.type==='question');const original=doc?section(doc.text,'用户原始回答').text:'';if(!original.includes('### 回答 '))throw new Error(`来源问题 ${id} 尚无用户回答`);answers[id]=contentHash(original);}
 return {textHash:contentHash(JSON.stringify({text:asString(object.data.text),rationale:asString(object.data.rationale),targetIds:asStrings(object.data.targetIds),questionIds})),answers};
}
export function decisionState(object:CreativeObject,snapshot:ProjectSnapshot):'suggested'|'confirmed'|'needs-review'{
 const confirmation=asData(object.data.confirmation);if(confirmation.actor!=='user'||!confirmation.requestId)return 'suggested';
 try{return JSON.stringify(confirmation.basis)===JSON.stringify(decisionBasis(object,snapshot))?'confirmed':'needs-review';}catch{return 'needs-review';}
}
