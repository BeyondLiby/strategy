[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [int]$Concurrency = 2
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "[fof99-resume] working directory: $Root"
Write-Host "[fof99-resume] base log: output\fof99-net-values\logs\run-log-20260625-170927.csv"
Write-Host "[fof99-resume] mode: skip complete JSON, rerun no-net-value/problem assets, concurrency=$Concurrency"

if ($PSCmdlet.ShouldProcess("fof99:loop", "resume with notifications, --skipExisting true --rerunNoNetValue true --concurrency $Concurrency")) {
  npm.cmd run fof99:loop -- --notifyTitle "fof99 extract progress" -- --runId 20260625-170927 --appendLog true --skipExisting true --rerunNoNetValue true --concurrency $Concurrency
}
