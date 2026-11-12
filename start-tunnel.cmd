@echo off
chcp 65001 >nul
cd /d %~dp0
echo.
echo   BuddyKey 公网隧道启动中…… 约 10 秒后下面会出现 https://xxx.trycloudflare.com
echo   把它加上 /v1 填进手机 App 的 Base URL，模型填 deepseek-v4.1
echo   这个窗口不要关；关掉隧道就断。
echo.
bin\cloudflared.exe tunnel --url http://127.0.0.1:8318 --no-autoupdate --logfile data\tunnel.log
pause
