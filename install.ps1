[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$SkipSync,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-File {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required package file is missing: $Path"
  }
}

$packageRoot = $PSScriptRoot
$sourceSkill = Join-Path $packageRoot "loop-development"
Require-File (Join-Path $sourceSkill "SKILL.md")
Require-File (Join-Path $sourceSkill "references\protocol.md")
Require-File (Join-Path $sourceSkill "references\foreman.md")
Require-File (Join-Path $sourceSkill "references\worker.md")
Require-File (Join-Path $sourceSkill "references\monitor.md")
Require-File (Join-Path $sourceSkill "scripts\state-store.mjs")
Require-File (Join-Path $sourceSkill "scripts\validate-manifest.mjs")

$node = Get-Command node -ErrorAction Stop
$userHome = [Environment]::GetFolderPath("UserProfile")
$syncScript = Join-Path $userHome ".agents\bin\sync-agents.mjs"

& $node.Source --check (Join-Path $sourceSkill "scripts\state-store.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Packaged state-store.mjs failed the Node syntax check"
}

& $node.Source --check (Join-Path $sourceSkill "scripts\validate-manifest.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Packaged validate-manifest.mjs failed the Node syntax check"
}

if ($ValidateOnly) {
  Write-Host "Package validation passed. No files were installed."
  return
}

if ($InstallRoot) {
  $skillRoot = [IO.Path]::GetFullPath($InstallRoot)
  $syncAfterInstall = $false
}
elseif (Test-Path -LiteralPath $syncScript -PathType Leaf) {
  $skillRoot = Join-Path $userHome ".agents\skills"
  $syncAfterInstall = -not $SkipSync
}
else {
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userHome ".codex" }
  $skillRoot = Join-Path $codexHome "skills"
  $syncAfterInstall = $false
}

$skillRoot = [IO.Path]::GetFullPath($skillRoot)
$destination = Join-Path $skillRoot "loop-development"

if (Test-Path -LiteralPath $destination) {
  throw "Installation stopped: destination already exists. Back it up or remove it manually before retrying: $destination"
}

New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath $sourceSkill -Destination $destination -Recurse

if ($syncAfterInstall) {
  & $node.Source $syncScript
  if ($LASTEXITCODE -ne 0) {
    throw "Skill files were copied, but sync-agents.mjs failed. Inspect the output and retry synchronization manually."
  }
}

Write-Host "Installed loop-development to: $destination"
Write-Host "Restart Codex or open a new task before using the skill."
