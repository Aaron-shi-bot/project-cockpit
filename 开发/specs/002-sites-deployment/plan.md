# Implementation Plan: 项目驾驶舱 Sites公开部署

**Branch**: `002-sites-deployment`（功能标识，无新建Git仓库） | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)

**Input**: [002部署规格](spec.md)、[PRD U-14 / REQ-020](../../../需求/PRD.md)。沿用001全部业务规则和既有视觉，本轮只适配运行、持久化及首次初始化。

## Summary

将本机已实现的业务迁入独立的官方Vinext Sites starter，保留原React页面与交互，提取服务业务核，改用D1逐行实体和私有R2文件。公开入口保持内置账号邀请；空工作区以高熵一次性secret保护首owner。D1请求内一致快照、revision CAS和差异batch负责完整提交，不能依赖单Worker进程锁。先验证本机基准、云适配测试和真实本地Worker，再由已授权的站点所有者发布并核对实际HTTPS业务路径。

## Technical Context

**Language/Version**: 构建Node 24；TypeScript/JavaScript ESM；React 19.2.6。以站点 `package-lock.json` 为安装版本依据，不为迁移升级本机工程。

**Primary Dependencies**: 官方Sites 1.1.1 Vinext starter，Vinext 1.0.0-beta.5、Vite 8.0.13、Wrangler 4.92.0、Drizzle ORM 0.45.2；保留starter的Sites构建集成及平台保留路由。

**Storage**: D1 `DB`逐行结构化记录、全局revision及清理队列；私有R2 `BUCKET`保存不可变文件字节。浏览器只临时持有初始化secret；无跨请求内存授权或业务缓存。

**Testing**: 既有 `开发/tests/server.test.mjs` 与日历测试是本机基准；`server/tests/cloud.test.mjs`验证移植规则；`tests/cloud-independent.test.mjs`独立检查CAS/失败窗口；真实本地built Worker与生产HTTPS另按[acceptance.md](acceptance.md)执行。模拟D1/R2不能替代实际Worker。

**Target Platform**: Codex Sites托管Cloudflare Workers+D1+R2，公开HTTPS网址；本地portable预览保持loopback且避开4173/4174。

**Project Type**: 多人业务Web应用，单工作区，前后端同源。

**Performance Goals**: 本轮首先验证小样本完整业务路径和并发正确性，记录实际耗时、体积及错误；不将旧Node容量样本或一次本地请求外推为线上人数、吞吐、延迟或SLA承诺。

**Constraints**: Worker内存/CPU与D1事务模型、HTTP接口及私有R2限制需实测。保留默认10MiB文件上限、Cookie HttpOnly/HTTPS Secure/SameSite、CSRF与失败限流。密码计算在实际Worker验证；不能因兼容性静默降低安全口径。迁移schema-only，secret经运行时配置且不进入归档。

**Scale/Scope**: 实现REQ-020并回归REQ-001—013；REQ-014—019不进入本轮。保留视觉和主导航，不增加公开注册、邮件、匿名分享、多租户或定时通知。

## Constitution Check

研究前与设计后均核对以下五条。本表通过表示方案一致，**不是实现或云端测试通过**。

| 原则 | 研究前 / 设计后 | 本切片依据 |
|---|---|---|
| I 单一PRD | 通过 / 通过 | U-14、REQ-020在现行PRD原位更新；001业务及唯一 `开发/server/contract.md`继续适用；contracts只记录继承与初始化差异 |
| II 服务端授权 | 通过 / 通过 | 每次请求加载当前会话、成员、授权；平台身份不隐含业务角色；幂等响应重放前重验；R2仅API鉴权下载 |
| III 持久事务 | 通过 / 通过 | D1逐行保存，revision CAS+batch覆盖差异/审计/幂等；私有R2不可变，跨存储失败有清理与负面测试；不声称跨服务事务 |
| IV 视觉忠实 | 通过 / 通过 | 复制现有页面到cockpit，保留已确认亮色基准；只补初始化凭据交付所需状态；发布不等于设计确认 |
| V 负面证据 | 通过 / 通过 | DEP-AC-01—17分层验证，特别是首owner竞争、撤权、文件两版、CAS、冷启动；未测项保留 |

用户U-14允许公开发布，取代旧暂停指示；这不改变原则的“按真实条件验收”，也不需要重写原则或再初始化Spec Kit。

## Project Structure

### Documentation (this feature)

```text
开发/specs/002-sites-deployment/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── acceptance.md
├── contracts/README.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (project root)

```text
站点/project-cockpit/
├── .openai/hosting.json             # 非秘密站点ID与DB/BUCKET绑定
├── app/page.tsx                    # 现有驾驶舱入口
├── app/api/[[...path]]/route.ts     # 委托handleApi
├── cockpit/                       # 复用已有React页面/样式/API客户端
├── db/schema.ts
├── drizzle/                       # 静态schema-only SQL及元数据
├── server/
│   ├── kernel.mjs                  # 移植旧合同的业务核
│   ├── memory-store.mjs            # 请求内Map仓库，限定既有谓词
│   ├── d1-store.mjs                # primary快照、revision CAS与差异batch
│   ├── worker-api.mjs              # Request/Response、secret、私有R2与失败清理
│   ├── file-types.mjs
│   └── tests/cloud.test.mjs
├── tests/cloud-independent.test.mjs
└── worker/index.ts                 # 保留官方starter入口与Sites集成
```

**Structure Decision**: 保留本机 `开发/` 作为行为基准与现有运行入口，云端适配集中在用户同一项目内的 `站点/project-cockpit`。只复制必需源码和公共视觉资产，不复制本机data、验证库、账号、上传和运行时目录。站点源码同步所需Git由官方helper管理，不在本机工程另建仓库。

## Phase 0: Research

[research.md](research.md)已记录运行适配、身份、D1提交、R2失败与发布策略。没有需用户重新决定的业务问题；未发生的技术结果作为实施验证门槛，不写成已证实。依赖安装、站点注册、secret与公开访问配置由主任务统筹，不并行启动重复安装或重复站点创建。

## Phase 1: Design and contracts

- [data-model.md](data-model.md)只补部署持久化与提交关系；不改变001业务实体。
- [contracts/README.md](contracts/README.md)指向唯一业务合同；实施者回写受保护setup的云端差异，不复制完整API。
- `BOOTSTRAP_TOKEN`至少32随机字节，经运行时secret配置；fragment进入前端内存后立即清理地址，只向同源setup的 `X-Bootstrap-Token` 提交，建立成功后作废。未配置fail closed。
- 每个请求通过primary batch读取一致实体与revision；条件提交需使全部差异受同一个revision约束。CAS失败必须回滚整批，防止“revision失败但业务行成功”。请求内Map不是长期数据库。
- R2对象不可变且私有，业务提交前不发布版本。失败残留进入可重试清理；只能删无已提交引用对象。读取和下载每次重验权限。
- 平台发布前执行静态schema迁移生成与审阅，禁止请求内DDL；本地已应用迁移及线上已应用迁移分别跟踪。部署失败后先确认迁移实际状态。
- [quickstart.md](quickstart.md)提供验证入口，[acceptance.md](acceptance.md)定义本地/线上证据要求。定时备份及完整恢复若未实现或未测须明确，不阻塞文档把状态写实。

## Phase 2: Implementation and release gates

实施及状态以[tasks.md](tasks.md)为准。US1先验证空库保护，US2验证全部业务合同与撤权，US3验证私有文件与持久化；对外发布须已满足适用P0本地门槛。平台返回部署成功后仍需执行适用生产验收。不得用“全部任务勾选”覆盖未做的冷启动、恢复或用户视觉确认。

## Tool execution

复用项目已安装Specify CLI 1.2.2的官方Codex skills及PowerShell模板。实际执行 `create-new-feature.ps1 -Json -Number 2 -ShortName sites-deployment`、`resolve-template.ps1 spec-template -Json` 和 `setup-plan.ps1 -Json`，输出均定位本目录；后续 `setup-tasks.ps1 -Json`、`check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks`用于任务模板与路径核验。`.specify/extensions.yml`不存在，无扩展hook可执行；未创建Git仓库或分支。本段只说明工具使用，不是部署验收。

