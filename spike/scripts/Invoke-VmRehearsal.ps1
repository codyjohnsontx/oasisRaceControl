param(
    [Parameter(Mandatory = $true)] [string] $CandidateDirectory,
    [Parameter(Mandatory = $true)] [string] $PublisherPath,
    [Parameter(Mandatory = $true)] [string] $ExpectedSha256,
    [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $ExpectedSignerSubject,
    [ValidateSet('canary', 'full')] [string] $Mode = 'canary'
)

$ErrorActionPreference = 'Stop'
$candidate = (Resolve-Path $CandidateDirectory).Path
$recorderPath = Join-Path $candidate 'OasisSpike.exe'
$publisherPath = (Resolve-Path $PublisherPath).Path

if (-not (Test-Path $recorderPath)) { throw "Recorder not found: $recorderPath" }
if (-not (Test-Path $publisherPath)) { throw "Synthetic publisher not found: $publisherPath" }

$actualHash = (Get-FileHash $recorderPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw "SHA-256 mismatch." }

$signature = Get-AuthenticodeSignature $recorderPath
if ($signature.Status -ne 'Valid') { throw "Authenticode signature is not valid: $($signature.Status)" }
if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne $ExpectedSignerSubject) {
    throw "Authenticode signer does not match the expected Azure Trusted Signing subject."
}

$startedAt = Get-Date
$publisherInfo = [System.Diagnostics.ProcessStartInfo]::new($publisherPath)
$publisherInfo.UseShellExecute = $false
$publisherInfo.RedirectStandardInput = $true
$recorder = $null
$publisher = [System.Diagnostics.Process]::Start($publisherInfo)
try {
    Start-Sleep -Seconds 2
    $recorderInfo = [System.Diagnostics.ProcessStartInfo]::new($recorderPath)
    $recorderInfo.ArgumentList.Add('--mode')
    $recorderInfo.ArgumentList.Add($Mode)
    $recorderInfo.UseShellExecute = $false
    $recorderInfo.RedirectStandardInput = $true
    $recorder = [System.Diagnostics.Process]::Start($recorderInfo)
    $samples = @()
    $minimumSamples = 10
    $previousCpu = $recorder.TotalProcessorTime
    $previousSampleAt = Get-Date
    for ($i = 0; $i -lt $minimumSamples -and -not $recorder.HasExited; $i++) {
        Start-Sleep -Seconds 1
        $recorder.Refresh()
        $sampleAt = Get-Date
        $cpu = $recorder.TotalProcessorTime
        $wallMilliseconds = ($sampleAt - $previousSampleAt).TotalMilliseconds
        $cpuPercentOfOneCore = if ($wallMilliseconds -gt 0) { 100 * ($cpu - $previousCpu).TotalMilliseconds / $wallMilliseconds } else { 0 }
        $connections = @(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName 'MSFT_NetTCPConnection' -Filter "OwningProcess = $($recorder.Id)" -ErrorAction Stop)
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($recorder.Id)" -ErrorAction Stop)
        $samples += [pscustomobject]@{
            at = $sampleAt.ToUniversalTime().ToString('O')
            cpuPercentOfOneCore = [math]::Round($cpuPercentOfOneCore, 3)
            workingSetBytes = $recorder.WorkingSet64
            handleCount = $recorder.HandleCount
            tcpConnections = $connections.Count
            childProcesses = $children.Count
        }
        $previousCpu = $cpu
        $previousSampleAt = $sampleAt
    }
    if (-not $recorder.HasExited) { $recorder.StandardInput.WriteLine('q') }
    if (-not $recorder.WaitForExit(5000)) { $recorder.Kill(); throw 'Recorder did not stop within five seconds.' }
    if ($samples.Count -lt $minimumSamples) { throw "Recorder exited before producing $minimumSamples inspection samples." }
    if ($recorder.ExitCode -ne 0) { throw "Recorder exited with nonzero code $($recorder.ExitCode)." }
    if ($samples | Where-Object tcpConnections -gt 0) { throw 'Recorder owned a TCP connection during rehearsal.' }
    if ($samples | Where-Object childProcesses -gt 0) { throw 'Recorder created a child process during rehearsal.' }
    if (($samples | Measure-Object workingSetBytes -Maximum).Maximum -gt 150MB) { throw 'Recorder exceeded the 150 MiB working-set gate.' }
    $warmedSamples = @($samples | Select-Object -Skip 2)
    if ($warmedSamples.Count -gt 0 -and ($warmedSamples | Measure-Object cpuPercentOfOneCore -Average).Average -gt 5) { throw 'Recorder exceeded the 5% one-core average CPU gate after warm-up.' }

    $report = [ordered]@{
        schemaVersion = 1
        candidateSha256 = $actualHash
        signatureStatus = $signature.Status.ToString()
        signer = $signature.SignerCertificate.Subject
        mode = $Mode
        startedAtUtc = $startedAt.ToUniversalTime().ToString('O')
        completedAtUtc = (Get-Date).ToUniversalTime().ToString('O')
        samples = $samples
        manualEvidenceStillRequired = @('Process Monitor write trace', 'Defender custom scan', 'SmartScreen launch observation', 'VM snapshot repeat', 'independent review')
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $candidate 'VM-REHEARSAL-PARTIAL.json') -Encoding UTF8
    Write-Host 'Automated rehearsal checks passed. Complete the manual evidence checklist; this does not authorize venue use.'
}
finally {
    try {
        if ($recorder -and -not $recorder.HasExited) {
            try { $recorder.StandardInput.WriteLine('q') } catch {}
            if (-not $recorder.WaitForExit(5000)) {
                $recorder.Kill()
                $recorder.WaitForExit(5000) | Out-Null
            }
        }
    }
    finally {
        if ($publisher -and -not $publisher.HasExited) {
            $publisher.StandardInput.WriteLine('q')
            if (-not $publisher.WaitForExit(5000)) { $publisher.Kill() }
        }
    }
}
