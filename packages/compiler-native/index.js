// Auto-generated napi-rs loader
// This file tries to load the platform-specific native addon.

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const { platform, arch } = process;

let nativeBinding = null;
let loadError = null;

// Try loading the native addon for the current platform
const triples = {
  'darwin-arm64': 'compiler-native.darwin-arm64.node',
  'darwin-x64': 'compiler-native.darwin-x64.node',
  'linux-x64-gnu': 'compiler-native.linux-x64-gnu.node',
  'linux-x64-musl': 'compiler-native.linux-x64-musl.node',
  'linux-arm64-gnu': 'compiler-native.linux-arm64-gnu.node',
  'linux-arm64-musl': 'compiler-native.linux-arm64-musl.node',
  'win32-x64-msvc': 'compiler-native.win32-x64-msvc.node',
};

const platformKey = `${platform}-${arch}`;
// Try GNU first on Linux, then musl
const candidates = platform === 'linux'
  ? [`${platformKey}-gnu`, `${platformKey}-musl`]
  : [platformKey];

for (const key of candidates) {
  const file = triples[key];
  if (!file) continue;

  const localPath = join(__dirname, file);
  if (existsSync(localPath)) {
    try {
      nativeBinding = require(localPath);
      break;
    } catch (e) {
      loadError = e;
    }
  }

  // Try platform-specific npm package
  try {
    nativeBinding = require(`@then/compiler-native-${key}`);
    break;
  } catch (e) {
    loadError = e;
  }
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError;
  }
  throw new Error(
    `@then/compiler-native: No native addon found for ${platform}-${arch}. ` +
    `Run 'npm install @then/compiler-native' or build from source with 'napi build --release'.`
  );
}

module.exports.scanRoute = nativeBinding.scanRoute;
module.exports.transformJsx = nativeBinding.transformJsx;
module.exports.watchDirectory = nativeBinding.watchDirectory;
