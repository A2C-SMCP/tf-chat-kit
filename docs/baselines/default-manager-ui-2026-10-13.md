# 默认 Manager UI 验证记录

2026-10-13，`feat/default-manager-ui`，基线 `77c05f32a53d8ea034694f9d052c3e808c5a15bf`，#129 / #128，milestone 0.10.0。待发布源码打包，未提交、合并或发布；tarball 版本仍是核心 0.10.0-next.0、auth 0.11.0，不能将本轮 UI 当成已发布版本的功能。

## 本地质量与消费者

- 全量 Vitest：84 文件、1,494 测试通过。后续认证/UI改动定向回归通过；新增 development StrictMode DOM 用例验证重复 setup/cleanup、卸载释放全部 UI 订阅、宿主客户端保持有效、迟到目录响应不重建 UI。
- TypeScript、ESLint、格式、工作区、依赖边界、Changesets 和 Playground 构建通过。
- `pnpm pack:check` 通过：制品安全扫描、公开入口、类型与独立 Headless/React/UI/认证消费者；中文文案 key 改为 passwordLabel，未放宽凭据扫描。
- 独立打包浏览器消费者使用 React 18.3.1 / AntD 5.23.4，原生 HTTPS fetch + Socket.IO，覆盖 Chromium 与 Linux WebKit。macOS WebKit 启动 Bus error，改用已有 Playwright 1.62.1 noble 容器。
- 覆盖显式登录/账户/平台、无空会话创建、发送/Socket 回复、历史重命名/删除、草稿、退出、英文恢复、宿主预设替换、401同身份恢复/跨组织清理、目录及Server发送403遮蔽且不重复换票、中文登录错误；历史分页403与长文本回归也通过。最终两种浏览器共16项用例全部通过。
- 320/380/480/760 容器宽度无主区横向溢出；200% CSS zoom 做可见性检查，不能作为完整浏览器缩放/可访问性认证。
- #128 的真实 npm 依赖解析已在 auth 无 override 的独立消费者中验证为 0.11.0；本次 auth 有新增 UI API，最终 UI 测试使用当前全部 tarball。打包测试持续断言门面依赖等于 auth 自己的版本，不能用核心版本替代。

## test 集群真实 UI

实际默认组件由独立 tarball 消费者在 http://127.0.0.1:4318/ 挂载，不使用 Playground 页面。用户已登录 `https://user.test.turingfocus.cn` 的 `TFRM591域名验收1003`，测试驱动仅在内存注入该会话到公开 Auth transport，调用 `auth.restore()` 校验身份；没有输出、落盘凭据，也不将读取 Portal Cookie 当作产品登录方案。

服务地址：Manager `https://rest.test.turingfocus.cn`；机器人可信来源 `https://tfrm642-1010-g.test.turingfocus.cn`；REST `routed-server` + `json-v2`；Server 使用 current-server 档位。本轮未重新核对 Kubernetes 镜像，不引用旧镜像作为现场证明。

1. 认证恢复成功，目录显示原账户 A/B 两个机器人。
2. 选择 A 后展示真实平台 A2A；单个平台仍需明确确认。
3. 第一次发送创建唯一标题 `UI验收20261013-2100：请只回复「默认界面接入成功」。` 的会话；未刷新历史前实时收到助手回复“默认界面接入成功”。
4. 打开设置后返回、切到已有历史再返回，临时草稿“本轮默认UI草稿”保留，历史助手回复一致。
5. 仅将本轮会话重命名为 `UI验收20261013-2100-完成`，随后经删除确认精确清理。清理前原有四段历史，清理后仍为同四段，未改名/删除其他记录。
6. 切换到 B 后重新进入平台选择，显示 B 的 A2A 与 TFRM591-dev25-1008，未沿用 A 的平台选择。

截图在本地原工作区 `.playwright-mcp/default-manager-ui-test-cluster.png`。服务显示 best-effort/degraded 提示符合 current-server 无严格回放契约的现状，不宣称无损恢复。

## 隔离审查

经三轮独立无会话继承的只读审查，已修复目录、消息发送及历史分页403遮蔽、使用其他账号的草稿确认、焦点返回、宿主portal、错误本地化问题。最终结论 APPROVE，无阻塞项。平台预设名称派生建议已采纳；纯展示组件拆分和更多组合场景作为后续建议。

## 未验收项

尚未启动真实 Microsoft Word/WebView；本轮 test 登录密码提交使用本地真实 HTTP 测试设施验证，test 集群现场使用宿主认证恢复。屏幕阅读器、完整对比度审计、所有软键盘/缩放组合、真实 Office 隐藏/恢复仍需宿主 UAT。不能据此关闭全部 milestone Issue 或宣称正式发布验收完成。
