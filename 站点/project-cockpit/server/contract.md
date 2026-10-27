# Sites服务合同引用

本项目唯一完整业务接口合同位于 [开发/server/contract.md](../../../开发/server/contract.md)。云端实现继承该文件的路径、字段、业务校验、角色、版本冲突及当前权限重查，不在站点副本中维护另一套完整API。

云端差异统一见主合同的“Sites云端运行差异”：受 `BOOTSTRAP_TOKEN` / `X-Bootstrap-Token` 保护的一次性首owner建立、HTTPS安全会话、D1 revision CAS、私有R2版本与失败清理，以及关闭演示导入。该节是差异的现行依据，本文件只保留引用。

规格与验收来源：[002部署规格](../../../开发/specs/002-sites-deployment/spec.md)、[部署验收计划](../../../开发/specs/002-sites-deployment/acceptance.md)。云端从独立空工作区开始，不上传本机账号、会话、业务库或4174设计演示；发布状态和实测结果由项目根目录的 `验证/验收记录.md` 维护。

