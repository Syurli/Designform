import type { GameIdea } from './prompts';

/** 拼装建议只追加明确显示的词条，不替用户补写故事、规模或制作承诺。 */
export type AssemblyKey='genres'|'goals'|'gameplay'|'platforms';
export interface AssemblySuggestion { title:string; detail:string; values:Partial<Record<AssemblyKey,string[]>> }
export interface ProjectAssembly {
  labels:{genre:string;play:string;platform:string;session:string};
  hint:string;placeholder:string;goals:string[];sessions:string[];suggestions:AssemblySuggestion[];
}

/** 保留原有创作方向，为每种方向提供自身的组合、目标和制作条件语言。 */
export const projectAssemblies:Record<string,ProjectAssembly>={
  game:{labels:{genre:'类型与风格',play:'核心活动',platform:'游玩平台',session:'单次体验时长'},hint:'先说明玩家做什么，再选择要验证的体验。',placeholder:'例如：玩家在封锁区中观察局势，自行选择路线完成委托。',goals:['初稿与关键问题','验证核心体验','验证核心玩法','可玩演示','比较创作方向','规划完整作品'],sessions:['5～15 分钟','15～30 分钟','30～60 分钟','1 小时以上'],suggestions:[
    {title:'探索原型',detail:'解谜探索 · 探索、解谜',values:{genres:['解谜探索'],gameplay:['探索','解谜']}},
    {title:'卡牌构筑',detail:'卡牌构筑 · 构筑、战斗',values:{genres:['卡牌构筑'],gameplay:['构筑','战斗']}},
    {title:'模拟经营',detail:'模拟经营 · 经营、建造',values:{genres:['模拟经营'],gameplay:['经营','建造']}},
    {title:'叙事冒险',detail:'叙事 · 探索、叙事选择',values:{genres:['叙事'],gameplay:['探索','叙事选择']}},
  ]},
  narrative:{labels:{genre:'题材与基调',play:'世界与故事要素',platform:'叙事载体',session:'篇幅或阅读时长'},hint:'从一个世界规则、人物关系或事件出发，确定本轮需要展开什么。',placeholder:'例如：一座只能通过书信交流的城市，两位角色试图确认彼此的身份。',goals:['初稿与关键问题','梳理世界规则','展开人物关系','整理事件与分支','比较创作方向','整理已有材料'],sessions:['短篇','章节故事','长篇世界观','10～30 分钟阅读'],suggestions:[
    {title:'世界起点',detail:'世界设定 · 地点',values:{gameplay:['世界设定','地点']}},
    {title:'角色与关系',detail:'人物关系 · 事件',values:{gameplay:['人物关系','事件']}},
    {title:'事件与分支',detail:'事件 · 分支',values:{gameplay:['事件','分支']}},
    {title:'互动叙事',detail:'人物关系、分支 · 互动叙事载体',values:{gameplay:['人物关系','分支'],platforms:['互动叙事']}},
  ]},
  screenplay:{labels:{genre:'题材与基调',play:'剧本要素',platform:'演出载体',session:'剧本篇幅或演出时长'},hint:'从人物想要什么、遇到什么阻力开始，再组织场次和对白。',placeholder:'例如：两人在末班车离开前，围绕一件无法归还的物品发生冲突。',goals:['初稿与关键问题','明确人物与冲突','梳理场次结构','起草对白','比较创作方向','整理已有材料'],sessions:['单场戏','短片剧本','长片剧本','剧集单集'],suggestions:[
    {title:'人物与冲突',detail:'人物弧光 · 冲突',values:{gameplay:['人物弧光','冲突']}},
    {title:'场次骨架',detail:'场次 · 结构',values:{gameplay:['场次','结构']}},
    {title:'对白起稿',detail:'对白 · 冲突',values:{gameplay:['对白','冲突']}},
    {title:'短片剧本',detail:'场次、结构 · 电影载体',values:{gameplay:['场次','结构'],platforms:['电影']}},
  ]},
  film:{labels:{genre:'影像形式',play:'表达与拍摄要素',platform:'画幅与发布场景',session:'成片时长'},hint:'先说希望观众看到和感受到什么，再补充镜头、声音及拍摄资源。',placeholder:'例如：用一个场景和两位演员，拍出等待一封回信的短片。',goals:['初稿与关键问题','梳理分镜','设计音画表达','验证拍摄可行性','比较创作方向','整理已有材料'],sessions:['1～3 分钟','3～5 分钟','5～10 分钟','10～20 分钟'],suggestions:[
    {title:'剧情短片',detail:'剧情 · 场次、表演',values:{genres:['剧情'],gameplay:['场次','表演']}},
    {title:'分镜起稿',detail:'镜头 · 节奏',values:{gameplay:['镜头','节奏']}},
    {title:'声音叙事',detail:'声音 · 镜头',values:{gameplay:['声音','镜头']}},
    {title:'纪实观察',detail:'纪实 · 镜头、声音',values:{genres:['纪实'],gameplay:['镜头','声音']}},
  ]},
  mixed:{labels:{genre:'参与的创作领域',play:'共享内容与关联方式',platform:'交付载体',session:'各载体的规模或时长'},hint:'先确定哪些内容需要共享，再组合各载体的表达。',placeholder:'例如：同一组人物与地点，分别用于游戏章节和短片，保持事件依据一致。',goals:['初稿与关键问题','梳理共享内容','明确跨媒体关联','验证核心体验','规划完整作品','整理已有材料'],sessions:['单个场景或章节','小型跨媒体样片','分阶段交付','各载体分别确定'],suggestions:[
    {title:'游戏与叙事',detail:'游戏、叙事 · 共享世界、角色、互动',values:{genres:['游戏','叙事'],gameplay:['共享世界','角色','互动']}},
    {title:'剧本与影像',detail:'剧本、影像 · 角色、音画',values:{genres:['剧本','影像'],gameplay:['角色','音画']}},
    {title:'共享世界',detail:'共享世界 · 角色、跨媒体',values:{gameplay:['共享世界','角色','跨媒体']}},
    {title:'互动与影像',detail:'游戏、影像 · 互动、音画',values:{genres:['游戏','影像'],gameplay:['互动','音画']}},
  ]},
};

/** 组合完整包含时显示选中；部分已选的组合会补齐，其余用户选项保留。 */
export function assemblySelected(idea:GameIdea,suggestion:AssemblySuggestion):boolean {
  return Object.entries(suggestion.values).every(([key,values])=>values.every(value=>idea[key as AssemblyKey].includes(value)));
}
