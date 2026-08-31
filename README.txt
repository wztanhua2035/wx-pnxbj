坡南寻宝记 v5.33.0 微信登录服务端参考实现

用途
====
小游戏客户端只调用 wx.login() 获取一次性 code；真正的 openid 兑换必须在服务器完成。
绝对不要把微信 AppSecret 写进小游戏 src/config.js 或任何会上传到微信的文件。

接口
====
POST /api/auth/wechat-login
请求：{ "code": "wx.login返回的code", "deviceId": "...", "appVersion": "..." }
返回：{ "ok": true, "userId": "pn_xxx", "token": "...", "expiresAt": 123, "isNewUser": true }

部署
====
1. Node.js 18+
2. 配置环境变量：WECHAT_APPID、WECHAT_APPSECRET、AUTH_TOKEN_SECRET。
3. npm start
4. 将该服务通过 HTTPS 暴露，并把 /api/auth/wechat-login 接到小游戏配置的 API 域名。
   当前小游戏默认请求：https://pnxbj.wzpy.com/api/auth/wechat-login
5. 微信公众平台/小游戏后台中，需要把对应 HTTPS 域名加入 request 合法域名。

数据
====
参考版为了可直接运行，用 JSON 文件保存 openid -> userId 映射。
正式上线前建议迁移到你现有数据库（MySQL/PostgreSQL/SQLite 都可以），字段至少包括：
user_id, openid(唯一), unionid(可空), created_at, last_login_at。

安全
====
- AppSecret 只放服务器环境变量。
- 客户端不接收 openid，只接收内部 userId 和登录 token。
- 生产环境建议把 token 校验接入后续云存档、排行榜写入接口。
