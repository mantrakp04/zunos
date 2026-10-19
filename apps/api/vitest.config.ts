import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only values; RUNPOD_MOCK keeps every test away from the real Runpod API.
          bindings: {
            TEST_MIGRATIONS: migrations,
            HEXCLAVE_PROJECT_ID: "proj_test",
            HEXCLAVE_PUBLISHABLE_CLIENT_KEY: "pck_test",
            HEXCLAVE_API_URL: "https://hexclave.test",
            ALLOWED_EMAILS: "alice@example.com, Bob@Example.com",
            RUNPOD_MOCK: "1",
            RUNPOD_API_KEY: "rp_test_key",
            RUNPOD_API_URL: "https://runpod.test/v2",
            HF_TOKEN: "hf_test",
            R2_ACCOUNT_ID: "acct123",
            R2_ACCESS_KEY_ID: "AKIDTEST",
            R2_SECRET_ACCESS_KEY: "r2secret",
            R2_BUCKET_NAME: "zunos-test",
            PUBLIC_URL: "https://api.zunos.test/",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
