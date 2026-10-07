import { build, Platform, Arch } from 'electron-builder';
import { releaseVersion } from './release-version.mjs';

/** 正式四段发布号用于 ZIP 文件名及 Windows 资源版本，构建仍使用标准 npm 元数据。 */
const revision = /^\d+\.\d+\.\d+\.(\d+)$/.exec(releaseVersion);
await build({
  targets: Platform.WINDOWS.createTarget('zip', Arch.x64),
  config: {
    extends: './electron-builder.yml',
    artifactName: `Designform-${releaseVersion}-Windows-x64.\${ext}`,
    buildVersion: releaseVersion,
    ...(revision ? { buildNumber: revision[1] } : {}),
  },
});
