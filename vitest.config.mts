import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        kvNamespaces: ["DEVICE_TOKENS", "AUTH_TOKENS"],
        bindings: {
          APNS_BUNDLE_ID: "com.aptove.app",
          APNS_SANDBOX: "true",
          APNS_KEY_ID: "ABC123DEF4",
          APNS_TEAM_ID: "DEF456GHI7",
          APNS_PRIVATE_KEY: "test-key",
          FCM_PROJECT_ID: "test-project",
          FCM_CLIENT_EMAIL: "test@test.iam.gserviceaccount.com",
          FCM_PRIVATE_KEY: "test-key",
          TOKEN_SERVICE_URL: "https://token.aptove.com",
        },
      },
    }),
  ],
  test: {},
});
