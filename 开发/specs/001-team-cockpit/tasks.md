# Tasks: 项目驾驶舱团队协作核心

**Input**: `specs/001-team-cockpit/`；[唯一接口合同](../../server/contract.md)。

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md及需求质量清单。

**Tests**: 本规格明确要求关键负面场景自动测试及浏览器验收。U-13本机补齐后37组测试通过（33组服务端、4组日历），最终构建的28项隔离浏览器检查通过，含真实200%缩放和正确改密后重新登录；备份恢复含账号时区的独立演练通过。真实读屏器尚未实测，单列T031。只依据实际实现与证据更新，不按文件存在批量勾选，不补造TDD过程。

**Organization**: 按故事和前置依赖组织。工程路径相对于 `开发/`；`../验证/`指项目根验证目录。[P]只标明不同文件且可独立开展的工作，同一server或页面文件的任务必须由同一负责人顺序整合。

## Format: `[ID] [P?] [Story] Description`

每项都有稳定T编号、可观察动作与文件位置。US1为核心MVP；US2/US3各自依赖公共权限骨架，不依赖彼此的业务界面。所有故事均必须经过服务端权限检查。

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 核对 `package.json`、`package-lock.json` 的Node24.14以上、React19/Vite7及build/start/test脚本，完成可复现依赖安装。
- [x] T002 配置 `vite.config.mjs`、`index.html` 和 `src/main.jsx` 的同源API开发代理、生产入口及正确正式名称。
- [x] T003 [P] 核对 `.specify/memory/constitution.md`、`.specify/feature.json` 和 `specs/001-team-cockpit/checklists/requirements.md`，执行官方prerequisite并确认范围及模板均有效。

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有故事的真实认证、服务端权限和持久化前置条件。

- [x] T004 在 `server/index.mjs` 建立SQLite WAL、账号/实体/文件字节/审计/幂等持久化与事务边界；业务作者、ID和时间服务端生成，projectId创建后不可更改。
- [x] T005 在 `server/index.mjs` 完成唯一bootstrap、内置登录/退出、scrypt、HttpOnly/SameSite/生产Secure Cookie、会话过期与停用撤销；约束“password为10—256字符，仅存随机盐摘要”。
- [x] T006 在 `server/index.mjs` 完成每请求有效成员、工作区/项目角色、最高有效来源、CSRF/同源、字段白名单、version冲突和operationId幂等校验，401/403/404/409遵从 `server/contract.md`。
- [x] T007 [P] 在 `tests/server.test.mjs` 验证AC-01—04的唯一初始化、真登录、退出/停用、CSRF及管理角色不隐含项目权限，使用独立临时数据库。
- [x] T008 [P] 在 `src/api.js` 完成带Cookie/CSRF、写入operationId、版本及统一错误处理；401与撤权清理业务状态，失败不伪报保存成功。
- [x] T009 在 `src/ui.jsx`、`src/forms.jsx` 和 `src/App.jsx` 建立四导航、登录/首次设置、焦点可见的表单/弹层、请求中与错误状态；读取已确认样式值，不引入第二色板。

**Checkpoint**: 身份、授权、事务与API表达经过检查后才整合业务页；隔离账号夹具可直接供三个故事验收。

## Phase 3: User Story 1 - 登录后掌握项目并推进任务 (Priority: P1) MVP

**Goal**: 从登录、总览到私有项目任务风险更新形成真实持久化闭环。

**Independent Test**: 使用唯一所有者及隔离第二账号，建立项目和3项任务，完成1项、受阻/恢复另一项、保留独立风险；检查总览33%及风险，重启仍可读。

### Tests for User Story 1

- [x] T010 [P] [US1] 在 `tests/server.test.mjs` 实现AC-13—25关键HTTP用例：字段越权、同项目关联、阻塞事务与回滚、取消/删除分母、空分母、日期范围、生命周期、409与幂等。

### Implementation for User Story 1

- [x] T011 [US1] 在 `server/index.mjs` 实现私有项目及初始授权、负责人交接和日期验证；遵循“name为1—80字，goal为1—500字”“结束日不早于开始日”，客户端不得注入管理身份。
- [x] T012 [US1] 在 `server/index.mjs` 实现任务字段与本人编辑范围；遵循“title为1—120字，description为0—5000字”“负责人为空或有效协作/维护者”“只能关联本项目”；维护字段仅维护者可改。
- [x] T013 [US1] 在 `server/index.mjs` 原子维护任务受阻/恢复与关联风险；创建原因、恢复说明必需；有状态编辑权的未分配自建任务同样允许恢复，不能关闭独立或他人项目风险。
- [x] T014 [US1] 在 `server/index.mjs` 实现里程碑、进展、进度和健康派生，取消/软删除不计分母、百分比向下取整；完成项目校验全部有效任务/里程碑、风险及摘要。
- [x] T015 [US1] 在 `server/index.mjs` 实现已完成/归档只读、archivedFrom恢复、任务重开历史、软删除恢复及日期事实分离；权限撤销仍可执行。
- [x] T016 [P] [US1] 在 `src/pages.jsx` 和 `src/forms.jsx` 实现总览、项目中心/详情、任务中心、项目/任务/风险/进展表单及统一筛选，权限先于统计，显示进度基数及真实空状态。（U-13补齐总览范围、项目多选/排序、任务同字段并集与跨字段交集、完整七天清单、逾期独立提示；日历与实际浏览器通过。）
- [x] T017 [US1] 在 `src/App.jsx` 和 `src/api.js` 接通US1加载/刷新、旧版本冲突、断网重试与草稿保留；退出或失权清空敏感内容，样例仅显式导入。（REAUTH_REQUIRED保留表单及局部错误；真正撤权后清理旧内容；本人重设密码成功后明确重新登录。错误/成功/撤权三条浏览器路径均通过。）
- [x] T018 [US1] 按AC-13—26完成US1实际浏览器与HTTP验收，将命令、输入与结果写入 `../验证/验收记录.md`；失败项回到对应任务修复。（U-13补齐SQLite触发器故障注入、今天/+6/+7/逾期边界、跨时区及夏令时日历矩阵、筛选组合及最终浏览器回归；不将日历测试等同真实读屏器或生产验证。）

**Checkpoint**: US1可独立展示。不得以演示卡片、浏览器本地数据或静态构建冒充后端闭环。

## Phase 4: User Story 2 - 保管项目资料和连续版本 (Priority: P2)

**Goal**: 有权限才能读写项目资料，历史文件不可覆盖，撤权立即影响后续下载。

**Independent Test**: 使用直接授权夹具上传v1/v2、下载历史、恢复为新版本、移回收站与撤权后复用下载地址，无需US3界面。

### Tests for User Story 2

- [x] T019 [P] [US2] 在 `tests/server.test.mjs` 实现AC-27—32的历史下载、不可覆盖恢复、并发版本、资源归属、超限/非法编码、回收站和撤权复用URL用例。（U-13另补常用文件内容识别与声明不符拒绝，识别范围及未知格式边界见T030和唯一合同。）

### Implementation for User Story 2

- [x] T020 [US2] 在 `server/index.mjs` 实现逻辑资源、HTTPS链接和版本/BLOB同事务写入；遵循“默认实际大小不超过10MiB，部署可配置”“不以文件名构造路径”，失败不产生正式版本。
- [x] T021 [US2] 在 `server/index.mjs` 实现每次鉴权下载、只读历史访问、维护者恢复新增版本、协作者仅本人逻辑资料维护与回收站，服务端不暴露私有DATA_DIR。
- [x] T022 [P] [US2] 在 `src/pages.jsx`、`src/forms.jsx` 和 `src/api.js` 实现资料中心、文件/链接添加、新版本、历史下载/恢复、实际上传上限及失败状态，接入唯一合同。
- [x] T023 [US2] 在 `../验证/验收记录.md` 记录US2真实文件内容核对、撤权后重试及界面流程；用服务重启检查字节与版本仍一致。

**Checkpoint**: 文件由服务端私有持久化；能下载不等于权限通过，必须执行旧地址及历史版本负面检查。

## Phase 5: User Story 3 - 邀请团队并让权限可解释 (Priority: P3)

**Goal**: 复制邀请、加入、团队及直接授权、撤权、停用交接和审计形成闭环。

**Independent Test**: 两个空项目、三个账号、两个团队，多源角色逐次撤销；管理角色无隐含项目权限，最后管理者受保护。

### Tests for User Story 3

- [x] T024 [P] [US3] 在 `tests/server.test.mjs` 实现AC-05—12、33：单次/失效/撤销邀请、邀请人失权、直接/团队最高角色、旧会话撤权、唯一owner及最后maintainer/应急接管。

### Implementation for User Story 3

- [x] T025 [US3] 在 `server/index.mjs` 实现邀请凭据摘要、仅创建时返回复制链接、收件范围及“默认7天、单次接受、接受时重检邀请人权限”；不自动发送邮件，不声称验证邮箱所有权。
- [x] T026 [US3] 在 `server/index.mjs` 实现团队、成员状态与项目授权，遵循团队“name为1—80字”“只允许有效成员”；多源最高角色、最后维护者、负责人交接与唯一owner转移校验。
- [x] T027 [US3] 在 `server/index.mjs` 实现停用立即撤会话、启用仅恢复尚存授权、待交接项、再次认证接管、个人改密/管理重置和管理/业务审计隔离。
- [x] T028 [P] [US3] 在 `src/settings.jsx`、`src/forms.jsx` 和 `src/App.jsx` 实现成员/团队/邀请加入、来源清单、角色调整、撤权/停用与交接、启用效果说明、接管及审计页面。（U-13补齐既有owner重设密码再次认证、邀请项目范围、停用者未完成任务入口、团队/负责人/敏感授权影响提示、审计前后值；密码与邀请浏览器路径通过。）
- [x] T029 [US3] 在 `../验证/验收记录.md` 记录两个独立浏览器会话的邀请加入、多源撤权、停用后旧页面及历史下载拒绝，确认手机仍可关键撤权。

**Checkpoint**: 管理入口的可见性与真实权限一致；未接邮件只显示“复制邀请”，无邀请已送达假提示。

## Phase 6: Polish and Cross-Cutting Concerns

- [x] T030 对照 `../验证/验收计划.md` 在 `server/index.mjs`、`src/pages.jsx` 与 `src/settings.jsx` 补齐跨故事实质缺口；接口变化同步 `server/contract.md`。（任务/里程碑完成事实和完整对象历史、审计前后值、评论编辑软删除、用户IANA时区迁移/API/设置、常用文件内容识别已实现并测试。对象历史按项目读取权限，管理审计仍按管理权限；未知二进制标为未识别，内容识别不承诺文件完整性或恶意内容检测。）
- [ ] T031 在 `src/styles.css`、`src/ui.jsx` 和 `src/App.jsx` 按确认VI修正1440/768/390px及200%缩放、触摸目标、键盘弹层焦点、读屏提示及减少动态效果。（真实浏览器tabs.setZoom=2、手机、键盘焦点和可访问性树alert已实测；尚未用真实读屏器朗读，保留未关闭。）
- [x] T032 [P] 在 `Dockerfile`、`compose.yaml`、`部署说明.md` 提供单实例HTTPS反代、PUBLIC_ORIGIN、SECURE_COOKIE、私有持久卷、实际限制和首次owner安全初始化；说明无固定默认口令。
- [x] T033 在 `部署说明.md` 和 `../验证/验收记录.md` 提供并演练一致备份/独立恢复，核对账号、角色、项目、文件字节/版本，补充唯一owner忘密的受控运维恢复边界。（实测为运行中VACUUM INTO一致快照及独立恢复；停服完整卷恢复保留操作说明。）
- [x] T034 运行 `npm test`、`npm run build` 及 `specs/001-team-cockpit/quickstart.md`，将实际命令输出、未覆盖项和重启结果记入 `../验证/验收记录.md`。
- [x] T035 在真实浏览器执行AC-35—37的核心布局/键盘操作与三故事，核对概念图并保存 `../验证/截图/02-桌面总览.png`、`../验证/截图/07-手机总览.png`，修复布局/交互问题后记录结果。（U-13补真实200%缩放，截图19—21；真实读屏器仍列T031，不将本项视为全量可访问性认证。）
- [x] T036 同步 `../需求/PRD.md`、`../开始阅读.md`、`../资料/来源索引.md` 和本 `tasks.md` 的阶段、工具实跑、云端/邮件边界及未完成项；只清理本轮已核验无用临时产物。（本项指本机交付与当前状态同步；新标识/登录布局的VI、概念图和手册PDF仍待设计验收后统一更新，不包含在此完成结论中。）

## Dependencies & Execution Order

### Phase Dependencies

Setup→Foundational→三个故事→跨故事验证与运行交付。US1先形成可展示核心；US2、US3有公共权限夹具时可分别开发。实际后端集中于同一server/index.mjs，必须由单一负责人合并，不能把同文件任务当成可并行写入。

### User Story Dependencies

- US1依赖T004—009，与US2/US3业务页无依赖。
- US2依赖公共project权限与持久化，可用直接授权夹具独立验收；不依赖邀请UI。
- US3依赖公共认证/权限，可用空项目独立验收；不依赖任务或文件业务界面。
- T030—036在所需故事整合后执行；云端配置可先准备，但真实云端发布未授权或缺连接条件时不能误标通过。

### Within Each User Story

按行为先定义验收与测试，校验模型/权限，再接端点与界面，最后按真实环境跑故事。测试与代码按实际进度回写，不为满足顺序表述伪造先前运行记录。

### Parallel Opportunities

T003与工程配置、T007/T008在不同文件可并行；服务负责人推进T011—015时，前端可按合同推进T016；US2可并行服务T020—021与前端T022；US3可并行服务T025—027与管理UI T028。测试文件由测试负责人统一整合。

## Parallel Example: User Story 1

- 后端：`server/index.mjs` 项目/任务/风险事务。
- 前端：`src/pages.jsx`、`src/forms.jsx` 按同一合同构建页面和错误状态。
- 验证：`tests/server.test.mjs` 根据AC样例准备真实HTTP检查。

## Implementation Strategy

先完成公共权限骨架，以US1作为MVP验证真实持久化；随后独立验US2文件和US3协作管理，最终做权限负面、恢复、视觉与移动验收。完成本机交付后提供云端配置；真实云端部署、性能和候选功能各自保留状态。

## Notes

最新指示U-13：先补齐本机问题和功能缺口、完成测试，再交设计验收；暂不部署。U-08的Sites目标保留，未创建或发布站点。Node/SQLite本机结果不能作为Sites运行时及存储适配完成的证明。

2026-10-23本机补齐后：36项任务中35项勾选，T031真实读屏器实测保留未关闭。盘点时的30/36为历史状态，T016、T017、T018、T028、T030现已按实现与测试证据关闭。详见[验收记录](../../../验证/验收记录.md)。用户设计验收仍未完成，VI/PDF及概念图同步待本轮设计确认后执行。

共36项任务：Setup 3、Foundational 6、US1 9、US2 5、US3 6、收尾7。勾选数不是产品或上线完成百分比；Sites适配、目标环境端到端验证、生产容量与运行保障尚未纳入这个本机切片。Docker镜像/证书属于备用自托管方案。任务状态根据证据更新；不创建Git仓库，不自动提交，不把本地通过写成公网部署完成。
