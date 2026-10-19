// Build-time configuration. In development `bun run start` (hexclave dev) injects the EXPO_PUBLIC_* values.
export const config = {
  hexclave: {
    apiUrl: process.env.EXPO_PUBLIC_HEXCLAVE_API_URL ?? "https://api.hexclave.com",
    projectId: process.env.EXPO_PUBLIC_HEXCLAVE_PROJECT_ID ?? "",
    publishableClientKey: process.env.EXPO_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY ?? "",
    // The emailed link points here; users type the 6-digit code into the app instead.
    otpCallbackUrl: process.env.EXPO_PUBLIC_ZUNOS_OTP_CALLBACK ?? "http://localhost/zunos-auth",
  },
  // zunos backend (apps/api): launches GPU training on the owner's Runpod account.
  apiUrl: process.env.EXPO_PUBLIC_ZUNOS_API_URL ?? "",
  // Development: run the engine from the repo's uv workspace. Packaged builds use the bundled engine.
  repoRoot: process.env.EXPO_PUBLIC_ZUNOS_REPO ?? "",
};
