import { optionalBytes, writeBytes, withProjectLock, ProjectError } from './files.ts';
import { type DocumentPreset, validateDocumentPreset } from '../shared/document-presets.ts';

/** 用户预设属于应用个人库；内置预设随发行包提供，永远不在这里覆盖。 */
export async function documentPresets(home: string, input?: { preset?: DocumentPreset; remove?: string }) {
  const read=async()=>{
    const bytes = await optionalBytes(home, 'document-presets.json');
    const presets: DocumentPreset[] = bytes ? JSON.parse(bytes.toString('utf8')) : [];
    if (!Array.isArray(presets)) throw new ProjectError('PRESETS_DAMAGED','个人预设库无法读取，原文件已保留。');
    presets.forEach(validateDocumentPreset);
    return presets;
  };
  // 浏览和试用预设完全只读，尤其不能为临时示例建立个人库锁文件。
  if(!input)return read();
  return withProjectLock(home, async () => {
    const presets=await read();
    if (input.preset) { validateDocumentPreset(input.preset); const at=presets.findIndex(p=>p.id===input.preset!.id); const next={...input.preset,updatedAt:new Date().toISOString()}; if(at<0)presets.push(next);else presets[at]=next; }
    else if (input.remove?.startsWith('user-')) { const at=presets.findIndex(p=>p.id===input.remove);if(at>=0)presets.splice(at,1); }
    else throw new ProjectError('INVALID_PRESET','请选择用户预设。');
    await writeBytes(home,'document-presets.json',JSON.stringify(presets,null,2));
    return presets;
  });
}
