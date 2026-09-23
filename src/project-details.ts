import type { ProjectSnapshot, FileChange, ProjectInfo } from '../shared/model';
import { setMetadata, setTitle } from '../shared/editing';
import { commitProject, projectAssetUrl } from './project-client';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** 项目身份用于目录与设置预览，图片只通过受保护的附件地址访问。 */
export function projectIdentity(snapshot: ProjectSnapshot) {
  const icon = snapshot.project.icon;
  return icon?.kind === 'image' ? `<img src="${escape(projectAssetUrl(snapshot,icon.value))}" alt="项目图标"/>` : escape(icon?.value || snapshot.project.name.slice(0,1) || '策');
}

/** 当前项目设置与项目库分开；一次保存同时提交身份与可选图标附件。 */
export function openProjectDetails(snapshot: ProjectSnapshot, onChange: (snapshot: ProjectSnapshot) => void) {
  const dialog = document.createElement('dialog');dialog.className='identity-dialog';
  let icon: ProjectInfo['icon'] = snapshot.project.icon ?? {kind:'text',value:snapshot.project.name.slice(0,1)};
  let asset: FileChange | undefined, previewUrl: string | undefined;
  dialog.innerHTML=`<form><header><div><small>项目设置</small><h2>给设计一个身份</h2></div><button type="button" data-close aria-label="关闭项目设置">×</button></header><div class="identity-intro"><span class="identity-mark">${projectIdentity(snapshot)}</span><div><label>文字或符号<input name="symbol" maxlength="8" value="${escape(icon.kind==='image'?'':icon.value)}" placeholder="例如：巫、✦"/></label><label class="identity-upload">上传图标<input type="file" accept="image/png,image/jpeg,image/webp" hidden/></label></div></div><label>项目名称<input name="name" required maxlength="100" value="${escape(snapshot.project.name)}"/></label><label>简介<input name="description" maxlength="240" value="${escape(snapshot.project.description)}" placeholder="用一句话说明当前设计方向"/></label><label>项目备注<textarea name="notes" rows="5" maxlength="6000" placeholder="供自己与协作者阅读的背景、约定或提醒">${escape(snapshot.project.notes??'')}</textarea></label><p class="identity-location">${escape(snapshot.project.path)}</p><p class="identity-feedback" role="status"></p><footer><button type="button" data-close>取消</button><button class="primary-button" type="submit" ${snapshot.historical?'disabled':''}>保存项目设置</button></footer></form>`;
  const close=()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);dialog.remove();};
  dialog.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',close));dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const feedback=dialog.querySelector<HTMLElement>('.identity-feedback')!;
  dialog.querySelector<HTMLInputElement>('[name=symbol]')!.addEventListener('input',event=>{const value=(event.target as HTMLInputElement).value;icon={kind:'text',value:value||snapshot.project.name.slice(0,1)};asset=undefined;dialog.querySelector('.identity-mark')!.textContent=icon.value;});
  dialog.querySelector<HTMLInputElement>('[type=file]')!.addEventListener('change',async event=>{
    const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
    if(file.size>2*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){feedback.textContent='请选择 2 MB 以内的 PNG、JPEG 或 WebP 图片。';return;}
    const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
    const path=`docs/assets/project-icon-${crypto.randomUUID()}.${file.type==='image/jpeg'?'jpg':file.type.split('/')[1]}`;
    asset={path,baseHash:null,text:data.slice(data.indexOf(',')+1),encoding:'base64'};icon={kind:'image',value:path};
    if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);const image=document.createElement('img');image.src=previewUrl;image.alt='项目图标预览';dialog.querySelector('.identity-mark')!.replaceChildren(image);feedback.textContent='图标将在保存设置时一并写入项目。';
  });
  dialog.querySelector('form')!.addEventListener('submit',async event=>{
    event.preventDefault();const button=dialog.querySelector<HTMLButtonElement>('[type=submit]')!;if(button.disabled)return;button.disabled=true;
    try { const form=new FormData(dialog.querySelector('form')!);const name=String(form.get('name')).trim();if(!name)throw new Error('请填写项目名称。');
      if(!snapshot.projectEntry)throw new Error('项目入口尚未载入，请刷新项目后重试。');
      const text=setTitle(setMetadata(snapshot.projectEntry.text,{name,description:String(form.get('description')).trim(),notes:String(form.get('notes')).trim(),icon}),name);
      const next=await commitProject({projectId:snapshot.project.id,requestId:crypto.randomUUID(),baseRevision:snapshot.revision,actor:'user',reason:'更新项目身份与备注',changes:[{path:'PROJECT.md',baseHash:snapshot.projectEntry.hash,text},...(asset?[asset]:[])]});onChange(next);close();
    }catch(error){feedback.textContent=error instanceof Error?error.message:'设置未能保存，请重试。';button.disabled=false;}
  });
  document.body.append(dialog);dialog.showModal();
}
