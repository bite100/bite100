@echo off
REM 在 contracts 目录下双击运行，或在该目录打开 cmd 后执行 install-and-build.bat
REM 需要已安装 Foundry 并加入 PATH：https://getfoundry.sh
cd /d "%~dp0.."
where forge >nul 2>nul || (echo 未找到 forge，请先安装 Foundry: https://getfoundry.sh & exit /b 1)
if not exist "lib\forge-std" (
    echo 安装 forge-std...
    forge install foundry-rs/forge-std --no-commit
)
echo 构建...
forge build
if errorlevel 1 exit /b 1
echo 运行测试...
forge test
exit /b %ERRORLEVEL%
