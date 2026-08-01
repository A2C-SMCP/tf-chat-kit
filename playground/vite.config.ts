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
      "@turingfocus/chat-gateway-tfrobot": packageSource(
        "chat-gateway-tfrobot",
      ),
      "@turingfocus/chat-protocol": packageSource("chat-protocol"),
      "@turingfocus/chat-react": packageSource("chat-react"),
      "@turingfocus/chat-runtime": packageSource("chat-runtime"),
      "@turingfocus/chat-testing": packageSource("chat-testing"),
      "@turingfocus/chat-ui-antd": packageSource("chat-ui-antd"),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
});
