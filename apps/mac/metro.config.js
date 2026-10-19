const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const desktopMetro = path.dirname(require.resolve("expo-desktop-metro-config/package.json"));
const { makeMetroConfig } = require(require.resolve("@rnx-kit/metro-config", { paths: [desktopMetro] }));
const { resolve: metroResolve } = require(
  require.resolve("metro-resolver", { paths: [path.dirname(require.resolve("expo/package.json"))] }),
);

const expoConfig = getDefaultConfig(__dirname);
const config = makeMetroConfig(expoConfig);

// DOM components ("use dom") are web bundles. rnx-kit's out-of-tree resolver rewrites
// `react-native/*` deep imports to `react-native-web/*` on web, which plain Expo doesn't do,
// so keep rnx-kit for native platforms only.
const rnxResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform !== "web") return rnxResolve(context, moduleName, platform);
  const { resolveRequest, ...rest } = context;
  return metroResolve({ ...rest, preferNativePlatform: false }, moduleName, platform);
};

module.exports = config;
