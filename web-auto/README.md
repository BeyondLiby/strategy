# AlphaPai 最新资讯自动化

这个项目用于登录 AlphaPai，批量打开股票页，从“最新跟踪”里按日期筛选资讯，并导出正文、元数据、截图和 PDF。

## 快速开始

```powershell
npm.cmd install
npm.cmd run login
npm.cmd run extract -- --day 2
```

如果 PowerShell 拦截 `npm.ps1`，统一使用 `npm.cmd`。

## 目录结构

```text
web-auto/
  config/
    latest-extraction.json      AlphaPai 抓取配置
    fof99-net-values.json       fof99 净值抓取配置
  data/
    stocks.csv                  待抓取股票清单
  src/
    auth/                       AlphaPai 登录和登录检查
    latest-news/                AlphaPai 最新资讯抓取
    fof99/                      fof99 净值抓取
  runtime/                      本地登录态，自动生成，不提交
  output/                       抓取输出，自动生成，不提交
```

## 登录

第一次先手动登录：

```powershell
npm.cmd run login
```

脚本会打开 Edge。登录成功后，AlphaPai 的浏览器资料会保存在：

```text
runtime/alphapai-profile/
```

日常抓取会复用这个目录，所以不会每次都重新登录。脚本也会保留兼容备份：

```text
runtime/auth.json
```

登录态不是永久通行证。如果 AlphaPai 服务端主动要求重新认证，抓取脚本会自动检测 `/login`，并按下面顺序恢复：

1. 优先继续使用 `runtime/alphapai-profile/` 里的持久浏览器资料。
2. 如果 cookies/profile 已失效，并且配置了账号密码，自动打开登录页、填写账号密码并点击登录。
3. 如果站点要求短信、验证码或二次验证，自动登录会停止，并保存失败截图到 `output/debug/auto-login-failed.png`。
4. 如果没有配置账号密码，且当前是可见浏览器模式，会等待你人工登录。

账号密码建议用环境变量：

```powershell
$env:ALPHA_PHONE = "你的手机号"
$env:ALPHA_PASSWORD = "你的密码"
npm.cmd run daily
Remove-Item Env:\ALPHA_PHONE
Remove-Item Env:\ALPHA_PASSWORD
```

也可以放到本地文件。`runtime/` 已经在 `.gitignore` 里，不会提交：

```json
{
  "phone": "你的手机号",
  "password": "你的密码"
}
```

保存为：

```text
runtime/alphapai-credentials.json
```

如果想手动刷新登录态，仍然可以运行：

```powershell
npm.cmd run login
```

检查当前登录态：

```powershell
npm.cmd run login:check
```

### 保持同一登录设备

AlphaPai 相关脚本默认都使用同一个浏览器资料目录：

```text
runtime/alphapai-profile/
```

这个目录保存 cookie、localStorage、IndexedDB、浏览器 profile 等状态。只要不删除它，手动登录、自动登录、抓取和 daily 脚本都会尽量表现为同一台 Edge 设备。

为了减少被识别成“新设备”的概率，建议：

- 不要删除 `runtime/alphapai-profile/`。
- 不要频繁修改 `authProfileDir`。
- AlphaPai 抓取默认使用可见 Edge：`browser.headless = false`。
- 如果登录态很敏感，不建议切换到 headless 模式。
- 不要在多台机器上共用同一个账号同时跑脚本。

如果你确实想后台无头运行，可以临时改：

```powershell
$env:HEADLESS = "true"
npm.cmd run daily
Remove-Item Env:\HEADLESS
```

但从“同一设备稳定性”角度，推荐保持默认的可见 Edge。

## 股票清单

默认股票清单是：

```text
data/stocks.csv
```

格式：

```csv
code,name,url
MU.US,美光科技,https://alphapai-web.rabyte.cn/reading/home/stock?id=MU.US&name=%E7%BE%8E%E5%85%89%E7%A7%91%E6%8A%80
```

也可以从 AlphaPai 股票页 URL 导入：

```powershell
npm.cmd run stocks:import -- "https://alphapai-web.rabyte.cn/reading/home/stock?id=INTC.US&name=%E8%8B%B1%E7%89%B9%E5%B0%94"
```

批量 URL 写入文本文件后导入：

```powershell
npm.cmd run stocks:import -- --input stock-url.txt
npm.cmd run stocks:import -- stock-url.txt
```

## 抓取最新资讯

串行抓取：

```powershell
npm.cmd run extract
```

指定最近 N 天。例如当前日期是 2026-06-23，`--day 2` 表示只要 2026-06-22 到 2026-06-23：

```powershell
npm.cmd run extract -- --day 2
npm.cmd run extract -- --days 2
```

指定单日或日期区间：

```powershell
npm.cmd run extract -- --date 06-23
npm.cmd run extract -- --from 06-22 --to 06-23
```

日期支持 `2026-06-23`、`06-23`、`623`。没有年份时默认使用当前年份。

注意：PowerShell 里不要写成 `-- day 2`，正确写法是 `--day 2` 或 `-- --day 2`。

## 并发抓取

股票级别并发抓取：

```powershell
npm.cmd run extract -- --day 2 --concurrency 2
```

也可以用快捷脚本，默认并发数是 2：

```powershell
npm.cmd run extract:concurrent -- --day 2
```

`--concurrency` 最大会被限制到 4，避免同时打开太多股票页导致登录态、页面加载或站点风控不稳定。建议先用 2，确认稳定后再小步提高。

## 输出规则

每次处理一个资产时，会先清空该资产之前的输出目录，再保存本次结果。

如果指定了日期窗口，例如 `--day 2` 或 `--from/--to`，脚本会下载窗口内识别到的所有候选资讯。比如 MU 在 06-22 到 06-23 有 3 条符合条件，就会导出 3 组正文和 PDF。

如果没有指定日期窗口，脚本只下载列表里最新日期对应的候选资讯。

输出目录：

```text
output/latest-news/
  MU.US_美光科技/
    01-stock.png
    latest-candidates.json
    02-detail.png
    03-detail.png
    04-detail.png
    2026-06-23_MU.US_美光科技_xxx.txt
    2026-06-23_MU.US_美光科技_xxx.json
    2026-06-23_MU.US_美光科技_xxx.pdf
  run-log.csv
```

`latest-candidates.json` 记录本次从页面里识别到的候选资讯，排查 MU、WMT 这类特殊情况时优先看它。

## 单股调试

只抓一只股票：

```powershell
npm.cmd run extract -- --code MU.US --name 美光科技 --day 2
```

打开可见浏览器调试：

```powershell
$env:HEADLESS = "false"
npm.cmd run extract -- --code WMT.US --name 沃尔玛 --day 2
Remove-Item Env:\HEADLESS
```

只探测页面结构，不做正式导出：

```powershell
npm.cmd run probe -- --code MU.US --name 美光科技
```

探测输出在：

```text
output/debug/
```

## 生成 Watchlist 报告

报告脚本只分析 `data/stocks.csv` 里的 watchlist 股票。它会读取：

```text
output/latest-news/run-log.csv
output/latest-news/CODE_NAME/*.txt
output/latest-news/CODE_NAME/*.json
```

有新增资讯的股票会详细写；没有新增资讯的股票只会简短说明“本窗口未抓到新增资讯”。报告不会额外写大盘总览、宏观总览或非 watchlist 股票。

先确认数据链路，不调用 AI：

```powershell
npm.cmd run report -- --no-ai
```

这会生成：

```text
output/latest-news/watchlist-report-input.json
output/latest-news/watchlist-report-prompt.md
```

配置 OpenAI API key 后生成正式报告：

```powershell
$env:OPENAI_API_KEY = "你的 API key"
npm.cmd run report
Remove-Item Env:\OPENAI_API_KEY
```

默认模型是 `gpt-4.1-mini`。可以临时指定：

```powershell
npm.cmd run report -- --model gpt-4.1
```

正式报告输出：

```text
output/latest-news/watchlist-overnight-report.md
output/latest-news/watchlist-stock-summaries.json
output/latest-news/watchlist-report-input.json
```

## 一键更新并生成报告

日常使用可以直接跑：

```powershell
npm.cmd run daily
```

它会自动执行两步：

1. 抓取 AlphaPai 最新资讯。
2. 读取本次输出并生成 watchlist 报告。

默认参数是：

```powershell
--day 2 --concurrency 2
```

也就是抓取当前日期和前一天的资讯，并用 2 个股票页面并发更新。

可以覆盖日期和并发：

```powershell
npm.cmd run daily -- --day 3 --concurrency 1
npm.cmd run daily -- --from 06-24 --to 06-25 --concurrency 2
```

配置 OpenAI API key 后会直接生成正式报告：

```powershell
$env:OPENAI_API_KEY = "你的 API key"
npm.cmd run daily
Remove-Item Env:\OPENAI_API_KEY
```

如果只想更新数据，不生成报告：

```powershell
npm.cmd run daily -- --skip-report
```

如果只想用已有数据重新生成报告：

```powershell
npm.cmd run daily -- --skip-extract
```

如果暂时不调用 AI，只生成报告输入和 prompt：

```powershell
npm.cmd run daily -- --no-ai
```

如果文章太长，可以限制每篇正文塞给 AI 的长度：

```powershell
npm.cmd run report -- --max-article-chars 8000
```

## 常见问题

`Cannot find package 'playwright'`：

```powershell
npm.cmd install
```

`Unexpected positional argument for extract: day`：

命令写成了 `-- day 2`。改成：

```powershell
npm.cmd run extract -- --day 2
```

页面跳到登录页或抓取失败：

```powershell
npm.cmd run login
npm.cmd run login:check
```

某只股票最新日期识别异常：

先跑单股并查看 `latest-candidates.json` 和截图：

```powershell
npm.cmd run extract -- --code AVAV.US --name AeroVironment,Inc. --day 2
```

## 配置

AlphaPai 配置在：

```text
config/latest-extraction.json
```

常用字段：

- `inputCsv`：股票清单路径，默认 `data/stocks.csv`
- `outputDir`：输出路径，默认 `output/latest-news`
- `authProfileDir`：固定浏览器资料目录，默认 `runtime/alphapai-profile`
- `authFile`：兼容备份登录态，默认 `runtime/auth.json`
- `browser.headless`：是否无头运行
- `candidateRules`：候选资讯类型和优先级规则
- `selectors`：页面选择器

也可以把默认并发写进配置：

```json
{
  "concurrency": {
    "stocks": 2
  }
}
```

命令行的 `--concurrency` 优先级更高。

## fof99 净值抓取

fof99 使用独立配置、独立登录态和独立输出目录。

首次登录：

```powershell
npm.cmd run fof99:login
```

fof99 和 AlphaPai 一样使用持久浏览器 profile。默认会复用：

```text
runtime/fof99-profile/
```

如果登录态被网站挤掉，抓取脚本会先尝试本地账号密码自动登录。可以用环境变量：

```powershell
$env:FOF99_ACCOUNT = "你的账号"
$env:FOF99_PASSWORD = "你的密码"
npm.cmd run fof99:extract
```

也可以保存到本地文件：

```text
runtime/fof99-credentials.json
```

格式：

```json
{
  "account": "你的账号",
  "password": "你的密码"
}
```

如果没有保存账号密码，且需要人工登录，用可见浏览器运行：

```powershell
$env:HEADLESS = "false"
npm.cmd run fof99:extract
Remove-Item Env:\HEADLESS
```

抓取：

```powershell
npm.cmd run fof99:extract
```

小样本调试：

```powershell
npm.cmd run fof99:extract -- --maxPages 1 --maxProducts 3
```

fof99 主列表是超大分页，页面底部可能显示几十万条、几千页。脚本会一直点下一页，直到分页器确认没有下一页，或者命中你显式传入的 `--maxPages` / `--maxProducts`。如果日志里出现 `stopped`，需要看后面的停止原因；新版会记录当前页、总页数和总条数，避免把一次翻页加载慢误判成真实结束。

只测试主列表翻页、不进入产品详情、不提取基金数据：

```powershell
npm.cmd run fof99:test-pages -- --maxPages 120
```

这个命令会把每页的当前页码、总页数、总条数、可见产品数、首尾产品名写到 `output/fof99-net-values/logs/pagination-test-YYYYMMDD-HHMMSS.csv`。如果它能稳定跑过第 91 页，再回到正式抓取。

fof99 登录态保存在：

```text
runtime/fof99-profile/
```

输出目录：

```text
output/fof99-net-values/
```

日志位置：

```text
output/fof99-net-values/run-log.csv                    最近一次运行汇总，任务结束时写出
output/fof99-net-values/logs/run-log-YYYYMMDD-HHMMSS.csv
output/fof99-net-values/logs/failed-products-YYYYMMDD-HHMMSS.csv
```

`logs/` 下的日志是实时追加的，任务运行中也可以查看：

```powershell
Get-Content output\fof99-net-values\logs\run-log-YYYYMMDD-HHMMSS.csv -Tail 50
Get-Content output\fof99-net-values\logs\failed-products-YYYYMMDD-HHMMSS.csv -Tail 50
```

脚本启动时会打印本次实时日志文件路径。失败记录会包含错误类型、错误信息、失败截图路径和产品 JSON 路径。

fof99 也支持有限并发：

```powershell
npm.cmd run fof99:extract -- --concurrency 2
```

建议正式跑全量时保持低并发，优先保证登录态和站点访问稳定：

- `1`：最稳，适合调试或登录态不稳定时。
- `2`：默认推荐值，速度和稳定性比较平衡。
- `3`：可以小范围试跑，观察是否出现登录态异常、验证码或页面加载失败。
- `4+`：不建议常态使用。

断点续跑：

- 脚本会把当天已成功完成的产品写入 `output/fof99-net-values/resume-state.json`。
- 同一天任务中断后重启，会跳过当天已经成功的产品。
- 失败、缺 JSON、JSON 损坏、没有净值行、缺少元数据的产品会重新抓。

如果已经有一批历史结果，想从已有成果继续跑而不重新打开这些产品详情页，可以显式开启跨运行跳过：

```powershell
npm.cmd run fof99:extract -- --skipExisting true
```

这个参数会跳过已有完整 `platform-net-values.json` 的产品，并把缓存结果写回本次汇总 CSV。它适合“昨天跑了一半，今天接着补剩余资产”的场景；如果是日常更新新净值，不建议开启它，否则会跳过已有产品的增量检查。

如果需要强制重跑当天已完成产品：

```powershell
npm.cmd run fof99:extract -- --rerunCompleted true
```
