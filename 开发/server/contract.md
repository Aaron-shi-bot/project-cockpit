# 服务接口约定（本机与Sites）

本文件是本机及Sites云端的唯一业务接口合同。下文以本机Node 24服务为基准，云端明确差异集中在末尾“Sites云端运行差异”；没有列出的字段、业务校验、授权和错误口径继续共用。云端目录中的合同文件只作引用，不维护第二份完整API。

本机Node 24，无外部服务端依赖。除文件/导出附件外，`/api` 响应为 JSON，成功直接返回对象（不包 data）；错误 `{error,code,details?}`。创建返回对象，修改返回对象。需登录接口未登录401，项目不可见404，操作权限不足403，版本冲突409。静态服务指向 `开发/dist`。

身份：GET `/api/bootstrap` → `{initialized,limits:{maxFileBytes}}`。POST `/api/setup` `{name,email,password}`（密码至少10位），POST `/api/login` `{email,password}` → `{user,csrfToken}`；GET `/api/me` 相同。Cookie为HttpOnly，同源。每个登录后的写请求必须带 `X-CSRF-Token`。退出 POST `/api/logout`。

GET `/api/state` → `{user,csrfToken,projects,tasks,milestones,risks,updates,resources,versions,members,teams,grants,audit}`。user/member `{id,name,email,workspaceRole:'owner'|'admin'|'member',status:'active'|'suspended',version,timeZone}`，成员无密码。timeZone默认`Asia/Shanghai`；旧库原位补齐字段。成员目录用于指派，项目授权不因工作区角色获得。

追加：state含 `comments`、`invitations`。comments仅可见且未删除任务的讨论；POST `/api/comments` `{projectId,taskId,text}`。PATCH `/api/comments/:id` `{version,text?,deleted?}`限仍有项目协作权限的本人作者或维护者，项目归档/完成只读；编辑保留作者、记录editedAt，删除为软删除，均追加前后值审计。invitations仅管理者获得安全元数据，含 `id,email,name,workspaceRole,projectId,projectRole,expiresAt,status,inviterId`，没有token/hash。GET `/api/invitations` 无token时是需鉴权的管理列表；带token是公开邀请预览。邮箱来自邀请而非加入请求；邀请凭据交付不等同已验证邮箱所有权。

所有对象以 `id` 标识、`version` 乐观锁（PATCH必须传当前version），服务端生成 `createdAt,updatedAt,createdBy`。软删除PATCH `{version,deleted:true}`。`projectId` 创建后不能改变。

- POST/PATCH `/api/projects[/:id]`：`{name,goal,ownerId,color:'lilac'|'blush'|'mint'|'sky'|'butter'|'neutral',stage,lifecycle:'active'|'planned'|'completed'|'archived',targetDate,startDate}`；返回另有 `role,total,done,progress:null|number,health:'normal'|'risk'|'blocked'`。归档恢复PATCH lifecycle active/planned；项目完成需全部有效任务和里程碑完成、无开放风险及 `summary`。

归档额外保存 `archiveFromLifecycle`。恢复请求虽然用 active/planned 触发，但服务端恢复至该原生命周期；原为completed则须另一次显式重开才可写业务。已完成可单独归档。删除只允许可写项目先执行；完成/归档的只读保护作用于任务、资料、风险等业务，权限撤销继续有效。
- POST/PATCH `/api/tasks[/:id]`：`{projectId,title,description,assigneeId|null,status:'todo'|'doing'|'blocked'|'done'|'cancelled',dueDate,priority:'low'|'medium'|'high',milestoneId|null,blockReason?,resolution?}`。受阻必须原因，离开受阻必须处理说明。协作者仅改本人任务状态/说明；创建仅本人或未分配。

协作者创建同样不能写计划：只允许默认medium优先级、空dueDate、空milestoneId；由维护者补充。更新未分配任务且省略assigneeId时保留null。里程碑若仍被任务引用（含回收站任务）禁止删除，先解除关联。
- POST/PATCH `/api/milestones[/:id]`：`{projectId,title,dueDate,status:'pending'|'done'}`，维护者操作。任务与里程碑返回`completedAt/reopenedAt`（发生后才有），重开保留原完成时间。
- GET `/api/tasks/:id/history`、GET `/api/milestones/:id/history`：有效项目读取角色可查看该对象自身业务历史，返回现有audit结构的数组，按createdAt及同时间写入顺序升序；不受管理审计最近500条截断。只返回当前未删除对象、相同项目/对象ID/种类的历史，不返回其他对象或管理审计；撤权立即拒绝。
- POST/PATCH `/api/risks[/:id]`：`{projectId,title,description,level:'risk'|'blocked',status:'open'|'closed',ownerId,nextStep,followUpDate,resolution?}`。协作者可报告，项目级关闭维护者操作；任务阻塞由任务接口原子维护。
- POST `/api/updates`：`{projectId,text,nextStep}`。
- POST `/api/resources`：`{projectId,name,description,kind:'file'|'link',url? ,file?:{name,mime,base64}}`；HTTPS链接或私有文件。
- PATCH `/api/resources/:id` `{version,name?,description?,url?,deleted?}`。
- POST `/api/resources/:id/versions` `{version,file:{name,mime,base64},note?}`；恢复旧版用 `{version,restoreVersionId,note?}`，生成新版本。GET `/api/files/:versionId` 鉴权下载。version含 `{id,resourceId,projectId,number,fileName,mime,size,note,createdAt,createdBy}`。
- POST/PATCH `/api/teams[/:id]` `{name,memberIds:[]}`；仅工作区owner/admin。
- POST `/api/grants` `{projectId,subjectType:'member'|'team',subjectId,role:'maintainer'|'collaborator'|'viewer'}`；DELETE `/api/grants/:id`。仅项目维护者；同一来源重复授予更新角色，最后维护者保护。
- PATCH `/api/members/:id` `{version,name?,status?,workspaceRole?,password?,reauthPassword?}`。管理员只管普通成员；所有者转移需再次认证，新owner有效，原owner变admin。
- POST `/api/invitations` `{email,name?,workspaceRole:'member'|'admin',projectId?,projectRole?}` → `{id,token,expiresAt,email,...}`，token仅创建时返回用于复制链接，不发送邮件。GET `/api/invitations?token=...` 公开预览 `{email,name,workspaceRole,expiresAt,projectName?,projectRole?}`；POST `/api/join` `{token,name,password}`→登录结果。DELETE `/api/invitations/:id` 撤销。
- GET `/api/audit`→数组，工作区管理审计与有维护权项目业务审计；GET `/api/trash`→数组，POST `/api/trash` `{kind,id}` 恢复，项目恢复须检查有效维护者。
- POST `/api/demo` 显式导入六项目93任务54完成，仅owner；默认无样例；重复导入409。
- POST `/api/projects/:id/recover` `{reason,reauthPassword}` 仅owner、无有效维护者时应急接管并留审计。
- GET `/api/projects/:id/export` 仅项目维护者，返回业务JSON附件并留审计；文件仅元信息，不包含字节，不等于系统备份。
- PATCH `/api/me` `{name?,currentPassword?,password?,timeZone?}` 修改个人资料/密码/时区。时区必须为有效IANA名称（如Asia/Shanghai、America/Los_Angeles、UTC），拒绝裸偏移量；保存不改变日期型计划。再次认证密码缺失或错误返回`403 {code:'REAUTH_REQUIRED',error:...}`，调用方保留表单；真正权限不足仍按权限错误处理。适用于个人改密、管理重置、所有权转移及应急接管。

上传上限默认10MiB，通过 `MAX_FILE_BYTES`配置。默认SQLite和文件写入 `开发/data`，测试传独立临时路径；可通过 `DATA_DIR`、`HOST`、`PORT`、`PUBLIC_ORIGIN`、`SECURE_COOKIE` 配置。云端应HTTPS反代，外网发布由主任务另行处理。

文件字节实际保存在SQLite私有BLOB表中，不暴露静态URL；下载统一为附件和 `application/octet-stream`。除base64编码、声明格式和真实字节大小外，新增基于签名及ZIP中央目录的类型识别：PDF、PNG/JPEG/GIF/WebP/BMP/TIFF、UTF-8/带BOM的UTF-16文本（含常见JSON/XML/SVG）、普通ZIP及未加密Office ZIP，亦识别常见旧Office OLE容器。已识别类型与具体声明不符返回`400 FILE_TYPE_MISMATCH`且回滚；application/octet-stream可作为通用声明，Office ZIP也允许通用ZIP声明，文本子类型不保证全部语义解析。version另返回`detectedMime,detectedType,typeVerified`：未知二进制用null/unknown/false明确标示，可作为通用或未知厂商类型保存，不能谎报支持格式。旧版本可能没有这些元信息；新上传及恢复旧版时执行识别。签名识别不等于文件完整有效、可打开或无恶意内容，不解压内容、未集成病毒扫描；加密/特殊容器可能只能识别容器或标未知。

备份命令 `node server/backup.mjs <原数据库.sqlite> <新备份.sqlite>` 使用SQLite `VACUUM INTO`生成含文件版本字节的一致快照，并执行完整性检查；不覆盖已存在备份。恢复应停服并替换数据目录中的数据库，不能把业务JSON导出当恢复文件。

认证限流按失败统计：邮箱+来源IP连续5次失败/15分钟，来源IP认证失败总计40次/15分钟；成功的setup/login/join不累积共享反代IP计数。默认不信任任意X-Forwarded-For。幂等缓存每次重放按原请求对象重新检查当前权限，撤权后无法通过旧operationId读取响应。审计先过滤授权后取最近500条；任务、里程碑、风险、团队变更含before/after业务字段，不记录密码或认证凭据。

## Sites云端运行差异

本节对应[002部署规格](../specs/002-sites-deployment/spec.md)，运行实现位于 `站点/project-cockpit`。业务路径、请求字段白名单、角色、版本及下载权限沿用上文；以下只定义运行环境产生的差异，不表示站点已发布或生产验收通过。

- **运行与隔离**：Cloudflare Worker经Vinext提供前端与同源 `/api`；`DB`绑定D1逐行元数据，`BUCKET`绑定私有R2。云端不读取本机 `开发/data`，不带入4173/4174库、账号、会话或上传文件，不运行4174设计预览wrapper。
- **首次建立**：GET `/api/bootstrap` 额外返回 `setupProtected:true`，不返回任何初始化秘密。POST `/api/setup` 请求体仍为 `{name,email,password}`，同时必须携带 `X-Bootstrap-Token`，与运行时secret `BOOTSTRAP_TOKEN`匹配；配置至少43字符，部署方须使用至少32随机字节生成。缺配置、缺凭据或错误值返回 `403 SETUP_FORBIDDEN`；库中已有账号返回 `409 ALREADY_INITIALIZED`。首owner、会话与初始化审计在一次持久提交中建立，并发只有一次成功；不能重设所有者。初始化secret由私下fragment链接交付，前端读取后立即移除片段，仅临时内存保存及setup header提交，不进入body、URL查询、浏览器持久存储、日志或静态包。
- **会话与HTTPS**：新会话Cookie为HttpOnly、Secure、SameSite=Lax，8小时过期。生产只接受HTTPS同源写入，继续校验当前会话及CSRF；身份不由平台显示邮箱或客户端角色字段决定。个人 `PATCH /api/me` 改密保留当前已验证会话并撤销该用户其他会话；管理重设密码（包括所有者重设自己）撤销该用户全部会话，退出撤销当前会话，停用撤销访问与会话。云端不将HTTP测试模式带到生产；`LOCAL_WORKER_TEST=1`只允许明确loopback隔离workerd测试。来源IP取Cloudflare覆盖的CF-Connecting-IP，不信任任意X-Forwarded-For。
- **默认空工作区**：POST `/api/demo` 在云端固定返回 `403 DEMO_DISABLED`；公网不导入演示或本机私有数据。正式团队仍以内置账号与一次性邀请加入，不增加公开注册或邮件发送。
- **D1提交**：每个请求经 `first-primary` session的单次batch读取实体与revision；领域计算只使用该请求的Map。所有业务差异、关联风险、审计、安全记录与幂等结果通过全局revision的NOT NULL CAS保护，在同一个batch提交。CAS竞争自动重新读取/计算最多两次，仍冲突返回 `409 REVISION_CONFLICT`；旧业务对象version继续返回 `409 VERSION_CONFLICT`。无跨请求授权缓存、无整库JSON行、无请求内DDL；幂等重放仍先验证当前权限。
- **私有文件**：版本字节进入私有R2不可变对象，D1保存版本关系、服务端生成对象key、大小与SHA-256；用户文件名不构成对象路径。API每次重新鉴权后返回附件及 `application/octet-stream`，不返回公开桶URL。默认10MiB上限、严格base64及已有类型识别边界保持；运行时 `MAX_FILE_BYTES`可配置。
- **R2失败恢复**：写对象前先持久登记清理任务，成功后通过D1业务提交删除该任务。明确数据库回滚时立即尝试删除孤立对象，删除失败保留任务；提交结果不确定时不立即删对象，延迟1小时核对D1引用后再清理，不能删除已提交版本的字节。owner请求少量重试到期任务，无人访问时没有后台定时清理。存储暂时失败返回 `503 INTERNAL_ERROR`，不回显SQL、物理对象路径或堆栈。
- **迁移与备份**：新云库使用受版本管理的schema-only Drizzle SQL；不携带seed或本机账号，已应用迁移不可原位改写。本机SQLite备份命令不适用于Worker；云端完整恢复需要配对D1元数据与R2历史字节。业务JSON导出仍不是完整备份，不声称已提供定时备份、云端恢复演练或容量承诺。
