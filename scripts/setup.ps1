$ErrorActionPreference = 'Stop'
$MinimumNodeMajor = 24
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
        $Major = 0
        if ([int]::TryParse(($VersionText -split '\.')[0], [ref]$Major) -and $Major -ge $MinimumNodeMajor) {
            Write-Host "  ✓ Node.js v$VersionText"
        } else {
            Write-Host "  - Node.js $MinimumNodeMajor+ required (found v$VersionText)"
            $Missing.Add('Node.js')
        }
    } else {
        Write-Host "  - Node.js $MinimumNodeMajor+ required"
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
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Host "  ✓ npm $(& npm --version)"
    } else {
        Write-Host '  - npm (bundled with Node.js)'
        $Missing.Add('npm')
    }
    return $Missing.ToArray()
}

Write-Host 'symphony-copilot setup — Windows'
Write-Host "This wizard checks Node.js $MinimumNodeMajor+, Git and GitHub CLI, signs in through gh, then installs this checkout's npm dependencies."
Write-Host 'It does not ask for, print or save your password or token.'
Write-Host ''
Write-Host 'Checking prerequisites:'
$Missing = Get-ToolState
if ($Missing.Count -gt 0) {
    Write-Host ''
    Write-Host 'Official/recommended sources:'
    Write-Host '  Node.js LTS installer (MSI): https://nodejs.org/en/download'
    Write-Host '  Git for Windows: https://git-scm.com/download/win'
    Write-Host '  GitHub CLI: https://github.com/cli/cli/blob/trunk/docs/install_windows.md'
    if ($Missing -contains 'GitHub CLI' -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        if (Confirm-Step "Install GitHub CLI using its maintainer-recommended WinGet package (GitHub.cli)?") {
            winget install --id GitHub.cli --source winget
            if ($LASTEXITCODE -ne 0) { Write-Warning 'WinGet did not install GitHub CLI; continue with the official installer page.' }
        }
    }
    if (Confirm-Step 'Open the official/recommended installation pages?') {
        Start-Process 'https://nodejs.org/en/download'
        Start-Process 'https://git-scm.com/download/win'
        Start-Process 'https://github.com/cli/cli/blob/trunk/docs/install_windows.md'
    }
    Write-Host ''
    Write-Host 'Install any remaining tools from the sources above. Windows may ask for administrator approval.'
    [void](Read-Host 'Press Enter to check again, or Ctrl-C to stop')
    $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$MachinePath;$UserPath;$env:Path"
    Write-Host 'Checking prerequisites again:'
    $Missing = Get-ToolState
    if ($Missing.Count -gt 0) {
        Write-Error "Still missing: $($Missing -join ', '). Nothing was installed from an unverified source. Rerun after installing them."
        exit 1
    }
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
Write-Host 'Grant the GitHub Projects scope. GitHub will ask you to approve it in the browser.'
gh auth refresh --hostname github.com --scopes project
if ($LASTEXITCODE -ne 0) { throw 'Could not grant the project scope.' }
Write-Host 'Configure Git to use GitHub CLI credentials for pushing agent branches.'
gh auth setup-git --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Git credentials.' }
Write-Host ''
gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Authentication verification failed. Run gh auth status and fix the reported issue.' }
Write-Host ''
Write-Host 'Setup complete. Next: .\bin\symphony install-skills, then open the target repository in Copilot and run /symphony-onboard.'
