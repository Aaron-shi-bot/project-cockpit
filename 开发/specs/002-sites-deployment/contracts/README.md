# 002 接口继承与部署差异

唯一业务合同继续是 [开发/server/contract.md](../../../server/contract.md)。云端适配必须保持其路径、字段白名单、角色、错误码、对象version和下载规则，不能在本目录复制一套独立业务API。

本切片新增的初始化安全条件：公开环境 `POST /api/setup` 额外要求 `X-Bootstrap-Token`，来自运行时 `BOOTSTRAP_TOKEN` 的高熵一次性凭据；请求体仍沿用原合同。无配置、缺失、错误或已建立均不能建立/重置所有者。凭据不通过查询参数、响应、日志或静态包公布；前端仅从交付的URL fragment临时读取，立即移除fragment，只向同源setup请求提交。确切错误文本可沿用统一错误结构，不泄露secret。

这项差异已回写到现行 `开发/server/contract.md` 的“Sites云端运行差异”。站点 `server/contract.md` 已改为指向该主合同的引用，本文仅负责指出继承关系和002要求，避免第二套完整合同。云端不带入4174预览wrapper、`designPreview`自动会话或固定演示账号。平台保留的身份路由与业务内置账号分别处理，不自行覆盖平台保留路由。

