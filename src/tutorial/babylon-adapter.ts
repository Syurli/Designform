import type {TutorialAdapter,TutorialFrame} from './types';
/** 真正实现通用展示契约，但引擎高亮由使用方提供，不内置三维导演台。 */
export type BabylonTutorialHooks={highlightMesh(id:string,signal:AbortSignal):Promise<void>|void;clearMeshHighlight():void;waitForEvent?(event:string,signal:AbortSignal):Promise<void>;showInstructions(frame:TutorialFrame):Promise<void>|void;clearInstructions():void};
export class BabylonTutorialAdapter implements TutorialAdapter {
 constructor(private hooks:BabylonTutorialHooks){}
 canHandle(target?:string){return !!target&&(target.startsWith('mesh:')||target.startsWith('event:'));}
 async show(frame:TutorialFrame){this.clear();const target=frame.step.target!;await this.hooks.showInstructions(frame);if(frame.signal.aborted)return;if(target.startsWith('mesh:'))await this.hooks.highlightMesh(target.slice(5),frame.signal);else {if(!this.hooks.waitForEvent)throw new Error('宿主未提供游戏事件等待器');await this.hooks.waitForEvent(target.slice(6),frame.signal);if(!frame.signal.aborted)frame.controls.next();}}
 clear(){this.hooks.clearMeshHighlight();this.hooks.clearInstructions();}
}
