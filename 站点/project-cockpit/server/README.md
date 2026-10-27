# 云端服务维护入口

`worker-api.mjs` 接受标准 `Request` 和运行时 `DB`、`BUCKET` 绑定；`app/api/[[...path]]/route.ts` 接入 Vinext。`kernel.mjs` 保留本机版已验收的业务规则，但不导入 SQLite、HTTP server 或文件系统。`memory-store.mjs` 仅是固定仓储语句的请求内存适配，不对用户输入执行 SQL。

`d1-store.mjs` 负责 first-primary 单次 batch 快照、全局 revision CAS 和差异行提交。CAS 失败使用 NOT NULL 约束使整批回滚，再重新读取并运行原业务判断；不会将旧快照覆盖到新数据。实际表定义位于 `db/schema.ts`，用项目 `db:generate` 生成静态 migration，运行时不建表。

文件先写私有 R2、后在 D1 原子提交引用。上传前先登记 `upload_cleanup`；明确回滚会尝试立即删除，结果未知时保留对象。到期清理先检查 primary 上的有效引用，保留已提交版本。owner 请求每次最多检查两项；这不是定时任务或备份服务。

生产只接受 HTTPS。初始 owner 需要至少 43 字符的运行时 `BOOTSTRAP_TOKEN` 与 `X-Bootstrap-Token` 匹配；应由部署方生成至少 32 个随机字节并设置为 secret。现有账号后初始化接口固定拒绝。session 为 Secure、HttpOnly、SameSite=Lax、8 小时；CSRF、来源检查、失败限流、项目读写权限在服务端验证。云端禁用 demo，保持空库。

本机 adapter 回归（不需端口）：

```powershell
node --test server/tests/cloud.test.mjs tests/cloud-independent.test.mjs
```

测试适配器通过真实 `node:sqlite` 事务执行 D1 batch，可注入真实约束失败；R2 使用内存字节。它验证业务和提交协议，不替代 Worker、D1 或 R2 的真实运行时验收。

真实 workerd 回归由 `server/tests/workerd-entry.mjs` 提供入口。使用临时 Wrangler 配置，绑定独立本机 D1/R2 目录，设置本机专用 `LOCAL_WORKER_TEST=1` 和 `BOOTSTRAP_TOKEN`；生产 manifest 不得设置前者。应用静态 migration 后运行：

```powershell
$env:CLOUD_TEST_ORIGIN = 'http://127.0.0.1:4176'
$env:CLOUD_TEST_FILE_BOUNDARY = '1'
# BOOTSTRAP_TOKEN 由本机环境提供，不写入代码或日志。
node server/tests/workerd-http.mjs
```

脚本拒绝所有公开主机，并要求空库；生成一次性测试账号，核对实际 scrypt 创建/验证、D1 写入、R2 v1/v2 字节、撤权与 10MiB 边界，不打印密码、会话或原始邀请 token。验收结束删除已核对路径的独立本机夹具目录。它不会导入正式用户数据。

实际 workerd HTTP 回归结果保存为 `server/tests/workerd-results.json`。脚本检查 API 全部主要业务路径，另验证同对象竞争、完成归档恢复、成员停用重启用、改密撤销旧会话和资料旧版恢复；它要求每次使用新的隔离持久目录。已安装 Wrangler 4.92.0 的 workerd 支持的最新兼容日期为 `2026-05-22`，本机测试配置据此设置，不直接使用系统日期。

停启持久化单独运行：

```powershell
node server/tests/workerd-restart.mjs
```

该 runner 使用忽略目录 `.sites-runtime/workerd-test.json`、仅监听 4181，在 `.sites-runtime/workerd-test-state/restart-*` 建立新夹具，始终只在进程内存保留测试密码。它经 HTTP 建账号、时区、项目、直接和团队授权及资料 v1/v2，停止进程树，以同一持久目录重启，重新登录并比较记录及字节 SHA256，最后停止并确认端口已关闭。输出为 `server/tests/workerd-restart-results.json`；这是 D1/R2 停启持久化验证，不是云端完整备份恢复演练。不要与其他占用 4181 的服务同时执行。
