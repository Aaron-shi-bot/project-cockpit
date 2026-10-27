# 数据模型与约束

日期：2026-10-23。下列为本轮实现约束，依据[规格](spec.md)与[唯一接口合同](../../server/contract.md)。工程采用一个部署实例一个工作区；工作区边界由整个私有数据库承载，不宣称已有多租户数据库。

## 物理持久化

SQLite保存 `users`、`sessions`、`entities`、`file_bytes`、`invitations`、`audit`、`operations`、`login_attempts`、`settings`。业务实体使用kind/id/project_id/version/deleted_at/payload，文件字节以版本ID关联BLOB。所有运行数据位于私有DATA_DIR，不由静态服务直接暴露。后续迁移可拆分关系表，当前不可虚构不存在的ORM迁移层。

## 实体

| Entity | 核心字段与关系 | 验证与授权约束 |
|---|---|---|
| Membership/User | id、name、email、password_hash、workspace_role、status、version、time_zone | 邮箱规范化且唯一；password为10—256字符，仅存随机盐摘要；owner/admin/member；active/suspended；唯一有效owner；time_zone为有效IANA时区，默认Asia/Shanghai，旧库兼容补列，API名为timeZone |
| Session | token_hash、user_id、csrf、expires | 服务端摘要定位，默认8小时；每次检查成员有效；退出与停用撤销；不得返回口令摘要 |
| Invitation | id、token_hash、email、payload角色与可选项目范围、expires、used、revoked | 默认7天、单次接受、接受时重检邀请人权限；token只创建时返回用于复制，不存明文 |
| Team | name、memberIds | name为1—80字；只允许有效成员；只有owner/admin可管理；成员变化重新计算项目授权 |
| ProjectGrant | projectId、subjectType、subjectId、role | member/team来源；maintainer/collaborator/viewer；同来源唯一；取最高有效角色；维护者才能管理 |
| Project | name、goal、ownerId、color、stage、lifecycle、startDate、targetDate、archivedFrom | name为1—80字，goal为1—500字；同名可存在；负责人有效且为维护者；结束日不早于开始日；创建默认planned且仅创建者/显式负责人有维护角色 |
| Task | projectId、title、description、assigneeId、status、priority、dueDate、milestoneId、blockReason、resolution、completedAt | title为1—120字，description为0—5000字；负责人为空或有效协作/维护者；只能关联本项目；优先级low/medium/high；首次默认medium |
| Milestone | projectId、title、dueDate、status、completedAt | pending/done；维护者维护；日期与完成事件分开；关联存在时不直接留下悬空删除 |
| Risk | projectId、title、description、level、status、ownerId、taskId、nextStep、resolution | risk/blocked；open/closed；taskId可空且同项目；任务关联阻塞由任务事务维护，独立风险关闭由维护者 |
| Update | projectId、text、nextStep、createdBy | 服务端记录作者；协作及维护者可提交；只读不可写 |
| Resource | projectId、name、description、kind、url、createdBy、currentVersionId | file/link；链接只接受HTTPS；createdBy为逻辑资料归属，不随新版本上传者改变 |
| ResourceVersion | projectId、resourceId、number、fileName、mime、detectedMime、detectedType、typeVerified、size、createdBy、note、restoredFrom | number连续且不可覆盖；字节关联同版本ID；恢复新增版本；默认实际大小不超过10MiB，部署可配置；不以文件名构造路径；常见类型按签名/元信息识别，未知二进制明确未识别，不将类型识别当作完整解码验证或杀毒 |
| AuditEvent | id、actor_id、project_id、action、kind、object_id、created_at、details | 只追加；管理与业务视图隔离；不得含密码、会话凭据、邀请码或文件正文 |
| Trash/Operation | deletedAt及原归属；user_id/key/request_hash/response | 软删除隐藏业务但保留关系；恢复重验权限；同幂等键不同请求拒绝，不重复创建 |

所有业务实体ID、作者和时间由服务端生成；修改需当前整数version。projectId创建后不可更改。业务字段白名单校验，客户端不得注入createdBy、role或归属。实体恢复不恢复已撤销授权，不启用停用账号。

## 角色与状态

- 工作区唯一owner，可转移给有效账号并再次认证；admin不能自提权，普通成员不能变更工作区角色。owner/admin不隐含项目角色。
- 项目最高有效角色来自直接与团队来源；suspended优先否决。常规撤销不能移除最后有效维护者；紧急停用可先撤权，随后owner按原因和再次认证显式接管。
- 项目planned→active→completed→archived；维护者可重开。归档记录archivedFrom，恢复原状态，completed仍只读；权限调整和撤销可继续。
- 任务todo/doing/blocked/done/cancelled；进入blocked必须原因，离开blocked必须处理说明并同步关闭任务关联阻塞；done重开由维护者执行。取消/删除保留历史。
- 健康派生：未关闭blocked优先，其次未关闭risk，否则normal。任务进度：完成有效数/有效总数；cancelled和deleted排除；0/0返回null，非全完成向下取整。

## 必须保持的事务不变量

1. 初始化及所有权转移后恰有一名有效owner，不允许重复bootstrap重置账号。
2. 项目创建和初始授权同时成功；任务状态、关联阻塞与审计同时成功；失败时全部回滚。
3. 文件BLOB、版本记录、逻辑资料当前指针同事务提交；恢复不更新旧版本字节。
4. 修改先校验version；幂等操作成功响应与业务变化同步保存，重试不重复创建。
5. 直接授权、团队成员或团队授权变更后即重算有效角色与最后维护者；停用先撤会话，不静默删除待交接任务。
6. 每次查询先权限过滤再统计；下载同时检查成员、项目、资源、回收站及版本归属。

完整场景编号见[验收计划](../../../验证/验收计划.md)，数据字段的HTTP表示只在接口合同维护。
