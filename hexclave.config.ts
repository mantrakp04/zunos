import { defineHexclaveConfig } from "@hexclave/js";

// zunos signs users in with an emailed one-time code, entered inside the app (no browser round trip).
export const config = defineHexclaveConfig({
  apps: {
    installed: {
      authentication: { enabled: true },
      emails: { enabled: true },
    },
  },
  auth: {
    allowSignUp: true,
  },
  "auth.otp": { allowSignIn: true },
  "auth.password": { allowSignIn: false },
});
