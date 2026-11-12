import { createContext, useContext } from "react";
import {
  compactChatZhCN,
  resolveChatUiLabels,
} from "@turingfocus/chat-ui-antd";

const SettingsContext = createContext<{ locale: "zh-CN" | "en-US" }>({
  locale: "zh-CN",
});
export const ShowcaseSettings = SettingsContext.Provider;
export const useShowcase = () => {
  const { locale } = useContext(SettingsContext);
  return {
    locale,
    labels: resolveChatUiLabels(
      locale === "zh-CN" ? compactChatZhCN : undefined,
    ),
  };
};
