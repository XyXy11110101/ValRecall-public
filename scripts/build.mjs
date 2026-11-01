import { buildExtension } from './build-extension.mjs';
import { extensionOutputDirectory } from './extension-output.mjs';
import { assertPublicBuildHasNoPrivateCompanionAssets } from './companion-build-scan.mjs';

await buildExtension();
await assertPublicBuildHasNoPrivateCompanionAssets({ distDirectory: extensionOutputDirectory() });
