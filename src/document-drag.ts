/** 目录拖出的稳定身份；标题与路径只用于外部拖放，站内插入重新核对项目快照。 */
export const DOCUMENT_DRAG_TYPE='application/x-cewen-document';
export interface DocumentDrag {projectId:string;documentId:string;path:string;title:string;anchor?:string}
export function readDocumentDrag(transfer:DataTransfer|null):DocumentDrag|undefined{
  const text=transfer?.getData(DOCUMENT_DRAG_TYPE);if(!text||text.length>16000)return;
  try{const item=JSON.parse(text);if(!item||typeof item.projectId!=='string'||typeof item.documentId!=='string'||typeof item.path!=='string'||typeof item.title!=='string'||(item.anchor!==undefined&&typeof item.anchor!=='string'))return;return item;}catch{return;}
}
