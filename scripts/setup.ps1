$ErrorActionPreference = 'Stop'
$MinimumNodeMajor = 22
$MinimumNodeMinor = 18
$NodeInstallMajor = 24
$NodeDistBase = "https://nodejs.org/dist/latest-v$NodeInstallMajor.x"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Confirm-Step([string] $Message) {
    $Answer = Read-Host "$Message [y/N]"
    return $Answer -match '^(y|yes)$'
}

function Get-ToolState {
    $Missing = [System.Collections.Generic.List[string]]::new()
    $Node = Get-Command node -ErrorAction SilentlyContinue
    if ($Node) {
        $VersionText = (& node --version 2>$null).Trim() -replace '^v', ''
        $VersionParts = $VersionText -split '\.'
        $Major = 0
        $Minor = 0
        if ($VersionParts.Count -ge 2 -and [int]::TryParse($VersionParts[0], [ref]$Major) -and [int]::TryParse($VersionParts[1], [ref]$Minor) -and ($Major -gt $MinimumNodeMajor -or ($Major -eq $MinimumNodeMajor -and $Minor -ge $MinimumNodeMinor))) {
            Write-Host "  ✓ Node.js v$VersionText"
        } else {
            Write-Host "  - Node.js $MinimumNodeMajor.$MinimumNodeMinor+ required (found v$VersionText)"
            $Missing.Add('Node.js')
        }
    } else {
        Write-Host "  - Node.js $MinimumNodeMajor.$MinimumNodeMinor+ required"
        $Missing.Add('Node.js')
    }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $GitVersion = (& git --version).Trim() -replace '^git version ', ''
        $GitParts = $GitVersion -split '\.'
        $GitMajor = 0
        $GitMinor = 0
        if ($GitParts.Count -ge 2 -and [int]::TryParse($GitParts[0], [ref]$GitMajor) -and [int]::TryParse($GitParts[1], [ref]$GitMinor) -and ($GitMajor -gt 2 -or ($GitMajor -eq 2 -and $GitMinor -ge 38))) {
            Write-Host "  ✓ Git $GitVersion"
        } else {
            Write-Host "  - Git 2.38+ required for merge-tree conflict checks (found $GitVersion)"
            $Missing.Add('Git')
        }
    } else {
        Write-Host '  - Git'
        $Missing.Add('Git')
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $GhVersion = (& gh --version | Select-Object -First 1).Trim() -replace '^gh version ', ''
        Write-Host "  ✓ GitHub CLI $GhVersion"
    } else {
        Write-Host '  - GitHub CLI (gh)'
        $Missing.Add('GitHub CLI')
    }
    if (Get-Command copilot -ErrorAction SilentlyContinue) {
        $CopilotVersion = (& copilot --version 2>$null | Select-Object -First 1).Trim()
        Write-Host "  ✓ Copilot CLI $CopilotVersion"
    } else {
        Write-Host '  - GitHub Copilot CLI (copilot)'
        $Missing.Add('Copilot CLI')
    }
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Host "  ✓ npm $(& npm --version)"
    } else {
        Write-Host '  - npm (bundled with Node.js)'
        $Missing.Add('npm')
    }
    return $Missing.ToArray()
}

function Get-NodeArchive {
    $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $NodeArchitecture = switch ($Architecture) {
        'arm64' { 'arm64' }
        'x64' { 'x64' }
        default { throw "Node.js official Windows archives do not support architecture '$Architecture'." }
    }
    $Manifest = Invoke-RestMethod -Uri "$NodeDistBase/SHASUMS256.txt" -Method Get
    $Pattern = "^(node-v$NodeInstallMajor\.\d+\.\d+-win-$NodeArchitecture\.zip)\s+(.+)$"
    foreach ($Line in ($Manifest -split "`n")) {
        if ($Line.Trim() -match $Pattern) {
            return @{ Name = $Matches[1]; Hash = $Matches[2].Trim() }
        }
    }
    throw "No official Node.js $NodeInstallMajor LTS archive found for Windows $NodeArchitecture."
}

function Install-NodeUser {
    $ArchiveInfo = Get-NodeArchive
    $TempDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    $ZipPath = Join-Path $TempDir $ArchiveInfo.Name
    $ExtractDir = Join-Path $TempDir 'unpacked'
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\symphony-node-v$NodeInstallMajor"
    New-Item -ItemType Directory -Path $TempDir, $ExtractDir -Force | Out-Null
    try {
        Invoke-WebRequest -Uri "$NodeDistBase/$($ArchiveInfo.Name)" -OutFile $ZipPath
        $ActualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
        if ($ActualHash -ne $ArchiveInfo.Hash) { throw 'Node.js archive SHA-256 did not match the official SHASUMS256.txt; refusing to install.' }
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
        $ExtractedRoot = Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1
        if (-not $ExtractedRoot) { throw 'The official Node.js archive was empty.' }
        New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
        if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
        Move-Item -LiteralPath $ExtractedRoot.FullName -Destination $InstallDir

        $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $PathEntries = @($UserPath -split ';' | Where-Object { $_ })
        if ($PathEntries -notcontains $InstallDir) {
            [Environment]::SetEnvironmentVariable('Path', ((@($InstallDir) + $PathEntries) -join ';'), 'User')
        }
        $env:Path = "$InstallDir;$env:Path"
        Write-Host "Installed $(& (Join-Path $InstallDir 'node.exe') --version) from the official Node.js LTS archive; SHA-256 verified."
        Write-Host "Added $InstallDir to the user PATH. New terminals will pick it up too."
    } finally {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-ConfirmedTools([string[]] $Missing) {
    if ($Missing -contains 'Node.js') { Install-NodeUser }
    if ($Missing -contains 'Copilot CLI') {
        $CopilotPrefix = Join-Path $env:LOCALAPPDATA 'Programs\symphony-copilot-tools'
        $PreviousIgnoreScripts = $env:npm_config_ignore_scripts
        $env:npm_config_ignore_scripts = 'false'
        npm install --global --prefix $CopilotPrefix '@github/copilot'
        $env:npm_config_ignore_scripts = $PreviousIgnoreScripts
        if ($LASTEXITCODE -ne 0) { throw 'npm failed to install @github/copilot.' }
        [Environment]::SetEnvironmentVariable('Path', "$CopilotPrefix;$([Environment]::GetEnvironmentVariable('Path', 'User'))", 'User')
        $env:Path = "$CopilotPrefix;$env:Path"
    }
    foreach ($Package in @(
        @{ Name = 'Git'; Id = 'Git.Git' },
        @{ Name = 'GitHub CLI'; Id = 'GitHub.cli' }
    )) {
        if ($Missing -contains $Package.Name) {
            $CommandName = 'gh'
            if ($Package.Name -eq 'Git') { $CommandName = 'git' }
            $Installed = Get-Command $CommandName -ErrorAction SilentlyContinue
            if ($Installed) {
                winget upgrade --id $Package.Id --source winget --accept-source-agreements --accept-package-agreements
            } else {
                winget install --id $Package.Id --source winget --accept-source-agreements --accept-package-agreements
            }
            if ($LASTEXITCODE -ne 0) { throw "WinGet failed to install/update $($Package.Name)." }
        }
    }
    $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$MachinePath;$UserPath;$env:Path"
}

Write-Host 'symphony-copilot setup — Windows'
Write-Host "This wizard checks Node.js $MinimumNodeMajor.$MinimumNodeMinor+, Git, GitHub CLI and Copilot CLI, signs in to both services, then installs this checkout's npm dependencies."
Write-Host 'GitHub CLI tested version: 2.101.0 (2026-09-29). Existing gh installations are detected, not automatically upgraded.'
Write-Host 'The wizard does not handle tokens directly; gh and Copilot CLI store credentials using their normal auth flows.'
Write-Host ''
Write-Host 'Checking prerequisites:'
$Missing = Get-ToolState
if ($Missing.Count -gt 0) {
    $CanInstall = ($Missing -notcontains 'GitHub CLI' -or (Get-Command winget -ErrorAction SilentlyContinue)) -and
                  ($Missing -notcontains 'Git' -or (Get-Command winget -ErrorAction SilentlyContinue))
    Write-Host ''
    Write-Host 'The following missing tools will be installed after your confirmation:'
    if ($Missing -contains 'Node.js') { Write-Host "  - Current Node.js LTS (Node $NodeInstallMajor; satisfies minimum $MinimumNodeMajor.$MinimumNodeMinor) from nodejs.org; verify official SHA-256; install under your user profile, no admin required" }
    if ($Missing -contains 'Copilot CLI') { Write-Host '  - GitHub Copilot CLI from the official npm package @github/copilot (user-local prefix; no admin required)' }
    if ($Missing -contains 'Git') { Write-Host '  - Git for Windows using the official WinGet source (admin approval may be requested)' }
    if ($Missing -contains 'GitHub CLI') { Write-Host '  - GitHub CLI using the maintainer-supported WinGet package (GitHub.cli)' }
    if (-not $CanInstall) {
        Write-Host 'WinGet is unavailable, so Git/GitHub CLI cannot be installed automatically. Install them from:'
        Write-Host '  https://git-scm.com/download/win'
        Write-Host '  https://github.com/cli/cli/blob/trunk/docs/install_windows.md'
        throw 'Cannot install all missing prerequisites automatically without WinGet.'
    }
    if (-not (Confirm-Step 'Proceed with these installations?')) { throw 'Cancelled before installing anything.' }
    Install-ConfirmedTools $Missing
    Write-Host 'Checking prerequisites again:'
    $Missing = Get-ToolState
    if ($Missing.Count -gt 0) { throw "Some prerequisites remain missing: $($Missing -join ', ')." }
}

Write-Host ''
Push-Location $Root
try {
    if (Test-Path 'package-lock.json') {
        if (Confirm-Step "Install this checkout's npm dependencies with npm ci?") {
            npm ci
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        }
        else { Write-Host 'Skipped npm ci. Run it before using this checkout.' }
    } else {
        if (Confirm-Step "Install this checkout's npm dependencies with npm install?") {
            npm install
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
        }
        else { Write-Host 'Skipped npm install. Run it before using this checkout.' }
    }
} finally {
    Pop-Location
}

Write-Host 'GitHub and Copilot sign-in:'
$LoggedIn = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh auth status --hostname github.com *> $null
    if ($LASTEXITCODE -eq 0) {
        $Account = (& gh api user --jq .login 2>$null).Trim()
        Write-Host "GitHub CLI is already signed in$(if ($Account) { " as $Account" })."
        $LoggedIn = Confirm-Step 'Reuse this account?'
    }
}
if (-not $LoggedIn) {
    Write-Host "Starting GitHub's browser sign-in through the official GitHub CLI."
    gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw 'gh auth login failed.' }
}

Write-Host ''
$ProjectScopes = (& gh auth status --hostname github.com --json hosts --jq '.hosts["github.com"][] | select(.active) | .scopes // ""' 2>$null) -join ','
if ($LASTEXITCODE -eq 0 -and (($ProjectScopes -split ',') | ForEach-Object { $_.Trim() }) -contains 'project') {
    Write-Host 'The active GitHub account already has the Projects scope; skipping authorization.'
} else {
    Write-Host 'Grant the GitHub Projects scope. GitHub will ask you to approve it in the browser.'
    gh auth refresh --hostname github.com --scopes project
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the project scope.' }
}
Write-Host 'Configure Git to use GitHub CLI credentials for pushing agent branches.'
gh auth setup-git --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Git credentials.' }
Write-Host ''
gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Authentication verification failed. Run gh auth status and fix the reported issue.' }
Write-Host ''
Write-Host 'GitHub CLI authentication is complete. Choose how to authenticate Copilot CLI:'
Write-Host '  1) Device code — visit github.com/login/device and enter the code (recommended for containers/remote shells)'
Write-Host '  2) Browser link — open the OAuth link in a local browser'
Write-Host 'Copilot CLI stores credentials in the Windows Credential Manager.'
do {
    $CopilotLoginMethod = Read-Host 'Copilot login method [1/2, default 1]'
    if ([string]::IsNullOrWhiteSpace($CopilotLoginMethod)) { $CopilotLoginMethod = '1' }
    if ($CopilotLoginMethod -notin @('1', '2')) { Write-Host 'Choose 1 for device code or 2 for browser link.' }
} while ($CopilotLoginMethod -notin @('1', '2'))
if ($CopilotLoginMethod -eq '1') { copilot login --device-code }
else { copilot login --web-flow }
if ($LASTEXITCODE -ne 0) { throw 'Copilot CLI login failed.' }
Write-Host 'Setup complete. Next: .\bin\symphony install-skills, then open the target repository in Copilot and run /symphony-onboard.'
