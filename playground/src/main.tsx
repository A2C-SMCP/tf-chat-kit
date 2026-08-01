import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import type { Locale } from "antd/es/locale/index.js";
import * as zhCNModule from "antd/es/locale/zh_CN.js";

import { PlaygroundApp } from "./app.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) throw new Error("缺少 Playground 根节点");
const zhCN = (zhCNModule as unknown as { readonly default: Locale }).default;

createRoot(root).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <PlaygroundApp />
    </ConfigProvider>
  </StrictMode>,
);
