# Tasks: 项目驾驶舱 Sites公开部署

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts](contracts/README.md)。
**Tests**: 本切片明确要求关键负面测试及本地Worker/生产分层验收；Node模拟结果不得替代后两层。
**Organization**: 先基础，再按三条用户故事组织；路径相对整个项目根目录。现有001业务/API与视觉沿用，不纳入014—019候选。

任务只按已有证据更新。实现项勾选表示对应代码及其适配层验证完成，不替代单独列出的本地浏览器、生产及恢复验收。文档质量checklist的勾选不代表实施完成。公开发布已经U-14授权，无须再把旧暂停指示当当前限制；发布不等于用户已逐页确认设计。

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 核对并复用官方Vinext starter和唯一站点ID，在 `站点/project-cockpit/.openai/hosting.json` 声明DB/BUCKET，保留Sites集成及平台保留路由；依赖只装一次。
- [x] T002 [P] 将既有界面/静态资产复用到 `站点/project-cockpit/cockpit/` 与 `站点/project-cockpit/app/page.tsx`，排除本机data、验证库、会话、固定演示账号及4174自动会话。

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 在 `站点/project-cockpit/db/schema.ts` 定义逐行业务表、revision、安全记录、私有文件引用及清理队列，在 `站点/project-cockpit/drizzle/` 生成并审阅schema-only迁移；不带seed，不改已应用迁移。
- [x] T004 在 `站点/project-cockpit/server/memory-store.mjs` 限定旧业务所需谓词与请求内Map操作，未知查询明确拒绝；不得动态DDL或用跨请求Map冒充持久库。
- [x] T005 在 `站点/project-cockpit/server/d1-store.mjs` 通过primary batch读取一致快照与revision；使用revision CAS保护整批差异、审计及幂等写入，CAS失败不得有部分业务成功。
- [x] T006 在 `站点/project-cockpit/server/kernel.mjs` 提取旧合同业务核，移除Node HTTP/fs/sqlite依赖，保留字段白名单、校验、事务规则及当前权限重查。
- [x] T007 在 `站点/project-cockpit/server/worker-api.mjs` 与 `站点/project-cockpit/app/api/[[...path]]/route.ts` 接入同源Request/Response、D1/R2和安全错误处理；禁止凭据进日志和响应。

**Checkpoint**: 基础数据与路由可独立测试；未完成持久层并发保护不能公开给真实团队使用。

## Phase 3: User Story 1 - 安全打开公开驾驶舱 (Priority: P1)

**Goal**: 有效持有者能建立唯一首owner，陌生人不能抢先初始化；已建立后使用原内置账号。
**Independent Test**: DEP-AC-01—05、16；隔离空库无/错误/并发有效初始化及会话撤销，生产建立一次后关闭。

- [x] T008 [US1] 在 `站点/project-cockpit/server/worker-api.mjs` 及 `站点/project-cockpit/server/kernel.mjs` 验证 `BOOTSTRAP_TOKEN`，未配置fail closed；初始化消费与唯一owner建立在同一CAS提交，只可成功一次。
- [x] T009 [P] [US1] 在 `站点/project-cockpit/cockpit/App.jsx` 从URL fragment临时读取初始化凭据并立即清除片段，仅向同源setup发送 `X-Bootstrap-Token`；不持久存储或复制至普通请求。
- [x] T010 [US1] 在 `站点/project-cockpit/.openai/hosting.json` 及官方Sites运行时secret配置中核对部署边界：secret至少32随机字节且不进manifest、源码、静态包或CLI参数；文档只记录名称与已交付状态。
- [x] T011 [US1] 在 `站点/project-cockpit/server/worker-api.mjs` 保留HttpOnly/Secure/SameSite会话、CSRF/Origin与持久失败限流；个人改密保留当前会话、撤销其他会话，管理重设撤销该用户全部会话，停用/退出沿用撤销规则；实测Worker密码派生兼容性，不静默弱化。
- [x] T012 [US1] 在 `站点/project-cockpit/server/tests/cloud.test.mjs` 验证缺secret、错误secret、并发setup、重复setup、登录/退出/改密、CSRF及匿名业务拒绝，覆盖DEP-AC-01—05。
- [x] T013 [P] [US1] 在 `站点/project-cockpit/tests/cloud-independent.test.mjs` 独立复核首owner消费与会话边界，直接断言持久结果；云端差异统一回写唯一 `开发/server/contract.md`，`站点/project-cockpit/server/contract.md` 只保留引用及差异索引，移除完整合同副本。

## Phase 4: User Story 2 - 团队从外网按既有权限协作 (Priority: P1)

**Goal**: 迁移后邀请、业务权限和已有操作结果与001一致，公开网址不公开项目。
**Independent Test**: DEP-AC-06—08、11—12；O/M/V/A与T1/T2交叉权限及旧请求重放。

- [x] T014 [US2] 在 `站点/project-cockpit/server/kernel.mjs` 保持邀请一次接受/失效重验、工作区与项目角色、多源撤权、唯一owner/最后维护者及应急接管规则。
- [x] T015 [US2] 在 `站点/project-cockpit/server/kernel.mjs` 保持任务风险原子变化、项目完成/归档只读、软删除恢复、对象完整历史、审计前后值、字段长度/白名单与日期时区口径。
- [x] T016 [P] [US2] 在 `站点/project-cockpit/cockpit/api.js` 与 `站点/project-cockpit/cockpit/App.jsx` 对接原JSON/错误合同，保留409/再认证失败草稿和成功自重设后的重新登录提示，不依赖Vite本地代理。
- [x] T017 [US2] 在 `站点/project-cockpit/server/tests/cloud.test.mjs` 回归邀请、停用、多源撤权、无项目权管理员、幂等缓存撤权、业务归档与历史下载边界；不得以旧Node测试计数称云端通过。
- [x] T018 [US2] 按 `开发/specs/002-sites-deployment/acceptance.md` 在真实本地built Worker运行邀请/撤权/业务路径与直接HTTP负面请求，浏览器结果统一回写 `验证/验收记录.md`。

## Phase 5: User Story 3 - 工作和文件在云端长期保留 (Priority: P1)

**Goal**: 私有文件保留历史且跨实例/重启完整，竞争与失败不留下半份业务结果。
**Independent Test**: DEP-AC-09—14、17；v1/v2摘要、恢复v3、并发CAS、失败注入及持久化。

- [x] T019 [US3] 在 `站点/project-cockpit/server/worker-api.mjs` 与 `站点/project-cockpit/server/file-types.mjs` 实现私有R2不可变对象、当前鉴权下载、两版及恢复新增版；保持真实10MiB限制、严格base64及既有类型识别，文件名不构成key。
- [x] T020 [US3] 在 `站点/project-cockpit/server/d1-store.mjs` 实现R2写入与D1失败的孤立对象清理/重试，清理只处理无已提交引用对象；禁止出现成功版本却缺字节。
- [x] T021 [US3] 在 `站点/project-cockpit/server/tests/cloud.test.mjs` 验证上传/恢复版本、摘要、超限/非法编码/类型、并发文件版本与撤权后下载拒绝。
- [x] T022 [P] [US3] 在 `站点/project-cockpit/tests/cloud-independent.test.mjs` 真实事务模拟D1批处理并注入CAS/R2/提交失败，验证同/不同对象竞争、原子审计、幂等与清理不删有效文件。
- [x] T023 [US3] 按 `开发/specs/002-sites-deployment/acceptance.md` 在真实本地Worker停启后核对记录/权限/版本摘要；评估D1+R2完整恢复是否实际执行，未执行在 `验证/验收记录.md` 明确保留缺口。

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T024 按官方Sites构建流程构建 `站点/project-cockpit/`，检查生成Worker、静态资源、DB/BUCKET及schema-only迁移；实际应用本地未执行迁移并保持记录，不重放已执行SQL。Windows helper的npm shim启动失败时，记录用系统绝对npm-cli执行同一build的实际结果，不声称helper本身成功。
- [x] T025 [P] 审查 `站点/project-cockpit/` 的源码归档与客户端产物，确认不含本机库、账号、secret、会话、4174预览自动登录及运行时缓存；完成桌面/手机视觉与错误状态回归并写入 `验证/验收记录.md`。
- [x] T026 复用 `站点/project-cockpit/.openai/hosting.json` 已持久化站点ID，经官方源码helper和native Sites工具保存版本、公开部署，记录实际终态URL/版本/访问配置至 `验证/验收记录.md`；不重复创建未知结果的站点。
- [ ] T027 在实际生产HTTPS执行 `开发/specs/002-sites-deployment/acceptance.md` 全部适用P用例，私下交付初始化凭据，验证邀请/撤权/两版/并发/同代码再发布持久化；不能强制证实物理冷启动时明确未证实。当前生产匿名HTTP与浏览器保护已过，用户首owner及登录后业务/跨发布持久化尚未验证，本项保持部分未完成。
- [x] T028 更新 `验证/验收记录.md`、`开始阅读.md` 与本 `开发/specs/002-sites-deployment/tasks.md` 的真实完成状态，区分本地基准、云模拟、本地Worker、平台上线、生产业务、未测恢复/容量和待用户视觉确认，不以完成比例冒充整体上线质量。

## Dependencies & Execution Order

- T001后开始T003—007，T002可并行复用前端；T003—007建立所有故事的持久层和路由前提。
- US1先完成安全初始化本地验收；US2/US3可在隔离fixture上独立开发，但不能绕过US1直接开放空库。
- T004/T005/T006存在接口依赖，先对齐再并行细化；同一文件任务按负责agent顺序完成，不能因标注不同故事同时覆盖。
- T019—020依赖D1/R2基础；T021/T022独立测试文件可并行，均不能以各自通过证明实际Worker已测。
- T024、T025通过后才执行T026；T027依赖实际发布终态，T028只依据已取得证据回写。

## Parallel Examples

- US1：后端实现T008/T011，前端在独立 `cockpit/App.jsx` 做T009；测试agent在独立测试文件复核T013，避免编辑后端拥有文件。
- US2：业务核T014/T015与API客户端T016由不同agent处理，合同测试T017在规则落盘后执行。
- US3：后端实现T019/T020，独立测试agent编写T022，浏览器agent准备文件上传和历史下载场景；真实运行和发布由主任务统一操作。

## Implementation Strategy

US1是可验证的最小安全入口，先用隔离库证明陌生访客不能抢占所有者。US2把现有团队路径完整接入，US3证明文件与竞争持久化；三条均为公开可用门槛，不能只发布US1登录页就称完整平台上线。保留本机工程与原验证库，云端从空工作区开始。任何失败回到对应任务修复，不扩大候选功能或重做设计。

## Notes

共28项，US1 6项、US2 5项、US3 5项，设置与基础7项、收口5项。当前27项已有实现、验证、发布或文档同步证据，T027生产登录后业务仍部分未验。此计数只表示该切片任务，不能解释为所有线上业务或用户设计验收已通过。

本轮勾选依据：

- 实现静态复核覆盖 `server/{kernel,memory-store,d1-store,worker-api,file-types}.mjs`、路由、schema及前端移植；完整API副本已改为引用唯一主合同。
- 实际运行 `node --test server/tests/cloud.test.mjs tests/cloud-independent.test.mjs`，42/42通过；这是有真实SQLite事务的D1/R2适配验证，不是生产验证。
- `站点/project-cockpit/server/tests/workerd-results.json` 记录真实隔离workerd HTTP的96项检查，含密码派生、私有文件两版/恢复、生命周期/权限、实际D1并发与10MiB边界；没有连接公开站点。`workerd-restart-results.json` 另有31项真实停启检查，同一持久目录中的账号/时区/会话、业务版本、授权和v1/v2摘要保持；明确不是备份恢复。
- `drizzle/0000_bent_sharon_carter.sql` 已核对11张表、索引、NOT NULL revision及schema-only内容，无seed。主任务已完成真实Worker构建和本地迁移；官方helper因Windows npm shim路径启动失败，后用系统绝对npm-cli运行同一 `npm run build` 成功。此例外保留，不改写成helper成功。
- 初始化前端读取后立即清fragment，仅内存及setup header使用。第三轮本地浏览器41项业务/UI通过，包括任务风险/历史/409草稿、R2两版恢复v3、邀请角色、伪造写入、撤权停用及owner再认证/重设后登录。第42项console分类失败原报告保留：旧脚本没有保存404路径，无法严格归因；追加静态只读15/15通过，9项JS/CSS/图像成功、静态404=0/pageerror=0，主任务另行查看三张界面图。T018/T025依据业务与补充证据完成，不把旧失败报告改称全通过，也不等于用户设计确认。
- 原生Sites已配置随机32字节256bit初始化secret与正式origin，manifest只含站点ID/DB/BUCKET。`验证/部署/发布包审查.json` 确认139个tracked、67个归档文件，真实BOOTSTRAP_TOKEN与源码仓库凭据比对未泄露，运行文件排除且构建vars为空；T010完成。系统Node24.14执行官方source helper时fs.cpSync崩溃（-1073740791），改用Codex附带Node24.19运行同一官方helper封装成功，没有为此改业务代码。
- T026发布证据为 `验证/部署/Sites发布结果.json`：v1终态succeeded，2026-10-23T10:05:45Z，commit `22f91fc0ecd14146e6c0e4b750c2970d95762a83`，公开入口 [项目驾驶舱](https://project-cockpit-hub.yonti9474.chatgpt.site)。原生DB11表已确认；未以测试owner抢先占位，初始化私密链接不进入文档。
- `验证/部署/生产匿名HTTP检查.json` 及 `验证/Sites生产匿名浏览器检查.json` 已验证公开HTTPS、空库初始化保护和匿名访问拒绝，生产匿名浏览器15/15通过。T027仍未完成：等待用户首owner建立，线上登录后邀请/撤权/文件/竞争与同代码再发布持久化尚未实测，物理冷启动不作承诺。
- T023按本地真实停启及恢复边界评估完成；云端D1+R2完整备份恢复、定时备份及无人访问时自动清理均未宣称完成。主任务已实际同步 `开始阅读.md`、`开发/部署说明.md` 和 `验证/验收记录.md`，T028完成；生产最终匿名浏览器证据时间2026-10-23T10:09:15Z，两个视口、11项资源，无写请求或页面异常。本轮4180/4181临时端口已停止，原4173/4174保留。

