// Windows launcher: a thin .cmd stub that writes an embedded PowerShell script to a temp file
// and runs it. Passed as -EncodedCommand (base64 UTF-16LE) instead of inline quoting so build-time
// rendering never has to escape PowerShell/cmd metacharacters against each other.
// docs/plan/standalone-release-delivery.md § Runtime prerequisites: PowerShell/Invoke-WebRequest/
// Get-FileHash/Expand-Archive only — no Node, npm, Git, WSL, Chocolatey, third-party installer.

/**
 * @param {object} opts
 * @param {string} opts.nodeVersion
 * @param {string} opts.nodeUrl
 * @param {string} opts.nodeSha256
 * @param {string} opts.appVersion
 * @param {string} opts.appUrl
 * @param {string} opts.appSha256
 * @param {string} opts.appArchiveDirName
 */
export function renderWindowsLauncher(opts) {
  const { nodeVersion, nodeUrl, nodeSha256, appVersion, appUrl, appSha256, appArchiveDirName } = opts;
  const nodeArchiveDirName = `node-v${nodeVersion}-win-x64`;

  const ps = `$ErrorActionPreference = "Stop"

$AppDataRoot = Join-Path $env:LOCALAPPDATA "aki-mcp-sv"
$NodeVersion = "${nodeVersion}"
$AppVersion = "${appVersion}"
$RuntimeDir = Join-Path $AppDataRoot ("runtime\\" + $NodeVersion + "\\win32-x64")
$AppDir = Join-Path $AppDataRoot ("app\\" + $AppVersion)

function Install-Verified {
  param([string]$Url, [string]$Sha256, [string]$DestDir, [string]$ExtractedName)
  if (Test-Path $DestDir) { return }
  $parentDir = Split-Path $DestDir -Parent
  New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  $tmpDir = Join-Path $parentDir (".tmp-" + [guid]::NewGuid().ToString() + "-" + (Split-Path $DestDir -Leaf))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $archivePath = Join-Path $tmpDir (Split-Path $Url -Leaf)
  try {
    Write-Host "[aki-mcp-sv] downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $archivePath -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLower()
    if ($actual -ne $Sha256.ToLower()) {
      Write-Error "[aki-mcp-sv] checksum mismatch for $Url (expected $Sha256, got $actual)"
      exit 1
    }
    $extractDir = Join-Path $tmpDir "extract"
    Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force
    Move-Item -Path (Join-Path $extractDir $ExtractedName) -Destination $DestDir
  } finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  }
}

Install-Verified -Url "${nodeUrl}" -Sha256 "${nodeSha256}" -DestDir $RuntimeDir -ExtractedName "${nodeArchiveDirName}"
Install-Verified -Url "${appUrl}" -Sha256 "${appSha256}" -DestDir $AppDir -ExtractedName "${appArchiveDirName}"

$NodeBin = Join-Path $RuntimeDir "node.exe"
if (-not (Test-Path $NodeBin)) {
  Write-Error "[aki-mcp-sv] expected Node binary missing after install: $NodeBin"
  exit 1
}

Set-Location $AppDir
& $NodeBin (Join-Path $AppDir "scripts\\start.js")
`;

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  return (
    '@echo off\r\n' +
    'rem aki-mcp-sv bootstrap launcher (Windows) - generated at release build time, do not hand-edit.\r\n' +
    'rem First run downloads and checksum-verifies a private Node runtime + the app payload into\r\n' +
    'rem %LOCALAPPDATA%\\aki-mcp-sv; later runs reuse them with no network call.\r\n' +
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}\r\n`
  );
}
