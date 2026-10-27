$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCompatible = & node -p "(() => { const [major, minor] = process.versions.node.split('.').map(Number); return major > 24 || (major === 24 && minor >= 14); })()"
if ($nodeCompatible -ne 'true') { throw '项目驾驶舱需要 Node.js 24.14 或更新版本。' }
if (-not (Test-Path -LiteralPath 'dist/index.html')) {
    if (-not (Test-Path -LiteralPath 'node_modules/vite')) { & npm.cmd ci --registry=https://registry.npmjs.org --no-audit --no-fund; if ($LASTEXITCODE) { throw '依赖安装失败。' } }
    & npm.cmd run build
    if ($LASTEXITCODE) { throw '页面构建失败。' }
}
Write-Host '项目驾驶舱正在启动。请在浏览器打开 http://127.0.0.1:4173 。按 Ctrl+C 停止。'
& node server/index.mjs
