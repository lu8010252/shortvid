#!/usr/bin/env python3
"""cap add android 之后运行:放行 http、黑色状态栏/导航栏、换图标、写版本号。
用法: patch_android.py <versionName> <versionCode> <icon.png>
"""
import os
import re
import sys

from PIL import Image, ImageDraw

version_name, version_code, icon_path = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'android', 'app')
root = os.path.normpath(root)
res = os.path.join(root, 'src', 'main', 'res')


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


# 1. 允许明文 http(家里/内网服务器常用)
mf = os.path.join(root, 'src', 'main', 'AndroidManifest.xml')
s = read(mf)
if 'usesCleartextTraffic' not in s:
    s = s.replace('<application', '<application\n        android:usesCleartextTraffic="true"', 1)
write(mf, s)

# 2. 状态栏 / 导航栏纯黑,和页面底色一致
colors = os.path.join(res, 'values', 'colors.xml')
if os.path.exists(colors):
    s = read(colors)
    s = re.sub(r'(<color name="colorPrimary(?:Dark)?">)[^<]*(</color>)', r'\g<1>#000000\g<2>', s)
    write(colors, s)
styles = os.path.join(res, 'values', 'styles.xml')
s = read(styles)
extra = ('\n        <item name="android:statusBarColor">#000000</item>'
         '\n        <item name="android:navigationBarColor">#000000</item>'
         '\n        <item name="android:windowBackground">#000000</item>')
s = re.sub(r'(<style name="AppTheme\.NoActionBar"[^>]*>)', lambda m: m.group(1) + extra, s, count=1)
write(styles, s)

# 3. 图标:所有密度直接用 PNG(删除自适应图标 xml,避免旧图标残留)
sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
src = Image.open(icon_path).convert('RGBA')
for d, px in sizes.items():
    folder = os.path.join(res, 'mipmap-' + d)
    os.makedirs(folder, exist_ok=True)
    im = src.resize((px, px), Image.LANCZOS)
    im.save(os.path.join(folder, 'ic_launcher.png'))
    im.save(os.path.join(folder, 'ic_launcher_foreground.png'))
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mask = mask.resize((px, px), Image.LANCZOS)
    rnd = im.copy()
    rnd.putalpha(mask)
    rnd.save(os.path.join(folder, 'ic_launcher_round.png'))
any26 = os.path.join(res, 'mipmap-anydpi-v26')
if os.path.isdir(any26):
    for n in os.listdir(any26):
        os.remove(os.path.join(any26, n))
    os.rmdir(any26)

# 3.5 启动图:黑底 + 居中图标(替换 Capacitor 默认的 logo 启动图)
for dp, _, names in os.walk(res):
    for n in names:
        if n == 'splash.png':
            p = os.path.join(dp, n)
            w, h = Image.open(p).size
            bg = Image.new('RGB', (w, h), (0, 0, 0))
            side = max(64, min(w, h) // 4)
            logo = src.resize((side, side), Image.LANCZOS)
            bg.paste(logo, ((w - side) // 2, (h - side) // 2), logo)
            bg.save(p)

# 4. 版本号
gradle = os.path.join(root, 'build.gradle')
s = read(gradle)
s = re.sub(r'versionCode\s+\d+', 'versionCode ' + version_code, s, count=1)
s = re.sub(r'versionName\s+"[^"]*"', 'versionName "' + version_name + '"', s, count=1)
write(gradle, s)
print('patched android project: version', version_name, version_code)
