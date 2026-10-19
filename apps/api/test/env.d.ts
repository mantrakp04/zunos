type ZunosEnv = import("../src/env").Env;

declare namespace Cloudflare {
  interface Env extends ZunosEnv {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
