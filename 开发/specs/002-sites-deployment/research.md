# 002 部署研究与实施决定

日期：2026-10-23。本文记录现有工具与方案依据，不是运行成功或性能承诺。业务依据是[PRD](../../../需求/PRD.md)U-14、REQ-020，沿用[001](../001-team-cockpit/spec.md)。

## 运行与源码边界

**Decision**：使用已安装Sites 1.1.1提供的官方Vinext starter，工作目录为 `站点/project-cockpit`；复用既有React界面到 `cockpit/`，服务经 `app/api/[[...path]]/route.ts` 委托Worker适配器。部署由站点所有者运行官方注册、源码同步、构建和发布工具。

**Rationale**：用户明确选Sites并授权公开部署。当前本机Node HTTP/SQLite服务不能原样在Workers中运行；只上传静态前端不能满足多人持久化。

**Alternatives considered**：自有服务器部署与纯静态演示均不符合当前目标；不重建另一套产品或设计。保留本机工程与测试作为行为基准。

来源：当前安装Sites技能 `SKILL.md` 与 `references/storage.md`。已确认官方starter的 `db/schema.ts`、`drizzle/`、`DB`/`BUCKET` 绑定与schema-only迁移流程；构建前生成并检查SQL，发布由平台执行迁移。项目本轮不把本机业务数据写入迁移。

## 身份与首次所有者

**Decision**：沿用用户选择的内置账号及邀请，不以平台身份自动赋予工作区或项目权限。Worker的会话、CSRF、密码验证和失败限流必须服务端执行并持久保存。个人改密撤销其他会话、保留当前已验证会话；管理重设（包括重设自己）撤销该用户全部会话，停用和退出沿用原规则。`BOOTSTRAP_TOKEN`由运行时secret配置；随机生成至少32字节，使用URL fragment交付到初始化界面，读取后移除fragment，仅在 `POST /api/setup` 的 `X-Bootstrap-Token` 请求头提交。不写入localStorage/sessionStorage、静态包或日志。未配置时fail closed，建立后不再可用。

**Rationale**：公开空库若沿用本机“先到先建立”会让陌生人抢占所有权。用户已明确内置账号，Sites平台身份与业务权限分别处理；保留平台保留路由和托管集成。

**Alternatives considered**：固定演示密码、公开注册、将初始化秘密放查询参数或源码、无凭据初始化均拒绝。单凭secret比较不足以阻止并发，消费状态与首位所有者须在同一次持久提交中完成。

## 业务复用与D1并发

**Decision**：提取现有合同业务核为 `server/kernel.mjs`，请求内Map仓库为 `server/memory-store.mjs`，持久化适配为 `server/d1-store.mjs`。D1逐行保存实体，不用全库JSON文件。一次请求从primary一致快照读取，写入按全局revision作CAS检查并通过一个batch提交差异、审计和幂等记录。对象version规则继续保留；无效revision不能执行部分业务写入。

**Rationale**：复用经过本机负面测试的规则，同时让多个Worker实例通过持久层确定最终结果。请求内Map只供规则计算，不能承担跨请求的会话、授权或业务数据。

**Alternatives considered**：每次无条件覆盖全库、单实例锁、跨请求内存缓存、逐条无事务写入均不能保护多实例竞争。所谓CAS必须用真实本地Worker及线上并发验证；SQLite模拟通过不能证明云端batch一定正确。必要时安全冲突返回409，不静默重放陈旧结果。

## R2私有文件与失败处理

**Decision**：所有文件字节进入私有R2，使用服务端生成的不可变对象key；D1只存版本元数据和对象引用。下载由API在当前鉴权后读取对象，以附件返回；不设置公开桶或长期公开URL。R2写入与D1提交不能假装是同一数据库事务；提交失败记录/执行孤立对象清理，已提交版本不得指向不存在对象。

**Rationale**：保持现有两版、恢复新增第三版及历史不可覆盖的规则，同时处理文件存储与数据库之间的失败窗口。

**Alternatives considered**：把用户文件名当物理key、可猜测静态URL、覆盖旧对象或先发布版本再异步补字节均拒绝。恢复旧版可引用已验证的不可变字节，具体引用策略须保持旧版独立可下载和清理安全。

## 迁移与发布验收

**Decision**：SQL及Drizzle元数据只定义schema；本机库、会话、账号、4174演示、上传及测试fixture不进入上传源码。秘密经Sites运行时secret工具配置。先跑本机基准、云业务模拟、本地Worker，再发布公开HTTPS并用独立测试账号验证。每层结果单独记录。

**Rationale**：本机37组及构建通过只证明旧环境；即使Sites返回上线成功，仍需验证实际网址的邀请、撤权、文件与持久化。

**Alternatives considered**：仅打包React、仅验证主页200、用浏览器刷新冒充冷启动、把业务JSON导出称为完整备份均不接受。平台迁移失败后先确认实际已应用状态，不能回改已执行迁移或盲目重建存储。

