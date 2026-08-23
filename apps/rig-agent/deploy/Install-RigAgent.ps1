#Requires -Version 5.1
<#
.SYNOPSIS
    Puts a build of the Oasis rig agent on this simulator and leaves it scoring.

.DESCRIPTION
    One command, run once per machine, on twenty-plus machines. It copies the
    build, writes THIS rig's identity, starts the agent the only way that can read
    iRacing, and then checks its own work before it says it is done.

    The first run on a machine enrols it and needs the rig's number, its token and
    the site address. Every run after that is an update and needs no arguments:

        .\Install-RigAgent.ps1 -RigNumber 3 -RigToken '<this rig's token>' -BackendBaseUrl 'https://oasis-race-control.vercel.app'
        .\Install-RigAgent.ps1

    Three venue failures are designed out rather than written down:

    * A rig's identity is never copied. The token comes from the command line at
      enrolment and from the machine's own config afterwards, and a source folder
      carrying agent.config.json is refused - that is somebody copying a working
      rig's folder to the next machine, which puts two simulators on one token and
      credits half a night's laps to whoever is checked in on the other one.
    * An update never touches agent.config.json. It is the one file that has to
      survive a build being replaced over the top of it.
    * The agent is started by a logon task running as the rig's own account. A
      service, or a task set to run whether the user is logged on or not, lands in
      Windows session 0, where iRacing's telemetry has no name at all - the rig
      then looks online all night and scores nothing. The task is registered as an
      interactive logon task and read back to prove it.

    Exit codes: 0 done; 2 the command did not describe one rig; 3 the source is not
    an agent build; 4 the install failed on this machine; 5 installed but the
    result could not be verified; 6 installed and running, but this rig will not
    score as it stands; 7 installed and running, but the backend will not accept
    this rig's token; 8 installed and running, but the token given is another
    rig's - this is the install command for a different machine, run here.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-RigAgent.ps1 -RigNumber 3 -RigToken 'r3-9f2c' -BackendBaseUrl 'https://oasis-race-control.vercel.app'
#>
[CmdletBinding()]
param(
    # The folder holding OasisRigAgent.exe. Defaults to this script's own folder,
    # then a 'publish' folder beside it - the two shapes a USB stick arrives in.
    [string] $Source,

    # Enrolment only. Passing them to an update is refused rather than obeyed.
    [int]    $RigNumber,
    [string] $RigToken,
    [string] $BackendBaseUrl,

    # Written only when given, so the build's own default reaches the fleet with an
    # update instead of being frozen at whatever the first install typed.
    [int]    $IdleTimeoutSeconds = -1,

    [string] $InstallRoot = 'C:\Program Files\Oasis Race Control',
    [string] $DataRoot    = 'C:\ProgramData\OasisRaceControl',

    # The account that signs in at the rig and runs iRacing. The agent has to be in
    # that same Windows session to be able to read the sim at all.
    [string] $RigUser     = "$env:USERDOMAIN\$env:USERNAME",

    [string] $TaskName    = 'Oasis Rig Agent'
)

$ErrorActionPreference = 'Stop'

$script:ExitDone            = 0
$script:ExitNotOneRig       = 2
$script:ExitNotAnAgentBuild = 3
$script:ExitInstallFailed   = 4
$script:ExitNotVerified     = 5
$script:ExitWillNotScore    = 6
$script:ExitTokenRefused    = 7
$script:ExitWrongRig        = 8

$script:ConfigFileName = 'agent.config.json'
$script:ExeName        = 'OasisRigAgent.exe'
$script:SampleToken    = 'dev-rig-1-secret'

# $IsWindows only exists from PowerShell 6; on Windows PowerShell 5.1 the answer
# is always yes, and that is the shell a venue machine has out of the box.
$script:OnWindows = if (Test-Path Variable:\IsWindows) { $IsWindows } else { $true }

# A refusal an operator can act on, carrying the exit code the caller must give.
class RigInstallRefusal : System.Exception {
    [int] $Code
    RigInstallRefusal([int] $code, [string] $message) : base($message) { $this.Code = $code }
}

function New-Refusal {
    param([int] $Code, [string] $Message)
    return [RigInstallRefusal]::new($Code, $Message)
}

# ---------------------------------------------------------------------------
# The rules. Free of Windows APIs, so they are tested on any machine.
# ---------------------------------------------------------------------------

<#
Where this machine's identity already lives, or $null if it has none.

Mirrors AgentPaths' own order - beside the executable first, then the data folder
- because the file the AGENT reads is the file that decides whether this run is an
enrolment or an update. Reversing it would write a second config the agent never
reads and leave the rig quietly on its old token.
#>
function Get-EnrolledConfigPath {
    param([string] $InstallRoot, [string] $DataRoot)

    $besideExe = Join-Path $InstallRoot $script:ConfigFileName
    if (Test-Path -LiteralPath $besideExe -PathType Leaf) { return $besideExe }
    $inData = Join-Path $DataRoot $script:ConfigFileName
    if (Test-Path -LiteralPath $inData -PathType Leaf) { return $inData }
    return $null
}

<#
Check the folder about to be copied onto a venue computer is a build of the agent,
and only a build of the agent.

The second refusal is the one that matters. The fastest way to set the room up is
to copy a working rig's folder to the next machine, and if agent.config.json
travels with it both simulators are the same rig as far as the site is concerned:
both heartbeat, both look healthy, and every lap from either is credited to
whoever is checked in on the one rig.
#>
function Assert-AgentBuildFolder {
    param([string] $Source)

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw (New-Refusal $script:ExitNotAnAgentBuild "There is no folder at $Source to install from.")
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Source $script:ExeName) -PathType Leaf)) {
        throw (New-Refusal $script:ExitNotAnAgentBuild ("$Source does not hold $($script:ExeName), so there is no agent here to install.`n" +
            "Point -Source at the published build - the folder with $($script:ExeName) in it."))
    }
    $strayConfig = Join-Path $Source $script:ConfigFileName
    if (Test-Path -LiteralPath $strayConfig -PathType Leaf) {
        throw (New-Refusal $script:ExitNotAnAgentBuild ("$strayConfig is another rig's identity, and installing it here would put two simulators`n" +
            "on one token: both would heartbeat, both would look healthy, and every lap from either`n" +
            "machine would be credited to whoever is checked in on the one rig.`n" +
            "Install from a published build, not from a copy of a working rig's folder."))
    }
}

<#
The enrolment details, checked here so a mistyped address or an empty token fails
while somebody is standing at the machine rather than at eight o'clock on a
Wednesday. These are the agent's own rules (AgentConfig.Validate).
#>
function Assert-RigIdentity {
    param([int] $RigNumber, [string] $RigToken, [string] $BackendBaseUrl)

    $missing = @()
    if ($RigNumber -le 0) { $missing += '-RigNumber' }
    if ([string]::IsNullOrWhiteSpace($RigToken)) { $missing += '-RigToken' }
    if ([string]::IsNullOrWhiteSpace($BackendBaseUrl)) { $missing += '-BackendBaseUrl' }
    if ($missing.Count -gt 0) {
        throw (New-Refusal $script:ExitNotOneRig ("This computer has not been enrolled yet, so it needs its own identity. Missing: $($missing -join ', ').`n" +
            "Every rig gets its OWN number and token - never another machine's."))
    }

    $url = $null
    $wellFormed = [Uri]::TryCreate($BackendBaseUrl, [UriKind]::Absolute, [ref] $url)
    if (-not $wellFormed -or -not ($url.Scheme -eq 'https' -or ($url.Scheme -eq 'http' -and $url.IsLoopback))) {
        throw (New-Refusal $script:ExitNotOneRig ("-BackendBaseUrl must be an https:// address (http:// only for localhost): `"$BackendBaseUrl`".`n" +
            "The rig's token rides on every request, so the agent refuses plain http and this rig would never come online."))
    }

    # The published sample carries a working-looking token. Installed unchanged it
    # authenticates as nothing, and the rig sits offline with no clue why.
    if ($RigToken.Trim() -eq $script:SampleToken) {
        throw (New-Refusal $script:ExitNotOneRig ("-RigToken is the sample token from agent.config.sample.json, not this rig's own.`n" +
            "Take this rig's token from the staff dashboard."))
    }
}

<#
Refuse, by name, the accounts that cannot work.

A task registered for SYSTEM or one of the service accounts runs in Windows
session 0. iRacing publishes its telemetry into a name Windows scopes to a single
sign-in session, so from there the agent gets the same "nothing to attach to" it
gets between customers - forever, on every machine installed that way.
#>
function Assert-RigUserCanSeeTheSim {
    param([string] $RigUser)

    if ([string]::IsNullOrWhiteSpace($RigUser)) {
        throw (New-Refusal $script:ExitNotOneRig '-RigUser is empty; it has to name the account that signs in at this rig.')
    }
    $account = $RigUser.Trim()
    $bare = $account.Split('\')[-1].Split('@')[0]
    $serviceAccounts = @('SYSTEM', 'LOCALSYSTEM', 'LOCAL SYSTEM', 'LOCALSERVICE', 'LOCAL SERVICE', 'NETWORKSERVICE', 'NETWORK SERVICE', 'NT AUTHORITY')
    if ($serviceAccounts -contains $bare.ToUpperInvariant()) {
        throw (New-Refusal $script:ExitNotOneRig ("-RigUser is $account, which runs in Windows session 0. iRacing's telemetry is named per`n" +
            "sign-in session, so an agent there can never see the simulator: the rig would heartbeat`n" +
            "all night, show online, and score nothing.`n" +
            "Use the account that signs in at this rig and runs iRacing."))
    }
}

<#
The identity file this machine will read. Only the fields that ARE this rig,
plus the simulated-laps switch stated off in writing; everything else is left to
the build, so a tuned default arrives with an update instead of being frozen at
whatever the first install typed.
#>
function New-RigConfigJson {
    param([string] $BackendBaseUrl, [string] $RigToken, [int] $RigNumber, [int] $IdleTimeoutSeconds = -1)

    $fields = [ordered]@{
        backendBaseUrl    = $BackendBaseUrl.Trim()
        rigToken          = $RigToken.Trim()
        rigNumber         = $RigNumber
        simulateTelemetry = $false
    }
    if ($IdleTimeoutSeconds -ge 0) { $fields['idleTimeoutSeconds'] = $IdleTimeoutSeconds }
    return ($fields | ConvertTo-Json)
}

<#
Copy the build over whatever is there, and leave this rig's identity alone.

Files the previous build left behind are removed, so the folder is the build it
claims to be, with agent.config.json as the single deliberate exception: it holds
the rig's token and number, it is written once at enrolment, and an update that
took it with the rest is the whole reason the agent's version stopped living in it.
#>
function Copy-AgentProgram {
    param([string] $Source, [string] $Destination)

    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }

    $sourceRoot = (Resolve-Path -LiteralPath $Source).Path
    $destRoot = (Resolve-Path -LiteralPath $Destination).Path
    $separator = [System.IO.Path]::DirectorySeparatorChar

    $relativeTo = {
        param([string] $Full, [string] $Root)
        return $Full.Substring($Root.Length).TrimStart([char]'\', [char]'/').Replace('\', '/')
    }

    $sourceFiles = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)) {
        $sourceFiles[(& $relativeTo $file.FullName $sourceRoot)] = $file.FullName
    }

    $copied = 0
    foreach ($relative in @($sourceFiles.Keys)) {
        $target = Join-Path $destRoot $relative.Replace('/', $separator)
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $sourceFiles[$relative] -Destination $target -Force
        $copied++
    }

    $removed = 0
    $preserved = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $destRoot -Recurse -File)) {
        $relative = & $relativeTo $file.FullName $destRoot
        if ($sourceFiles.ContainsKey($relative)) { continue }
        if ((Split-Path -Leaf $relative) -eq $script:ConfigFileName) {
            $preserved += $relative
            continue
        }
        Remove-Item -LiteralPath $file.FullName -Force
        $removed++
    }

    return [pscustomobject]@{ Copied = $copied; Removed = $removed; Preserved = @($preserved) }
}

<#
Work out what this run does to this machine, before anything is stopped or copied.

Deciding first is the point: a refusal must not have taken a scoring rig off the
air on its way to being refused, and whether a config is written is settled here
rather than at the moment of writing, so an update cannot drift into rewriting the
one file it has to leave alone.
#>
function Get-RigInstallPlan {
    param(
        [string] $SourceFolder,
        [string] $InstallRoot,
        [string] $DataRoot,
        [int]    $RigNumber,
        [string] $RigToken,
        [string] $BackendBaseUrl
    )

    Assert-AgentBuildFolder -Source $SourceFolder

    $enrolled = Get-EnrolledConfigPath -InstallRoot $InstallRoot -DataRoot $DataRoot
    $isEnrolment = $null -eq $enrolled
    $identityGiven = ($RigNumber -gt 0) -or
        -not [string]::IsNullOrWhiteSpace($RigToken) -or
        -not [string]::IsNullOrWhiteSpace($BackendBaseUrl)

    if ($isEnrolment) {
        Assert-RigIdentity -RigNumber $RigNumber -RigToken $RigToken -BackendBaseUrl $BackendBaseUrl
        # The data folder, never beside the executable: beside it is what an update
        # copies over the top of, and a rig's token has to outlive every build.
        $enrolled = Join-Path $DataRoot $script:ConfigFileName
    }
    elseif ($identityGiven) {
        throw (New-Refusal $script:ExitNotOneRig ("This computer is already enrolled ($enrolled), so an update takes no identity.`n" +
            "Re-typing a rig's number or token during an update is how two machines end up on one`n" +
            "token and half a night's laps go to the wrong customer.`n" +
            "To change this rig's identity, edit $enrolled on the machine itself."))
    }

    return [pscustomobject]@{
        IsEnrolment  = $isEnrolment
        SourceFolder = $SourceFolder
        InstallRoot  = $InstallRoot
        ConfigPath   = $enrolled
    }
}

<#
Carry the plan out: the build, and this rig's identity only if it has none yet.
#>
function Write-RigInstall {
    param([psobject] $Plan, [int] $RigNumber, [string] $RigToken, [string] $BackendBaseUrl, [int] $IdleTimeoutSeconds = -1)

    $copy = Copy-AgentProgram -Source $Plan.SourceFolder -Destination $Plan.InstallRoot

    if ($Plan.IsEnrolment) {
        $folder = Split-Path -Parent $Plan.ConfigPath
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
            New-Item -ItemType Directory -Path $folder -Force | Out-Null
        }
        $json = New-RigConfigJson -BackendBaseUrl $BackendBaseUrl -RigToken $RigToken `
            -RigNumber $RigNumber -IdleTimeoutSeconds $IdleTimeoutSeconds
        [System.IO.File]::WriteAllText($Plan.ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    }

    return $copy
}

<#
What the pre-flight simulator check just said, in the words the operator needs,
and whether this rig can be left as it is.

"iRacing is not running" is the ordinary answer at install time - nobody is sitting
at the machine - and must not read as a failure, or twenty-plus perfectly good
installs would each end in a red line. The two that must fail are an agent that
cannot see the sim from where it was started and a telemetry format this build was
not written for: both leave a rig looking online and scoring nothing, and both are
install-time mistakes that get repeated across the room.
#>
function Get-SimCheckAdvice {
    param([int] $ExitCode)

    switch ($ExitCode) {
        0 { return [pscustomobject]@{ LeaveItAsItIs = $true;  Summary = 'This rig reads its simulator and can keep a lap from it.' } }
        3 { return [pscustomobject]@{ LeaveItAsItIs = $false; Summary = 'iRacing is running here but this rig cannot keep a lap from it - the channels the lap rules need are missing. Read logs\agent.log on this machine.' } }
        4 { return [pscustomobject]@{ LeaveItAsItIs = $true;  Summary = 'iRacing is not running here, which is the normal answer at a rig nobody is sitting at. Start iRacing and run OasisRigAgent.exe --check-sim once to confirm before opening.' } }
        5 { return [pscustomobject]@{ LeaveItAsItIs = $false; Summary = 'This agent cannot see iRacing from where Windows started it, so the rig would show online and score nothing. Check the logon task and the account it runs as.' } }
        6 { return [pscustomobject]@{ LeaveItAsItIs = $false; Summary = 'iRacing here publishes telemetry this agent was not written for. A newer agent build is the fix; this one cannot score on this machine.' } }
        default { return [pscustomobject]@{ LeaveItAsItIs = $false; Summary = "The simulator check answered $ExitCode, which this installer does not know. Run OasisRigAgent.exe --check-sim on the machine and read what it says." } }
    }
}

<#
What the pre-flight backend check just said, and whether this rig can be left as
it is.

The token is the only thing about an install that is typed by hand and cannot be
read back off the machine, and it is typed once per rig, twenty-plus times in an
evening. Nothing before this ever checked it: a mistyped one produced a computer
that queued every lap of the night and never appeared on /staff at all, which is
what an unplugged rig looks like too.

A backend that cannot be reached is deliberately not a failure here. Enrolment is
often done from a bench, or before the venue's network is up, and refusing on it
would stop an install that is completely correct - so it is reported and the rig
is left as it is. A refusal is the opposite: the backend answered, and no amount
of waiting changes its mind.
#>
function Get-BackendCheckAdvice {
    param([int] $ExitCode)

    switch ($ExitCode) {
        0 { return [pscustomobject]@{ LeaveItAsItIs = $true;  ExitCode = $script:ExitDone; Summary = 'The backend recognises this rig, so its laps will be scored.' } }
        1 { return [pscustomobject]@{ LeaveItAsItIs = $false; ExitCode = $script:ExitTokenRefused; Summary = 'The agent could not read this rig''s config, so its identity was never checked. Read logs\agent.log on this machine.' } }
        7 { return [pscustomobject]@{ LeaveItAsItIs = $true;  ExitCode = $script:ExitDone; Summary = 'The backend could not be reached from here, so this rig''s token has not been checked either way. Run OasisRigAgent.exe --check-backend once the machine is on the venue network.' } }
        8 { return [pscustomobject]@{ LeaveItAsItIs = $false; ExitCode = $script:ExitTokenRefused; Summary = 'The backend refused this rig''s token. Re-run this command with the token this rig was given - until then it will queue every lap and never appear on /staff.' } }
        9 { return [pscustomobject]@{ LeaveItAsItIs = $false; ExitCode = $script:ExitWrongRig; Summary = 'This token works, and it belongs to a different rig - so this is the install command for another machine, run here. Re-run it with THIS rig''s number and token; until then every lap driven at this computer would be credited to the other rig''s customer.' } }
        default { return [pscustomobject]@{ LeaveItAsItIs = $false; ExitCode = $script:ExitTokenRefused; Summary = "The backend check answered $ExitCode, which this installer does not know. Run OasisRigAgent.exe --check-backend on the machine and read what it says." } }
    }
}

<#
The build in an exe's own file properties, without .NET's "+<commit sha>" - the
number an operator reads standing at the rig, and the one the agent reports.
#>
function Get-BuildNumber {
    param([string] $Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return '' }
    return $Version.Split('+')[0].Trim()
}

function Resolve-SourceFolder {
    param([string] $Source, [string] $ScriptRoot)

    if (-not [string]::IsNullOrWhiteSpace($Source)) {
        if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
            throw (New-Refusal $script:ExitNotAnAgentBuild "There is no folder at $Source to install from.")
        }
        return (Resolve-Path -LiteralPath $Source).Path
    }

    foreach ($candidate in @($ScriptRoot, (Join-Path $ScriptRoot 'publish'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate $script:ExeName) -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw (New-Refusal $script:ExitNotAnAgentBuild ("Could not find $($script:ExeName) beside this script or in a 'publish' folder next to it.`n" +
        "Point -Source at the published build."))
}

# ---------------------------------------------------------------------------
# The Windows half.
# ---------------------------------------------------------------------------

<#
The build in the source folder's own executable - the number an operator reads
standing at the rig, and the one the agent reports.

Its own function because reading a file's version properties only answers on
Windows, which is what keeps the whole install runnable in a test on any machine.
#>
function Get-SourceBuild {
    param([string] $SourceFolder)
    return Get-BuildNumber (Get-Item -LiteralPath (Join-Path $SourceFolder $script:ExeName)).VersionInfo.ProductVersion
}

function Assert-RunningWhereTheRigSignsIn {
    if (-not $script:OnWindows) {
        throw (New-Refusal $script:ExitInstallFailed 'This installs the agent on a Windows simulator; run it on the rig itself.')
    }
    if ((Get-Process -Id $PID).SessionId -eq 0) {
        throw (New-Refusal $script:ExitInstallFailed ("This is running in Windows session 0, which is not the session the rig signs in to,`n" +
            "so the agent it installs could never read iRacing.`n" +
            "Sign in at the rig and run it from there."))
    }
}

function Stop-RigAgent {
    param([string] $TaskName, [string] $ExePath)

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    }
    # A copy over a running executable fails, and the operator would be told the
    # update landed. Stop it by the file that is about to be replaced, so a copy
    # somebody started by hand is caught too.
    $processName = [System.IO.Path]::GetFileNameWithoutExtension($script:ExeName)
    $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -eq $ExePath })
    foreach ($process in $running) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(15000) | Out-Null
    }
    return $running.Count
}

<#
Register the logon task, then read it back.

Registering it is not the same as it being right: a task inherited from an earlier
install, or one somebody made as a service, is exactly the configuration that stops
the room scoring, so the principal is checked after the fact rather than assumed
from the arguments just passed to it.
#>
function Install-RigTask {
    param([string] $TaskName, [string] $ExePath, [string] $RigUser)

    $action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory (Split-Path -Parent $ExePath)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $RigUser
    # Highest matches the documented install: iRacing is sometimes run elevated on a
    # rig, and a limited agent is refused its shared memory outright on those machines.
    $principal = New-ScheduledTaskPrincipal -UserId $RigUser -LogonType Interactive -RunLevel Highest
    # A rig runs unattended all day: no execution time limit to kill it mid-evening,
    # and a restart if it falls over rather than a dark machine until somebody looks.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null

    $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $registered) {
        throw (New-Refusal $script:ExitNotVerified ("The logon task '$TaskName' was registered but cannot be read back,`n" +
            "so nothing would start the agent when the rig signs in."))
    }
    if ($registered.Principal.LogonType -ne 'Interactive') {
        throw (New-Refusal $script:ExitNotVerified ("The task '$TaskName' is registered as $($registered.Principal.LogonType), not Interactive.`n" +
            "Anything else runs in Windows session 0, where iRacing's telemetry has no name and this`n" +
            "rig would show online all night while scoring nothing."))
    }
    return $registered
}

<#
Wait for the agent the logon task was just told to start to actually be running.

Started is not the same as running. The agent exits at once if it cannot find or
read this machine's config, and if another copy already holds the rig - and both
leave an operator looking at a console that said "Done" beside a rig that shows
offline on /staff, which is the one outcome a walk round twenty-plus machines
cannot afford.
#>
function Wait-ForRunningAgent {
    param([string] $ExePath, [int] $TimeoutSeconds = 30)

    $processName = [System.IO.Path]::GetFileNameWithoutExtension($script:ExeName)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path -eq $ExePath })
        if ($running.Count -gt 0) { return $running[0] }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Invoke-AgentCommand {
    param([string] $ExePath, [string] $Argument, [int] $TimeoutSeconds = 60)

    $out = [System.IO.Path]::GetTempFileName()
    $err = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $ExePath -ArgumentList $Argument -PassThru -NoNewWindow `
            -RedirectStandardOutput $out -RedirectStandardError $err
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw (New-Refusal $script:ExitNotVerified "$($script:ExeName) $Argument did not answer within $TimeoutSeconds seconds.")
        }
        # The parameterless wait is what flushes the redirected output and caches the
        # exit code; without it both can still be empty on the object.
        $process.WaitForExit()
        $text = [string](Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue) +
                [string](Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue)
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $text.Trim() }
    }
    finally {
        Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $err -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------

function Write-Step { param([string] $Message) Write-Host "  $Message" }

function Invoke-Main {
    Assert-RunningWhereTheRigSignsIn
    Assert-RigUserCanSeeTheSim -RigUser $RigUser

    $sourceFolder = Resolve-SourceFolder -Source $Source -ScriptRoot $PSScriptRoot

    $plan = Get-RigInstallPlan -SourceFolder $sourceFolder -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -RigNumber $RigNumber -RigToken $RigToken -BackendBaseUrl $BackendBaseUrl
    if ($plan.IsEnrolment) {
        Write-Host "Enrolling this computer as rig $RigNumber."
    }
    else {
        Write-Host "Updating the agent on this computer. Its identity in $($plan.ConfigPath) is left alone."
    }

    $exePath = Join-Path $InstallRoot $script:ExeName
    if ((Stop-RigAgent -TaskName $TaskName -ExePath $exePath) -gt 0) {
        Write-Step 'Stopped the agent that was running.'
    }

    $copy = Write-RigInstall -Plan $plan -RigNumber $RigNumber -RigToken $RigToken `
        -BackendBaseUrl $BackendBaseUrl -IdleTimeoutSeconds $IdleTimeoutSeconds
    $plural = if ($copy.Copied -eq 1) { '' } else { 's' }
    $alsoRemoved = if ($copy.Removed -gt 0) { ", and removed $($copy.Removed) left by the previous build" } else { '' }
    Write-Step "Copied $($copy.Copied) file$plural to $InstallRoot$alsoRemoved."
    foreach ($kept in $copy.Preserved) { Write-Step "Left $kept in place - it is this rig's identity." }

    if ($plan.IsEnrolment) {
        $tail = $RigToken.Trim()
        if ($tail.Length -gt 4) { $tail = $tail.Substring($tail.Length - 4) }
        Write-Step "Wrote $($plan.ConfigPath) - rig $RigNumber, token ending $tail."
    }

    $task = Install-RigTask -TaskName $TaskName -ExePath $exePath -RigUser $RigUser
    Write-Step "Registered '$TaskName' to start at logon as $($task.Principal.UserId), in the session the rig signs in to."

    $expectedBuild = Get-SourceBuild -SourceFolder $sourceFolder
    $reported = Invoke-AgentCommand -ExePath $exePath -Argument '--version' -TimeoutSeconds 30
    if ($reported.ExitCode -ne 0) {
        throw (New-Refusal $script:ExitNotVerified "The installed agent would not say which build it is (exit $($reported.ExitCode)): $($reported.Output)")
    }
    $installedBuild = ($reported.Output -split '/')[-1]
    if ($installedBuild -ne $expectedBuild) {
        throw (New-Refusal $script:ExitNotVerified ("This rig reports $($reported.Output) but the build being installed is $expectedBuild.`n" +
            "The copy did not land - check nothing is still holding $exePath - and /staff counts the`n" +
            "update round off what each rig reports, so this machine would be counted as done."))
    }
    Write-Step "The installed agent reports $($reported.Output)."

    Start-ScheduledTask -TaskName $TaskName | Out-Null
    $agent = Wait-ForRunningAgent -ExePath $exePath
    if (-not $agent) {
        throw (New-Refusal $script:ExitNotVerified ("The logon task started the agent and it stopped again, so this rig would show offline.`n" +
            "The usual causes are a config this machine cannot read, and another copy of the agent`n" +
            "already holding the rig. Read $(Join-Path $DataRoot 'logs\agent.log') - the agent names which."))
    }
    Write-Step "Started the agent (process $($agent.Id))."

    # Asked before the simulator check, because it is the answer to the question this
    # command was given: whether the identity typed on the command line is this rig's.
    # A rig that reads its sim perfectly and cannot be authenticated scores nothing.
    $backend = Get-BackendCheckAdvice -ExitCode (Invoke-AgentCommand -ExePath $exePath -Argument '--check-backend' -TimeoutSeconds 60).ExitCode
    if (-not $backend.LeaveItAsItIs) {
        Write-Host ''
        Write-Host "Installed, but this rig is not delivering laps. $($backend.Summary)"
        # The advice carries its own code: a token that is refused and a token that
        # belongs to the machine next door are fixed by different things, and an
        # installer that answered 7 for both would send somebody looking for a
        # mistyped secret that does not exist.
        return $backend.ExitCode
    }
    Write-Step $backend.Summary

    $advice = Get-SimCheckAdvice -ExitCode (Invoke-AgentCommand -ExePath $exePath -Argument '--check-sim' -TimeoutSeconds 60).ExitCode
    Write-Host ''
    if ($advice.LeaveItAsItIs) {
        Write-Host "Done. $($advice.Summary)"
        Write-Host 'Check this rig appears on /staff before opening.'
        return $script:ExitDone
    }

    Write-Host "Installed, but this rig will not score as it stands. $($advice.Summary)"
    return $script:ExitWillNotScore
}

# Dot-sourcing loads the rules for the tests without installing anything.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        exit (Invoke-Main)
    }
    catch {
        # Matched on the type's name rather than with `catch [RigInstallRefusal]`:
        # a catch clause's type is resolved when the file is parsed, and on Windows
        # PowerShell a class the same file defines is not there yet. Getting that
        # wrong would turn every refusal into the same "install failed" and exit 4,
        # which is the code an operator is told means something else entirely.
        $failure = $_.Exception
        if ($failure -and $failure.GetType().Name -eq 'RigInstallRefusal') {
            Write-Host ''
            Write-Host $failure.Message -ForegroundColor Red
            exit $failure.Code
        }
        Write-Host ''
        Write-Host "The install failed on this machine: $($failure.Message)" -ForegroundColor Red
        exit $script:ExitInstallFailed
    }
}
