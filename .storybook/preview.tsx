import type { Preview } from "@storybook/react-vite";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN.js";
import enUS from "antd/locale/en_US.js";
import { ShowcaseSettings } from "../stories/support/decorators/settings.js";
import "./preview.css";

const preview: Preview = {
  tags: ["autodocs"],
  globalTypes: {
    locale: {
      description: "组件语言",
      toolbar: {
        icon: "globe",
        items: [
          { value: "zh-CN", title: "中文" },
          { value: "en-US", title: "English" },
        ],
        dynamicTitle: true,
      },
    },
    theme: {
      description: "主题",
      toolbar: {
        icon: "paintbrush",
        items: [
          { value: "light", title: "浅色" },
          { value: "dark", title: "深色" },
        ],
        dynamicTitle: true,
      },
    },
    size: {
      description: "展示宽度",
      toolbar: {
        icon: "browser",
        items: [
          { value: "wide", title: "桌面" },
          { value: "compact", title: "侧栏 380px" },
          { value: "mobile", title: "窄屏 320px" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: "zh-CN", theme: "light", size: "wide" },
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: [
          "开始使用",
          "问询交互",
          "聊天工作区",
          "消息与事件",
          "输入与会话",
          "状态与恢复",
          "认证与接入",
        ],
      },
    },
    controls: { expanded: true },
    a11y: { test: "todo" },
  },
  decorators: [
    (Story, context) => {
      const locale = context.globals["locale"] === "en-US" ? "en-US" : "zh-CN";
      const dark = context.globals["theme"] === "dark";
      const width =
        context.globals["size"] === "compact"
          ? 380
          : context.globals["size"] === "mobile"
            ? 320
            : 1120;
      return (
        <ConfigProvider
          locale={locale === "zh-CN" ? zhCN : enUS}
          theme={{
            algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: { colorPrimary: "#236653", borderRadius: 8, fontSize: 14 },
          }}
        >
          <ShowcaseSettings value={{ locale }}>
            <div
              className="showcase-canvas"
              data-theme={dark ? "dark" : "light"}
            >
              <div className="showcase-frame" style={{ maxWidth: width }}>
                <div className="showcase-notice">
                  受控演示数据 · 无需登录 · 不连接真实服务
                </div>
                <Story />
              </div>
            </div>
          </ShowcaseSettings>
        </ConfigProvider>
      );
    },
  ],
};
export default preview;
