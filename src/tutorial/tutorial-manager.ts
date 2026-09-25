import {TutorialCore} from './core';
import {DriverTutorialAdapter,WebTutorialStore} from './driver-adapter';
import type {TutorialDefinition} from './types';
export type {TutorialStep,TutorialDefinition,TutorialTarget} from './types';
/** 兼容旧调用点的 Web 装配器；可复用核心在 core.ts，不引用 Driver 或 localStorage。 */
export class TutorialManager extends TutorialCore {
 constructor(definitions:TutorialDefinition[],announce?:(message:string)=>void){super(definitions,[new DriverTutorialAdapter()],new WebTutorialStore(),announce);}
}
