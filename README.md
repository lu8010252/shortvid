# 短视频库 shortvid

自建的抖音式短视频网站,给孩子用的封闭内容池:只有你放进去的视频,没有推荐算法、评论、搜索和广告。

- 视频库 = 服务器上的文件夹,每个子文件夹自动成为「合集」,按集数顺序播放(第2集排在第10集前)
- 上下滑动切换,单击暂停,双击收藏;合集记住看到哪一集哪一秒,播完自动接下一集
- 横屏视频在竖屏手机上自动转成横向播放,也可单个手动切换
- 孩子账号:可看的视频库、每日时长、连续观看休息提醒、禁止观看时段、是否允许「随便刷」
- 网页可添加到主屏幕(PWA),也有 Android App

## 部署(Docker)

镜像由 GitHub Actions 自动构建,支持 **amd64 / arm64 / armv7**,贴 compose 就能用:

```yaml
services:
  shortvid:
    image: ghcr.io/lu8010252/shortvid:latest
    container_name: shortvid
    restart: unless-stopped
    ports:
      - "8088:3000"
    environment:
      - TZ=Asia/Shanghai
      - ADMIN_USER=admin       # 仅首次启动创建管理员时有效
      - ADMIN_PASS=changeme123
    volumes:
      - ./data:/data           # 数据库、封面
      - /video:/video:ro       # 左边改成服务器上存放短视频的目录(只读)
```

`docker compose up -d`,打开 `http://服务器IP:8088`,用管理员账号登录 → 我的 → 管理后台。
数据都在 `./data`,备份它即可。放在反向代理后面时,Nginx 建议加 `proxy_buffering off;`。

> 第一次推送后,到仓库的 Packages 里把 `shortvid` 设为 Public,就能免登录拉取。

## 使用流程

1. 管理后台 → 视频库管理 → 添加:选 `/video` 下的文件夹,后台自动扫描
2. 合集顺序不对?「合集排序」里手动调整、改标题,或一键恢复按文件名自动排序
3. 用户管理 → 添加孩子账号,设置可看的视频库和各种限制
4. 手机浏览器「添加到主屏幕」,或安装下面的 APK

手机对 H.265(HEVC) / MKV 的支持不一,建议用 H.264 的 mp4;后台会提示 H.265 的视频数量。

## Android App

到 [Releases](../../releases) 下载 `shortvid.apk`(通用包,适配所有 CPU 架构)。首次打开输入服务器地址,之后自动进入;
「我的」页里可以「更换服务器地址」。App 只是加载服务器网页的外壳,服务端更新后无需重装。

重新打包 APK:Actions → Build APK → Run workflow,填版本号(如 `v1.0.1`);或推送 `v*` 标签。
APK 使用仓库内固定的调试签名(`app/signing/debug.keystore`),保证新版本能直接覆盖安装,仅适合自用。

## 本地开发

```bash
npm install
DATA_DIR=./data VIDEO_ROOT=/path/to/videos PORT=3000 node server.js
```

需要本机装有 `ffmpeg` / `ffprobe`(用于读取时长、分辨率和生成封面)。
