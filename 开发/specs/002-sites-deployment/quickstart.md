# 002 运行与验证入口

日期：2026-10-23。当前为计划入口，以下命令应由实现完成后按顺序执行；**本文件不证明依赖、构建、迁移或部署已完成**。验收判定见[acceptance.md](acceptance.md)，业务合同继续引用[现行合同](../../server/contract.md)。

## 前提

使用项目根目录下唯一的 `站点/project-cockpit` checkout；主任务负责完成官方starter配置和依赖安装。不要重复初始化或同时运行第二个安装器。需要D1 `DB`与私有R2 `BUCKET`绑定，以及仅配置在运行时的 `BOOTSTRAP_TOKEN`。本地空库与线上库不同，不能复制4173或4174的库、账号和上传。

## 本机基准与云适配测试

在 `开发/` 运行现有 `npm.cmd test`，将结果保留为本机基准；进入 `站点/project-cockpit/` 后分别执行：

```powershell
node --test server/tests/cloud.test.mjs
node --test tests/cloud-independent.test.mjs
```

测试文件由实施任务产生；若尚不存在，保持未执行而不是用旧37组数字代替。两条云适配测试仍只是业务核与持久层模拟，需要继续验证真实Worker。

## 本地真实Worker

1. schema完成后在站点目录执行 `npm.cmd run db:generate`，审阅新SQL与元数据，确保只包含schema且不含账号/演示seed。已有迁移不可重放或原位改写。
2. 按Sites技能通过已安装插件的 `scripts/build-site.mjs` 构建；它的位置由当前插件安装路径解析，不在本文固化机器路径。独立本地调试可使用站点 `npm.cmd run build`，发布仍遵循官方helper流程。
3. 使用构建产生的 `dist/server/wrangler.json`，按官方starter README的本地D1命令逐个应用未执行的实际 `drizzle/*.sql`。不能把示例文件名当真实迁移，也不能把本地迁移成功写成生产已迁移。
4. 以未跟踪本地运行时secret配置初始化凭据，值不写在命令行、README或输出。运行 `npm.cmd start -- --port 8788`（如占用则换另一个空闲端口），保持loopback，避开4173/4174。
5. 按DEP-AC执行空库防抢占、首owner竞争、邀请撤权、两版文件、409及失败注入。记录持久目录，停止并重启相同Worker后核对数量和字节摘要。

不要以开发热更新页面或仅测试Node/SQLite代替built Worker。若sandbox禁止本地监听，按宿主授权规则在隔离临时环境执行，不能把环境EACCES/EPERM判为业务测试失败。

## 生产发布与验证

由主任务复用已创建的站点ID，以官方Sites源码helper打包、保存版本及部署；实际公开访问配置从native工具返回状态核对。secret只经支持的运行时secret工具，凭据通过stdin或原生结构化参数传递，不写入源码、manifest、归档或命令行。不要在未知创建结果下重复新建站点。

部署工具的终态网址和版本先记录，再用实际HTTPS完成DEP-AC中适用P项。首次有效初始化通过私下交付的fragment链接，界面读取后清理fragment，setup额外header提交；普通登录无需此凭据。线上绝不启用4174自动会话。

同一代码重新发布且保持原DB/BUCKET后再次核对数据与文件；这可以证明跨发布持久化，若无法证实物理isolate冷启动，必须单列该限制。发布结果与用户页面设计评价分开；全部实测统一进入[验收记录](../../../验证/验收记录.md)，本文不追加第二份通过表。

