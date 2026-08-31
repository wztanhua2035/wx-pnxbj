坡南寻宝记 v5.35.0 微信小游戏独立后端

域名：
  https://wxpnxbj.wzpy.net
管理后台：
  https://wxpnxbj.wzpy.net/admin

Zeabur 环境变量：
  WECHAT_APPID
  WECHAT_APPSECRET
  AUTH_TOKEN_SECRET（至少24位，建议48位以上）
  PASSWORD
  USER_DB_FILE=/data/auth/users.json
可选：MINIGAME_DATA_DIR=/data

不要把 AppSecret、AUTH_TOKEN_SECRET、PASSWORD 写入 GitHub。
继续使用当前 Service 已挂载的 /data Volume，不要重新挂载。

主要接口：
  POST /api/auth/wechat-login
  GET  /api/auth/me
  GET/PUT /api/profile
  POST /api/save/sync
  GET  /api/save
  GET  /api/config
  POST /api/visit-counter
  GET/POST /api/stage-records
  GET  /api/leaderboard
  GET  /api/leaderboard/me
  POST /api/leaderboard/wechat   （正式服务器核验成绩）

后台：
  GET  /admin
  POST /api/admin/login
  GET  /api/admin/summary
  GET  /api/admin/players
  GET  /api/admin/player?userId=...
  GET/PUT /api/admin/config
  GET  /api/admin/leaderboard
  POST /api/admin/leaderboard/remove
