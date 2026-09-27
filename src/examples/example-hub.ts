import type { ProjectSnapshot } from '../../shared/model';
import { appForm } from '../app-dialog';

/** 所有旧教程入口也进入同一个内存示例工作台，不再创建练习目录或专用预览页。 */
export function openExampleHub(options:{onCreated:(snapshot:ProjectSnapshot)=>void;practice?:boolean}) {
  void appForm('示例与新手教程','<p>选择后进入正常文档工作台。可编辑、可播放，关闭后恢复原始示例；保存时另存为新项目。</p><label>学习内容<select name="example"><option value="documents">入门：文档、分类与引用</option><option value="cards">角色与道具文档预设</option><option value="maps">共享地图与局部覆盖层</option><option value="game">游戏：雾港来信</option><option value="narrative">世界观：雾港来信</option><option value="screenplay">剧本：雨夜候车室</option><option value="film">短片：最后一盏灯</option><option value="mixed">进阶：综合虚构工程</option></select></label>','打开示例',async data=>(await import('../../browser/learning-examples')).createLearningExample(String(data.get('example')))).then(snapshot=>{if(snapshot){options.onCreated(snapshot);window.dispatchEvent(new CustomEvent('cewen:open-project',{detail:snapshot}));}});
}
