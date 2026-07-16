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
    $foundMatches = $source | Select-String -Pattern $pattern
    if ($foundMatches) {
        $details = ($foundMatches | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }) -join "`n"
        throw "Forbidden venue-recorder capability matched '$pattern':`n$details"
    }
}

$readerSource = Get-Content -Raw (Join-Path $projectRoot 'WindowsIrracingTelemetrySource.cs')
foreach ($required in @{
    'read-only memory-map open' = 'MemoryMappedFile\s*\.\s*OpenExisting\s*\([^;]*?MemoryMappedFileRights\s*\.\s*Read\b'
    'read-only view accessor' = 'CreateViewAccessor\s*\([^;]*?MemoryMappedFileAccess\s*\.\s*Read\b'
}.GetEnumerator()) {
    if (-not [regex]::IsMatch($readerSource, $required.Value, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw "Required control '$($required.Key)' was not found."
    }
}

$synchronizeDeclaration = [regex]::Match(
    $readerSource,
    '\bconst\s+uint\s+(?<name>[A-Za-z_]\w*)\s*=\s*(?:0x0*100000|1048576)\b',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $synchronizeDeclaration.Success) { throw 'The SYNCHRONIZE-only event access constant was not found.' }
$synchronizeName = [regex]::Escape($synchronizeDeclaration.Groups['name'].Value)
$openEventPattern = "\bOpenEvent\s*\((?=[^;)]*\b$synchronizeName\b)[^;)]*\)"
if (-not [regex]::IsMatch($readerSource, $openEventPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    throw 'OpenEvent does not request the SYNCHRONIZE-only access constant.'
}

Write-Host 'PASS: venue recorder has no package dependencies or forbidden capability references.'
