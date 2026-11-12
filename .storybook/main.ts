import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import sources from "../tsconfig.tests.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: "@storybook/react-vite",
  staticDirs: [{ from: "../playground/public/demo", to: "/demo" }],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    return mergeConfig(config, {
      resolve: {
        alias: Object.entries(sources.compilerOptions.paths).map(
          ([name, files]) => ({
            find: new RegExp(
              `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
            replacement: path.resolve(root, files[0]!),
          }),
        ),
        dedupe: ["react", "react-dom"],
      },
    });
  },
};
export default config;
