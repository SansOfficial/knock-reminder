# 敲屏提醒

到点了,选好的形象会从屏幕底部探出头来,用拳头"咚咚咚"敲你的屏幕:屏幕震动、玻璃裂纹、敲击声,直到你点「搞定」或「稍后再敲」。

Electron 实现,一套代码同时支持 macOS 和 Windows,无需任何图片/音频资源(形象用 emoji,声音用 WebAudio 合成)。

## 运行

```bash
npm install
npm start              # 启动,打开设置窗口,常驻菜单栏/托盘
npm start -- --demo    # 启动后立刻敲一次,看效果
```

## 打包

```bash
npm run dist:mac       # 在 macOS 上打 .dmg
npm run dist:win       # 打 Windows 安装包 .exe(建议在 Windows 上或 CI 里打)
```

产物在 `dist/`。未签名的 mac 包首次打开需要右键 →「打开」。

## 功能

- 提醒事项:自定义名称、提醒语、形象;「每隔 N 分钟」或「每天固定时间」两种方式;一键「试一下」
- 形象:10 个内置 + 随机 + 上传自己的图片(推荐透明背景 PNG/GIF)
- 活跃时段、仅工作日、锁屏/睡眠期间不打扰(回来后重新计时)
- 声音开关与音量、背景压暗、自动收起秒数、稍后再敲间隔、开机自启
- 碎玻璃:只有一个撞击点,每一拳让裂纹从撞击点飞快地窜出去,三拳裂满整屏;每条主裂纹和分叉都一直裂到屏幕边缘。形象在玻璃后面,会被碎片错开
- 浮层弹在鼠标所在的显示器,可盖住全屏应用;Esc / Enter 直接关闭

## 形象与授权

默认形象「鲸鱼娘」是 30 帧的精灵图,放在 `src/characters/whale-maid/`:`sheet.png` 是素材,`meta.json` 是播放时间轴(每帧停多久、哪一帧砸中)。调打击感的方法见该目录的 README。

鲸鱼娘的角色原型是「溟月」(画师上善无形,CC BY-NC-SA 4.0),女仆版设计来自 ZipZipPipe。因此本程序**只能自用或免费分享,不得商用**,分发时需要保留署名。

## 结构

```
src/main.js        主进程:配置、调度、托盘、浮层窗口
src/preload.js     渲染进程可用的 api
src/overlay.*      敲屏浮层(动画、提醒卡片、声音)
src/glass.js       WebGL 碎玻璃:放射/环形裂纹、断面光影与色散、形象的碎片错位、飞溅碎屑
src/settings.*     设置界面
```

配置保存在系统用户数据目录下的 `config.json`(mac:`~/Library/Application Support/knock-reminder/`,Windows:`%APPDATA%\knock-reminder\`)。
