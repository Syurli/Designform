import { emptyIdea, type GameIdea } from './prompts.ts';
import { projectAssemblies } from './project-assembly';

/** 不同创作预设只提供讨论词条，不配置固定空文档或限制模块。 */
export const briefOptions: Record<string, { label:string; genres:string[]; gameplay:string[]; platforms:string[] }> = {
  // 保留 7cfd841 旧游戏拼装器的射击与策略战术词条，新增策略词条仍可独立组合。
  game:{label:'游戏',genres:['动作','角色扮演','射击','策略','策略战术','模拟经营','解谜探索','卡牌构筑','叙事'],gameplay:['探索','战斗','构筑','解谜','经营','建造','叙事选择'],platforms:['PC','移动端','主机','浏览器']},
  narrative:{label:'叙事与世界观',genres:['奇幻','科幻','现实','悬疑','历史'],gameplay:['世界设定','人物关系','地点','事件','分支'],platforms:['游戏','小说','互动叙事','跨媒体']},
  screenplay:{label:'剧本',genres:['剧情','喜剧','悬疑','科幻','爱情'],gameplay:['人物弧光','场次','对白','冲突','结构'],platforms:['电影','剧集','舞台','广播剧']},
  film:{label:'微电影',genres:['剧情','纪实','实验','动画'],gameplay:['镜头','表演','声音','节奏','场次'],platforms:['横屏','竖屏','网络','展映']},
  mixed:{label:'综合创作',genres:['游戏','叙事','剧本','影像'],gameplay:['共享世界','角色','互动','音画','跨媒体'],platforms:['PC','移动端','网络','展映']},
};

/** 旧拼装器 7cfd841 的目标逐字保留，与当前目标合并去重，仍可自定义或跳过。 */
export const projectGoalOptions=[...new Set(['初稿与关键问题','比较创作方向','验证核心体验','整理已有材料','验证核心玩法','可玩演示','规划完整作品','寻找独特体验','梳理设计框架'])];
/** 单值字段复用输入框的建议列表；建议不限制用户自由填写。 */
export const projectSingleSuggestions:Partial<Record<keyof GameIdea,string[]>>={
  team:['个人创作','2～5 人小团队','6～15 人团队','更大规模团队'],
  session:['5～15 分钟','15～30 分钟','30～60 分钟','1 小时以上'],
  approach:['先出初稿与关键问题','先问我关键问题','给几种方向比较','基于已知约束起草候选初稿','只整理已有想法'],
};
/** 捷径仅追加领域词条，未想清楚不清空设想、选择或手改文本。 */
export const projectShortcuts:Record<string,{genre:string;play:string}>={
  '探索原型':{genre:'解谜探索',play:'探索'},'卡牌构筑':{genre:'卡牌构筑',play:'构筑'},
  '模拟经营':{genre:'模拟经营',play:'经营'},'叙事冒险':{genre:'叙事',play:'叙事选择'},
  '还没想清楚':{genre:'',play:''},'角色与关系':{genre:'人物关系',play:'人物弧光'},'短片起稿':{genre:'剧情',play:'镜头'},
};

/** 简介仅保存用户设想；协作方式、接入配置与完整开场白不进入项目正文。 */
export function projectIdeaBrief(preset:string, idea:GameIdea) {
  const options=briefOptions[preset];
  // 简介沿用当前方向的字段名，剧本与影像不统一称为游戏玩法。
  const labels=projectAssemblies[preset]?.labels;
  const words=(values:string[],custom:string)=>[...new Set([...values,custom.trim()].filter(Boolean))].join('、');
  return [options?`创作方向：${options.label}`:'',idea.idea.trim(),
    [labels?.genre??'想尝试的类型',words(idea.genres,idea.customGenre)],['本轮目标',words(idea.goals,idea.customGoal)],
    [labels?.play??'主要内容',words(idea.gameplay,idea.customPlay)],[labels?.platform??'目标载体',words(idea.platforms,idea.customPlatform)],
    ['制作资源',idea.team??''],[labels?.session??'体验或作品时长',idea.session??''],['补充条件',idea.constraints.trim()]
  ].map(item=>Array.isArray(item)?item[1]?`${item[0]}：${item[1]}`:'':item).filter(Boolean).join('\n\n');
}

/** 私人草稿按字段校验，损坏字段不会丢掉其余有效设想。 */
export function restoreProjectIdea(value:unknown):GameIdea {
  const idea=emptyIdea();if(!value||typeof value!=='object'||Array.isArray(value))return idea;
  const data=value as Record<string,unknown>;
  for(const key of Object.keys(idea) as (keyof GameIdea)[]){const item=data[key];if(Array.isArray(idea[key])){if(Array.isArray(item))(idea as unknown as Record<string,unknown>)[key]=item.filter(word=>typeof word==='string');}else if(typeof item==='string')(idea as unknown as Record<string,unknown>)[key]=item;}
  // 旧拼装器的单选目标与平台保留为多选，不将待讨论占位符当成真实选择。
  if(!idea.goals.length&&typeof data.scope==='string'&&data.scope!=='尚未确定')idea.goals=[data.scope];
  if(!idea.platforms.length&&typeof data.platform==='string'&&data.platform!=='待讨论')idea.platforms=[data.platform];
  for(const key of ['team','session'] as const)if(typeof data[key]==='string')idea[key]=data[key];
  return idea;
}
