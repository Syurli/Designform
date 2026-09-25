/** 教程定义与进度不引用 DOM、Driver.js 或具体引擎。 */
export type TutorialTarget = string;
export type TutorialStep = {
  id: string; target?: TutorialTarget; title: string; description: string;
  chapter?: string; side?: 'top'|'right'|'bottom'|'left'; align?: 'start'|'center'|'end';
  waitFor?: TutorialTarget; optional?: boolean;
  before?: (signal: AbortSignal) => void | Promise<void>;
  /** true 表示实际完成；文字返回阻止前进并说明需要的操作。 */
  check?: (signal:AbortSignal)=>boolean|string|Promise<boolean|string>;
};
export type TutorialDefinition = {id:string;version:number;title:string;steps:TutorialStep[];practice?:boolean};
export type TutorialStatus = 'running'|'paused'|'completed'|'skipped'|'partial';
export type TutorialProgress = {version:number;status:TutorialStatus;step:number;stepId?:string;completed:string[];skipped:string[];updatedAt:string};
export interface TutorialStore {read():Record<string,TutorialProgress>;write(value:Record<string,TutorialProgress>):void}
export interface TutorialControls {next():void;previous():void;skipStep():void;skipAll():void;pause():void;fastForward():void}
export type TutorialFrame = {definition:TutorialDefinition;step:TutorialStep;index:number;controls:TutorialControls;signal:AbortSignal};
export interface TutorialAdapter {
  canHandle(target?: string):boolean;
  show(frame:TutorialFrame):Promise<void>;
  clear():void;
  feedback?(message:string):void;
}
