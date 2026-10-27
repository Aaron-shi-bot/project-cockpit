# Implementation Plan: 项目驾驶舱团队协作核心

**Branch**: `001-team-cockpit`（功能标识，未创建 Git 分支） | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)

**Input**: `specs/001-team-cockpit/spec.md`；官方 Specify CLI 1.2.2 的 plan 技能与 setup-plan.ps1。

## Summary

在现有已确认 VI 和平台手册基础上实现三条可独立验收的故事：登录后查看/推进项目任务风险，
私有资料连续版本，以及邀请、团队和多源权限。业务范围为 REQ-001—013；014—019仍为候选。
当前本机采用单进程服务与单库持久化，从第一天执行服务端授权。U-08已将发布目标改为Sites；下面Node/SQLite方案描述已实现的本机基线，不能解释为Sites目标架构已经完成。
唯一接口合同为 [server/contract.md](../../server/contract.md)，本目录不复制第二套接口。

## Technical Context

**Language/Version**: JavaScript ESM；Node.js 24.14及以上；浏览器 ES2022。

**Primary Dependencies**: React 19.2、React DOM 19.2、Vite 7.3；服务端使用 Node 内置 http、sqlite、crypto、fs。版本锁定以 package-lock.json 为准。

**Storage**: SQLite WAL；账号、会话、邀请、业务实体、审计、操作幂等和文件字节均保存在私有 DATA_DIR/cockpit.sqlite。当前文件版本为数据库 BLOB，不虚构已接对象存储。

**Testing**: node:test 与真实本机 HTTP 请求；隔离临时数据库；浏览器验证在项目验证目录留证，构建与浏览器分开报告。

**Target Platform**: 开发和当前验证为Windows本机；用户指定的发布目标为Codex Sites，须在设计验收后适配Workers/D1/R2并重验。Linux单实例、HTTPS反代的Docker配置保留为备用自托管方案。

**Project Type**: 全栈团队 Web 应用；一个工程根目录 `开发/`。

**Performance Goals**: 首轮以可用性、隔离和一致性为硬门槛；100项目/5000任务只是建议初始样本，不承诺并发量或响应时间。真实容量需要后续采样。

本轮已对100项目/5000任务做同协议本机单次采样：`/api/state`聚合优化前2944.16ms，优化后105.78ms，响应均2,442,973字节且角色/统计一致。聚合仅复用本次请求的数据，不引入跨请求缓存。此为本机回环样本，仍非生产并发承诺；数据仍全量返回，任务/资料采用客户端分页。证据见[本机容量检查](../../../验证/本机容量检查.json)。

**Constraints**: 私有存储、HttpOnly会话、CSRF与同源校验、scrypt口令摘要、角色双层校验、事务与乐观锁、无自动永久清理。默认单文件10MiB可配置；JSON/base64上传适合首个小团队实例，非大文件分块方案。

**Scale/Scope**: 单工作区、多成员/团队/项目；总览、项目、任务、资料、设置与登录/邀请。当前本机为单应用实例，不承诺横向扩容。Sites访问配置、容量和备份目的地在后续适配切片确定，不再以提供自有云主机作为前置要求。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | 研究前检查 | 设计后检查 |
|---|---|---|
| I 单一PRD | 规格仅引用 REQ-001—013；候选另列 | 接口链接现有唯一合同，不复制需求；通过 |
| II 服务端授权 | 权限骨架先于三条故事 | state聚合、下载与写操作每次检查；多源与所有者保护纳入测试；通过 |
| III 真实持久化 | SQLite和文件字节一并持久化 | 状态/风险事务、version、operationId、软删除、备份恢复列任务；通过 |
| IV 视觉忠实 | 复用确认VI及design-tokens | React页面及桌面/手机对照验证列任务；通过 |
| V 负面验证 | AC用例和服务测试是必需交付 | 接口、构建、浏览器、云端结果分别记录；通过 |

这里的“通过”指计划与原则一致，**不表示实现或测试已通过**。无原则例外。当前按用户要求先验收设计；Sites适配与真实部署保持未完成。

## Project Structure

### Documentation (this feature)

```text
specs/001-team-cockpit/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

接口合同采用原位链接 `server/contract.md`，因此不另建 contracts 副本。完整验收用例在项目根 `验证/验收计划.md`。

### Source Code (engineering root)

```text
开发/
├── package.json
├── package-lock.json
├── vite.config.mjs
├── index.html
├── server/
│   ├── contract.md
│   └── index.mjs
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── api.js
│   ├── ui.jsx
│   ├── forms.jsx
│   ├── pages.jsx
│   ├── settings.jsx
│   └── styles.css
├── tests/server.test.mjs
├── data/                 # 私有运行数据，不作为静态资源
├── dist/                 # Vite构建输出
├── Dockerfile            # 云端配置任务输出
├── compose.yaml          # 云端配置任务输出
└── 部署说明.md           # 运行、初始化及备份恢复入口
```

**Structure Decision**: 在既有 `开发/` 保留官方Spec Kit原生目录、单个Node服务和React源码。
服务集中于 `server/index.mjs` 以便事务共享；前端按公共UI、业务页、表单和管理页拆分。
同一服务文件的任务串行整合；服务端、前端、验证及部署文档可按文件责任并行。

## Phase 0: Research

[research.md](research.md)记录技术选择、替代方案、已知边界及四项交叉规则的明确选择。
依据已存在的接口合同和实现骨架决定技术方案，未做外部产品选型或把运行时内置能力当作外部服务。
实施前没有影响该切片的未决核心业务规则；存储上限和保留周期采用可逆配置且不自动清理。

## Phase 1: Design and Contracts

[data-model.md](data-model.md)明确实体、字段、角色、状态与一致性约束。
[server/contract.md](../../server/contract.md)提供真实API入口、响应及错误格式；合同改动必须同步前后端。
[quickstart.md](quickstart.md)提供本机运行与三条故事验证，验收记录另保留实测证据。
需求质量清单仅审查规格质量，不修改实施完成状态。

## Complexity Tracking

无原则例外。SQLite单实例及JSON实体载荷是首个版本的简化选择；需要大文件、复杂查询、
多实例部署或高并发时再通过范围与数据迁移计划评估关系表/对象存储/PostgreSQL，
不提前增加多个基础设施服务。杀毒、SSO和邮件送达没有接入，不能声称已经具备。
