import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageSource = (directory: string): string =>
  path.join(workspaceRoot, "packages", directory, "src", "index.ts");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@turingfocus/chat-kit/manager-antd": path.join(
        workspaceRoot,
        "packages/chat-kit/src/manager-antd.tsx",
      ),
      "@turingfocus/chat-kit/auth/manager": path.join(
        workspaceRoot,
        "packages/chat-kit/src/auth-manager.ts",
      ),
      "@turingfocus/chat-kit/auth/tfrobot": path.join(
        workspaceRoot,
        "packages/chat-kit/src/auth-tfrobot.ts",
      ),
      "@turingfocus/chat-kit/auth": path.join(
        workspaceRoot,
        "packages/chat-kit/src/auth.ts",
      ),
      "@turingfocus/chat-kit/headless": path.join(
        workspaceRoot,
        "packages/chat-kit/src/headless.ts",
      ),
      "@turingfocus/chat-gateway-tfrobot": packageSource(
        "chat-gateway-tfrobot",
      ),
      "@turingfocus/chat-kit": packageSource("chat-kit"),
      "@turingfocus/chat-protocol": packageSource("chat-protocol"),
      "@turingfocus/chat-react": packageSource("chat-react"),
      "@turingfocus/chat-runtime": packageSource("chat-runtime"),
      "@turingfocus/chat-testing": packageSource("chat-testing"),
      "@turingfocus/chat-ui-antd": packageSource("chat-ui-antd"),
    },
  },
  server: {
    port: 4311,
    strictPort: true,
  },
});
