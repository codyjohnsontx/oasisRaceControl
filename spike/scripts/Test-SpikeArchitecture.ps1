$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projectRoot = Join-Path $repoRoot 'spike\OasisSpike'
$projectFile = Join-Path $projectRoot 'OasisSpike.csproj'

[xml]$project = Get-Content -Raw $projectFile
$packages = @($project.SelectNodes('//PackageReference'))
if ($packages.Count -ne 0) {
    throw "Venue recorder must have zero PackageReference items; found $($packages.Count)."
}

$forbidden = @(
    'System\.Net',
    'HttpClient',
    '\bSocket\b',
    'WebRequest',
    'Process\.Start',
    'Microsoft\.Win32\.Registry',
    '\bPostMessage\b',
    'RegisterWindowMessage',
    'ServiceController',
    'TaskScheduler',
    'MemoryMappedFileRights\.(Write|ReadWrite)',
    'MemoryMappedFileAccess\.(Write|ReadWrite)',
    'CreateOrOpen\('
)

$source = Get-ChildItem $projectRoot -Filter '*.cs' -Recurse
foreach ($pattern in $forbidden) {
    $matches = $source | Select-String -Pattern $pattern
    if ($matches) {
        $details = ($matches | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }) -join "`n"
        throw "Forbidden venue-recorder capability matched '$pattern':`n$details"
    }
}

$readerSource = Get-Content -Raw (Join-Path $projectRoot 'WindowsIrracingTelemetrySource.cs')
foreach ($required in @(
    'MemoryMappedFileRights.Read',
    'MemoryMappedFileAccess.Read',
    'private const uint Synchronize = 0x00100000',
    'OpenEvent(Synchronize'
)) {
    if (-not $readerSource.Contains($required)) {
        throw "Required read-only control '$required' was not found."
    }
}

Write-Host 'PASS: venue recorder has no package dependencies or forbidden capability references.'
