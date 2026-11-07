# Playground 真实环境接入

用户要求：Playground 与嵌入宿主的默认界面保持一致，使用真实环境、真实机器人，移除 Mock 数据。仅保留 Chat Kit 与 RemoteTool 两种连接；RemoteTool 提供 add(a,b)。

范围为 IN：Playground 是本仓库的私有宿主。公共 UI 直接复用 ManagerChatApp，不定制其主题、文案、渲染器或导航。登录、目录、机器人、平台、会话和消息均通过公共 SDK 获取，默认 test Manager 为 https://rest.test.turingfocus.cn。保留 staging、正式和自定义真实地址。

页面并列显示默认 Chat Kit 和 RemoteTool 控制面板。身份在本页共享；两侧显式选择机器人，独立连接和释放。RemoteTool 可以先于聊天连接，无须选择聊天会话。同一身份、同一服务 origin 和 Engine.IO path 使用显式共享连接；不同机器人不得复用。切换身份或环境立即释放旧连接、在途注册和调用记录。无凭据持久化、后台轮询或密码重放。

ManagerClient 新增可选 robotSessionScopes，默认 chat:read/chat:send；RemoteTool 专用 ManagerClient 显式申请 action:execute，服务端仍决定授权。范围在客户端创建时验证并复制，不改变已有 SessionProvider 的权限，不把会话 ID 引入注册。该字段可向后兼容，不改变 ADR-012/013/014/015/017 的所有权及依赖边界，无需新 ADR。

RemoteTool 内置 add：JSON Schema 与执行时均要求两个有限数值，拒绝非法参数及溢出，只记录真正来自 Server 的调用。页面不提供伪造调用或模拟成功按钮。注册权限不足、工具重名和网络失败按 SDK 状态呈现，手动注销只结束工具连接。

实施：增强 Manager 换票配置；新增 Playground 实例与 RemoteTool 生命周期装配；替换 app/styles/Vite 入口；删除旧共享演示服务和已退役页面测试；保留独立协议测试夹具。同步文档和 Changeset。

验证：真实本地 HTTP/Socket.IO 驱动登录、目录、换票、聊天订阅、RemoteTool 注册和 add 回传，验证权限与连接数、单方释放和身份隔离。浏览器验证默认 ManagerChatApp、真实目录选择、两种启动顺序、错误和注销、移动端、环境切换。测试设施只存在测试进程，Playground 不启动模拟后端。类型、Lint、构建及隔离审查通过后交用户在 test 集群操作真实账号和机器人；不代用用户密码，不将本地设施验证宣称为外部业务验收。
