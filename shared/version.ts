/** 应用版本单一来源；项目格式和协议号独立管理。 */
import metadata from '../package.json';
// 四段修订号用于界面和发布，npm 的标准三段版本另保留合法构建编号。
export const APP_VERSION = metadata.releaseVersion ?? metadata.version;
