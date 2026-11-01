#!/usr/bin/env bash
# 用法: fetch.sh <页面名> <htmlFileId> <screenshotFileId>
# 从 Stitch 项目 15922030281254393504 下载页面产物并解包 JSON 包装
set -e
cd "$(dirname "$0")/.."
PAGE="$1"; H="$2"; S="$3"
PROJ="15922030281254393504"
KEY=$(node -e "const c=require('C:/Users/Administrator/.zcode/cli/config.json');const s=c.mcp.servers.stitch;const i=s.args.indexOf('X-Goog-Api-Key');console.log(s.args[i+1])")
T="$TEMP"
curl -s -x http://127.0.0.1:7897 -H "X-Goog-Api-Key: $KEY" \
  "https://stitch.googleapis.com/v1/projects/$PROJ/files/$H:download" -o "$T/h.json" --max-time 60
curl -s -x http://127.0.0.1:7897 -H "X-Goog-Api-Key: $KEY" \
  "https://stitch.googleapis.com/v1/projects/$PROJ/files/$S:download" -o "$T/s.json" --max-time 60
node -e "
const fs=require('fs');
const T=process.env.TEMP;
const h=JSON.parse(fs.readFileSync(T+'/h.json','utf8'));
const s=JSON.parse(fs.readFileSync(T+'/s.json','utf8'));
const html=h.dataString||h.html||'';
fs.writeFileSync('.stitch2/designs/$PAGE.html', html);
fs.writeFileSync('.stitch2/designs/$PAGE.png', Buffer.from(s.dataString||'', 'base64'));
console.log('$PAGE: html', html.length, 'chars; png', fs.statSync('.stitch2/designs/$PAGE.png').size, 'bytes');
"
