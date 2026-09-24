import type { TutorialDefinition } from './tutorial-manager';

/**
 * 面向未来 Babylon.js 项目的教程适配契约。
 * Definition/Progress 可跨项目复用；DOM 用 Driver.js，3D Mesh/游戏事件由宿主实现。
 */
export type TutorialAdapterContext = {
  definition: TutorialDefinition;
  step: number;
};
export interface TutorialAdapter {
  canHandle(target: string): boolean;
  show(target: string, context: TutorialAdapterContext): Promise<void>;
  clear(): void;
}
export type BabylonTutorialHooks = {
  highlightMesh(id: string): Promise<void> | void;
  clearMeshHighlight(): void;
  waitForEvent?(event: string): Promise<void>;
};
export class BabylonTutorialAdapter implements TutorialAdapter {
  constructor(private hooks: BabylonTutorialHooks) {}
  canHandle(target: string) { return target.startsWith('mesh:') || target.startsWith('event:'); }
  async show(target: string) {
    if (target.startsWith('mesh:')) await this.hooks.highlightMesh(target.slice(5));
    else if (target.startsWith('event:') && this.hooks.waitForEvent) await this.hooks.waitForEvent(target.slice(6));
  }
  clear() { this.hooks.clearMeshHighlight(); }
}
