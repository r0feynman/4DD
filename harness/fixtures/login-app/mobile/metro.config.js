// Metro 설정 (조각 3). 앱 테마(theme.ts)가 저장소 위의 design/tokens.json을 그대로 가져다 쓰므로,
// 번들러가 mobile/ 밖의 design/ 폴더도 보게 한다. 이것이 없으면 Android·웹 빌드가 「Unable to resolve ../design/tokens.json」으로 깨진다.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../design")];

module.exports = config;
