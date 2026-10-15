# #141：test 集群真实 Server 联调

测试操作：2026-10-15 07:55:03–07:57:08 UTC（北京时间 15:55:03–15:57:08），报告核对截至 08:00 UTC。用户明确授权连接 test 集群并协助登录。
本次没有新打包、发布、升级服务或修改产品代码；使用当前工作区源码，由独立 Vite 测试宿主直连真实服务。

## 源码与环境

- SDK：`feat/141-element-id`，基线 `5b162fec84660a04e60769d3ffec896b1a044874` + 当前未提交修改。
- 受测 `packages` 差异的 SHA-256：`2ca4260af98d26eab0b357f33b5e6dc1e91b6714861917edba6c13651ee82e6c`。
- Manager：`https://rest.test.turingfocus.cn`，管理面已核实 K3s，user-service 为 `0.2.0-dev12`。
- 组织：`TFRM591域名验收1003`；机器人 B：employeeId 16、`de-b79e1550a96a4a6b9294`；由用户在界面选择 A2A 平台。
- Server：`tfrs-org-5/tfrobotserver-de-b79e1550a96a4a6b9294-578dbbf5f8-pqqnj`。
- API、memory-worker、robot-worker 均为 `0.4.3-dev3`，运行镜像 digest：
  `sha256:f8a5fd732c6cab5c27b0188418972d31a5c261505db2108638dedf7aad815997`。
- 浏览器：用户当前 Chrome，界面操作与读取通过原生 AX；测试宿主 `http://localhost:4316`。
- 登录由用户自行完成，SDK 走公开 Auth/Manager/Chat API。没有从旧页面提取 Cookie/Token，未把凭据写到报告或磁盘。

## 方法

独立宿主直接导入本次工作区的 Auth、ManagerChatApp、Gateway 与 Runtime 源码。
`chat.fetch` 包装仍调用浏览器原生 fetch；`socketFactory` 包装仍调用公开 `createSocketIoFactory`，只观察本轮创建的会话。
记录经过白名单投影的 POST 身份、实时 DTO 身份、历史 DTO 身份与作者字段；不记录 Header、密码、Token、已有会话正文或本次请求的任意 raw payload。

在新建会话 10 中连续发送两次完全相同的专用测试文本，等待真实助手回复；再新建会话 11 发送切换测试消息，随后从历史列表返回会话 10。

## 结果

| 检查                       | 实际结果                                                                      |
| -------------------------- | ----------------------------------------------------------------------------- |
| 同正文两次发送             | 两个 POST 均 HTTP 200，得到不同 ID                                            |
| POST / 实时 / 历史三路身份 | 两条用户消息各自完全一致                                                      |
| 实时与历史先后             | 本次两条均为实时先于 POST；先看到 msgId=null，再从历史得到数据库 ID           |
| 真实回复                   | 会话 10 两次收到“联调通过”；会话 11 收到“切换通过”                            |
| 切换回读                   | 会话 10 正式消息区仍是 2 条用户消息、2 条助手回复，没有新增重复或“待核对消息” |
| 昵称变化                   | 实时作者名 user:1，历史作者名 tfrm591-domain-1003；回读后以历史为准且不重复   |
| 发送记录收束               | 正式 DTO 到达后不残留发送记录                                                 |
| Worker 结果                | 三个 run 的真实 robot-worker 日志均为 received → succeeded                    |
| 恢复声明                   | UI 保持“部分过程信息可能不完整”，未因 elementId 提升为完整恢复                |

| 用户消息       | POST / 实时 / 历史相同 elementId   | 历史 msgId |
| -------------- | ---------------------------------- | ---------- |
| 第一次相同正文 | `1841e692595244619c805b2c6f6acbc9` | 48         |
| 第二次相同正文 | `05aab2b783bc4d4497f73bca57c7af2f` | 50         |

两条历史用户消息均具有持久化数据库 ID。实时与历史本轮 UID 都为 `user:1`，因此本次实际证明的是昵称变化，不将其表述为跨 UID 实测。
助手实时 elementId=null、历史 elementId 非空，助手条数仍正确；SDK 没有把助手套入用户身份规则。

Worker 任务与时间（UTC）：

| runId                                  | received | succeeded |
| -------------------------------------- | -------- | --------- |
| `e41fced6-7189-4ab7-891f-e605da797c90` | 07:55:03 | 07:55:06  |
| `7221a144-76e5-49e5-8327-541b18a56463` | 07:55:37 | 07:55:39  |
| `15b7abba-f8a5-42d6-8dc1-01d5685af256` | 07:56:48 | 07:56:49  |

原始脱敏观察记录保留在本机 `/tmp/tfck-141-live/scoped-evidence.json`，聚合断言在 `summary.json`；
断言确认 POST 数量 2、唯一身份 2、实时用户数 2、历史用户数 2、三路集合相等、历史均有数据库 ID。
本轮只新建会话 10、11，暂保留供复查，没有删除或修改既有会话。

## 仍未覆盖

- 没有启动 Microsoft Word；这是本地源码浏览器宿主连接真实 test 服务，不能替代真实 Office WebView/生命周期 UAT。
- 未强制网络断线、制造迟到实时回放或新建磁盘缓存实例；这些仍以既有 SDK 自动化测试为证据，不作为本次集群已实测。
- 本次未运行 Server 全套 PostgreSQL 回归或测试其他用户；历史持久化证明来自真实 Server 的 msgId 回读。
- 运行中 DTO 核验：RunTaskResponseDto 只有 task_id、conversation_title、element_id，没有完整 Message/权威消息时间；
  ChatErrorDto 只有 conversation_id、error、create_timestamp、code，没有 elementId。
  因此 POST 立即正式转正与可精确关联的撤回/繁忙终态缺口仍在。

结论：test 当前 `0.4.3-dev3` 已支持并通过本 SDK 的核心 elementId 真实链路验证；
无需为该核心身份链路另行升级本次目标 Server。完整 #141 仍不可关闭。

测试结束后已关闭本轮 Chrome 临时页并停止 localhost:4316 宿主，释放浏览器连接；脱敏报告及两个专用测试会话保留供复查。
