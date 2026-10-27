# 项目驾驶舱 · Sites 正式工程

这是项目驾驶舱的 Codex Sites 部署工程。公开网址只开放登录入口；项目数据、文件与管理功能仍由内置账号及项目授权保护。没有默认账号，不导入本机演示库。

站点ID和DB/BUCKET声明见 `.openai/hosting.json`，发布使用Sites原生工具与官方source helper。不得在源代码或构建包中保存站点访问凭据、初始化令牌或运行数据库。

## 运行结构

- `cockpit/`：沿用已确认界面的React前端，hash路由与现行API合同保持一致。
- `app/`、`worker/`：Vinext入口和Sites维护的构建集成。
- `server/`：完整业务kernel、D1请求内快照、revision保护的原子batch、私有R2文件。
- `db/schema.ts`、`drizzle/`：D1声明及追加式schema迁移，不在请求中建表。
- `tests/`：隔离适配器和并发/故障验证；浏览器脚本及交付记录在项目根的验证目录。

D1按实体逐行存储，不把全库放在一个JSON字段。写入先在请求快照内校验，然后同批提交revision检查、业务变更、审计及幂等记录；并发变化重读或明确冲突。R2文件先上传，再原子发布元数据；失败/结果不确定的对象通过持久清理记录重核引用后处理。对象下载每次重新鉴权。

## 首次初始化

Sites runtime secret `BOOTSTRAP_TOKEN`必须配置为独立的256bit以上随机令牌。公开未初始化页面只显示等待管理员。由管理员保管的一次性 `/#/setup?token=...` 链接使用URL fragment，页面读取到内存后立即从地址栏清除，仅通过setup请求的 `X-Bootstrap-Token` 发送；不进入查询字符串、源码、日志或浏览器持久存储。初始化前刷新页面须重新打开私密链接。数据库已存在账号时不能再次初始化。初始化链接不可作为公开分享链接。

`PUBLIC_ORIGIN`记录正式来源。Cookie保持HttpOnly/SameSite/Secure，项目权限不由Sites公开访问配置替代。Sites自带身份保留框架兼容，本项目按已确认需求使用内置账号和邀请。

## 本地与发布

使用Sites插件官方脚本安装、构建和封装。本机Windows若外层npm.cmd入口解析失败，可用Node调用已安装npm的JavaScript入口执行同一模板脚本；不另开并行安装。

构建通过后按顺序把drizzle中的未应用SQL施加到本地D1。正式构建配置位于`dist/server/wrangler.json`。本机HTTP测试另在忽略目录`.sites-runtime/preview/`保存配置副本，将main和assets.directory解析到同一dist产物的绝对路径，专用`.dev.vars`放在该预览配置旁；不修改发布产物。用Wrangler的`--config`指定该副本、`--local --persist-to`指定隔离持久目录、`--port 4180`启动。`LOCAL_WORKER_TEST=1`仅允许loopback HTTP测试，不得配置到公开站点。根目录`.dev.vars`不会自动成为dist/server配置的运行时绑定，不能凭HTTP首页200判断API已就绪。

发布会将schema迁移应用到独立云端D1，并通过R2绑定保存私有文件。保存版本必须对应同一个已推送源码commit和其构建归档。不要上传开发/data、验证/设计验收数据、.wrangler或任何本机数据库。

完整规格、任务和验收见项目根 `开发/specs/002-sites-deployment/`。真实读屏器、生产并发、自动异地备份与容量告警不因完成首次发布自动视为通过。
