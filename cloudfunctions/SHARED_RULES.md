# 规则代码的共享与同步说明

`rules.js`（核心规则引擎）只有一份源头：

- **源头**：`miniprogram/utils/rules.js`（小程序端与本地测试都用它）

各运行环境部署时目录独立打包，不能 require 小程序端的相对路径，因此放了**三份逐字副本**：

- `cloudfunctions/api/rules.js` —— 微信云开发版（**已弃用**，随旧实现保留）
- `cloudfunctions/settle/rules.js` —— 微信云开发版（**已弃用**，随旧实现保留）
- `uniCloud/cloudfunctions/api/rules.js` —— uniCloud 版（**现行**，api 函数内业务与结算共用这一份）

## 同步规矩

1. 改规则（数值或判定）只改源头 `miniprogram/utils/rules.js`，然后把源头文件整文件复制覆盖三份副本，不要在副本里单独改任何一行。
2. `tests/cloud.test.js` 与 `tests/unicloud.test.js` 里都有「副本逐字一致」用例：源头与三份副本字节级比对，`node --test` 不过就是有人改岔了，先修同步再谈上线。
3. 结算口径以 `rules.settleGame` 为唯一实现：任何后端的 api 都不产鸽、settle 都不另写判定，两边都只是调用它。
