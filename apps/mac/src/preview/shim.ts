// Must be the first import of Preview.tsx. Expo's DOM entry expects the native WebView to have
// injected these globals; in a plain browser tab nothing did, so supply empty ones. Inside the real
// WebView (ReactNativeWebView present) this does nothing.
const w = window as unknown as Record<string, unknown>;
if (typeof w.ReactNativeWebView === "undefined") {
  w.$$EXPO_DOM_HOST_OS ??= "macos";
  w.$$EXPO_INITIAL_PROPS ??= { names: [], props: {} };
}

export {};
