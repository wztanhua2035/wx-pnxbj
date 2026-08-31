坡南寻宝记 v5.34.0 微信小游戏独立后端

部署目标：
  https://wxpnxbj.wzpy.net
管理后台：
  https://wxpnxbj.wzpy.net/admin

保留现有 Zeabur 环境变量：
  WECHAT_APPID=微信小游戏 AppID
  WECHAT_APPSECRET=微信小游戏 AppSecret
  AUTH_TOKEN_SECRET=至少24位，建议48位以上
  PASSWORD=小游戏独立管理后台密码
  USER_DB_FILE=/data/auth/users.json

可选：
  MINIGAME_DATA_DIR=/data

不要把 AppSecret、AUTH_TOKEN_SECRET、PASSWORD 写入 GitHub。
不需要重新挂载硬盘；继续使用当前 Service 已挂载的 /data Volume。
程序会自动创建：
  /data/auth/users.json
  /data/saves/*.json
  /data/config/runtime.json
  /data/stats/visits.json
  /data/stats/stage-records.json
  /data/leaderboard/entries.json

主要接口：
  POST /api/auth/wechat-login
  POST /api/save/sync
  GET  /api/save
  GET  /api/config
  POST /api/visit-counter
  GET/POST /api/stage-records
  GET/POST /api/leaderboard
  POST /api/leaderboard/wechat

后台：
  GET  /admin
  POST /api/admin/login
  GET  /api/admin/summary
  GET  /api/admin/players
  GET  /api/admin/player?userId=...
  GET/PUT /api/admin/config
  GET  /api/admin/leaderboard
