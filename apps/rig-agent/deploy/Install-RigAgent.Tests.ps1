#Requires -Version 5.1
<#
    The rules Install-RigAgent.ps1 applies, tested on any machine.

    These cover what the installer REFUSES and what it preserves, because it is run
    once per machine on twenty-plus machines and the mistakes it exists to prevent -
    a rig's identity travelling to the next computer, an update taking the token with
    the build, an agent started where it can never see the simulator - all produce a
    venue that looks healthy and scores the wrong laps, or none.

    The Windows half (registering the logon task, stopping a running agent, asking
    the installed exe which build it is) is proved against real Windows in
    .github/workflows/rig-agent.yml, where the task scheduler exists.

    Run:  pwsh -Command "Invoke-Pester apps/rig-agent/deploy -Output Detailed"
#>

BeforeAll {
    . (Join-Path $PSScriptRoot 'Install-RigAgent.ps1')

    function New-ScratchFolder {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ("oasis-install-" + [Guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }

    function New-PublishedBuild {
        param([string] $Root, [string] $Body = 'agent')
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $Root 'OasisRigAgent.exe') -Value $Body -NoNewline
        Set-Content -LiteralPath (Join-Path $Root 'OasisRigAgent.pdb') -Value 'symbols' -NoNewline
        return $Root
    }

    # The exception carries the exit code the operator's console will see, so the
    # tests assert the code rather than only the wording.
    function Get-Refusal {
        param([scriptblock] $Action)
        try { & $Action | Out-Null }
        catch { return $_.Exception }
        return $null
    }
}

Describe 'the folder being installed from' {
    It 'refuses a source that carries a rig identity, naming what it would do' {
        # The fastest way to set up the room is to copy a working rig's folder to the
        # next machine. agent.config.json travelling with it is how two simulators
        # become one rig, and every lap from either goes to one customer.
        $source = New-PublishedBuild (New-ScratchFolder)
        Set-Content -LiteralPath (Join-Path $source 'agent.config.json') -Value '{ "rigNumber": 1 }'

        $refusal = Get-Refusal { Assert-AgentBuildFolder -Source $source }

        $refusal | Should -Not -BeNullOrEmpty
        $refusal.Code | Should -Be 3
        $refusal.Message | Should -BeLike '*two simulators*'
        $refusal.Message | Should -BeLike '*one token*'
    }

    It 'refuses a folder with no agent in it' {
        $refusal = Get-Refusal { Assert-AgentBuildFolder -Source (New-ScratchFolder) }

        $refusal.Code | Should -Be 3
        $refusal.Message | Should -BeLike '*OasisRigAgent.exe*'
    }

    It 'refuses a folder that is not there' {
        $refusal = Get-Refusal { Assert-AgentBuildFolder -Source (Join-Path (New-ScratchFolder) 'nowhere') }

        $refusal.Code | Should -Be 3
    }

    It 'accepts a published build' {
        Get-Refusal { Assert-AgentBuildFolder -Source (New-PublishedBuild (New-ScratchFolder)) } | Should -BeNullOrEmpty
    }

    It 'finds the build beside the script, so the USB stick needs no arguments' {
        $stick = New-PublishedBuild (New-ScratchFolder)

        Resolve-SourceFolder -Source '' -ScriptRoot $stick | Should -Be (Resolve-Path -LiteralPath $stick).Path
    }

    It 'finds a publish folder next to the script' {
        $stick = New-ScratchFolder
        $publish = New-PublishedBuild (Join-Path $stick 'publish')

        Resolve-SourceFolder -Source '' -ScriptRoot $stick | Should -Be (Resolve-Path -LiteralPath $publish).Path
    }

    It 'says so rather than installing nothing when there is no build to find' {
        $refusal = Get-Refusal { Resolve-SourceFolder -Source '' -ScriptRoot (New-ScratchFolder) }

        $refusal.Code | Should -Be 3
        $refusal.Message | Should -BeLike '*-Source*'
    }
}

Describe 'whether this machine is already a rig' {
    It 'reads the config beside the executable first, as the agent does' {
        # AgentPaths prefers the config beside the exe. Reversing that order here
        # would enrol a machine that already has an identity and leave the agent
        # reading the old one.
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $install 'agent.config.json') -Value '{}'
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{}'

        Get-EnrolledConfigPath -InstallRoot $install -DataRoot $data |
            Should -Be (Join-Path $install 'agent.config.json')
    }

    It 'falls back to the data folder, where this installer writes it' {
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{}'

        Get-EnrolledConfigPath -InstallRoot $install -DataRoot $data |
            Should -Be (Join-Path $data 'agent.config.json')
    }

    It 'reports a machine with no identity anywhere' {
        Get-EnrolledConfigPath -InstallRoot (New-ScratchFolder) -DataRoot (New-ScratchFolder) | Should -BeNullOrEmpty
    }
}

Describe 'the identity a rig is enrolled with' {
    It 'names every missing piece at once, so the operator types the command twice at most' {
        $refusal = Get-Refusal { Assert-RigIdentity -RigNumber 0 -RigToken '' -BackendBaseUrl '' }

        $refusal.Code | Should -Be 2
        $refusal.Message | Should -BeLike '*-RigNumber*'
        $refusal.Message | Should -BeLike '*-RigToken*'
        $refusal.Message | Should -BeLike '*-BackendBaseUrl*'
    }

    It 'accepts the venue address' {
        Get-Refusal { Assert-RigIdentity -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'https://oasis-race-control.vercel.app' } |
            Should -BeNullOrEmpty
    }

    It 'refuses plain http, which the agent would refuse at every start' {
        # The token rides on every request. Catching it here costs a retype; catching
        # it at the agent costs a walk back to the machine.
        $refusal = Get-Refusal { Assert-RigIdentity -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'http://oasis-race-control.vercel.app' }

        $refusal.Code | Should -Be 2
        $refusal.Message | Should -BeLike '*https*'
    }

    It 'allows http for a local backend, as the agent does' {
        Get-Refusal { Assert-RigIdentity -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'http://localhost:3000' } |
            Should -BeNullOrEmpty
    }

    It 'refuses an address that is not one' {
        (Get-Refusal { Assert-RigIdentity -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'oasis-race-control.vercel.app' }).Code |
            Should -Be 2
    }

    It 'refuses the sample token, which authenticates as nothing' {
        $refusal = Get-Refusal { Assert-RigIdentity -RigNumber 3 -RigToken 'dev-rig-1-secret' -BackendBaseUrl 'https://oasis.example' }

        $refusal.Code | Should -Be 2
        $refusal.Message | Should -BeLike '*sample token*'
    }
}

Describe 'the account the agent is started as' {
    It 'refuses <account>, which runs in Windows session 0' -ForEach @(
        @{ account = 'SYSTEM' }
        @{ account = 'NT AUTHORITY\SYSTEM' }
        @{ account = 'NT AUTHORITY\LOCAL SERVICE' }
        @{ account = 'NT AUTHORITY\NETWORK SERVICE' }
        @{ account = 'LocalSystem' }
    ) {
        # iRacing's telemetry is named per sign-in session. An agent in session 0 gets
        # the same "nothing to attach to" it gets between customers, forever, and the
        # rig heartbeats all night while scoring nothing.
        $refusal = Get-Refusal { Assert-RigUserCanSeeTheSim -RigUser $account }

        $refusal | Should -Not -BeNullOrEmpty
        $refusal.Code | Should -Be 2
        $refusal.Message | Should -BeLike '*session 0*'
    }

    It 'accepts the account that signs in at the rig' {
        Get-Refusal { Assert-RigUserCanSeeTheSim -RigUser 'RIG-03\oasis' } | Should -BeNullOrEmpty
    }

    It 'refuses an empty account rather than registering a task for nobody' {
        (Get-Refusal { Assert-RigUserCanSeeTheSim -RigUser '  ' }).Code | Should -Be 2
    }
}

Describe 'the identity file written at enrolment' {
    It 'holds this rig and nothing that belongs to the build' {
        $config = New-RigConfigJson -BackendBaseUrl 'https://oasis.example' -RigToken 'r3-secret' -RigNumber 3 | ConvertFrom-Json

        $config.backendBaseUrl | Should -Be 'https://oasis.example'
        $config.rigToken | Should -Be 'r3-secret'
        $config.rigNumber | Should -Be 3
        $config.simulateTelemetry | Should -BeFalse
        # The version belongs to the running build; a number here would be frozen at
        # install and no update could change what /staff shows for this machine.
        $config.PSObject.Properties.Name | Should -Not -Contain 'agentVersion'
    }

    It 'leaves the sign-out period to the build unless the operator sets it' {
        # Written here, a default tuned during the pilot would never reach the rigs
        # already installed.
        (New-RigConfigJson -BackendBaseUrl 'https://oasis.example' -RigToken 'r3' -RigNumber 3 | ConvertFrom-Json).PSObject.Properties.Name |
            Should -Not -Contain 'idleTimeoutSeconds'
    }

    It 'writes the sign-out period when it is set, including the 0 that turns it off' {
        (New-RigConfigJson -BackendBaseUrl 'https://oasis.example' -RigToken 'r3' -RigNumber 3 -IdleTimeoutSeconds 0 | ConvertFrom-Json).idleTimeoutSeconds |
            Should -Be 0
        (New-RigConfigJson -BackendBaseUrl 'https://oasis.example' -RigToken 'r3' -RigNumber 3 -IdleTimeoutSeconds 900 | ConvertFrom-Json).idleTimeoutSeconds |
            Should -Be 900
    }

    It 'trims a token pasted with a stray space' {
        (New-RigConfigJson -BackendBaseUrl ' https://oasis.example ' -RigToken "  r3-secret`n" -RigNumber 3 | ConvertFrom-Json).rigToken |
            Should -Be 'r3-secret'
    }
}

Describe 'copying a build over a rig that is already running one' {
    It 'leaves the rig identity beside the executable exactly as it was' {
        # This is the property the whole update round rests on. agent.config.json is
        # this machine's token and number; a copy that took it with the build would
        # put the previous machine's identity here.
        $source = New-PublishedBuild (New-ScratchFolder) -Body 'new build'
        $install = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Value 'old build' -NoNewline
        $identity = '{ "rigNumber": 7, "rigToken": "r7-secret" }'
        Set-Content -LiteralPath (Join-Path $install 'agent.config.json') -Value $identity -NoNewline

        $result = Copy-AgentProgram -Source $source -Destination $install

        Get-Content -LiteralPath (Join-Path $install 'agent.config.json') -Raw | Should -Be $identity
        Get-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Raw | Should -Be 'new build'
        $result.Preserved | Should -Contain 'agent.config.json'
    }

    It 'removes what the previous build left behind, so the folder is the build it reports' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Value 'old' -NoNewline
        Set-Content -LiteralPath (Join-Path $install 'RetiredHelper.dll') -Value 'stale' -NoNewline

        $result = Copy-AgentProgram -Source $source -Destination $install

        Test-Path -LiteralPath (Join-Path $install 'RetiredHelper.dll') | Should -BeFalse
        $result.Removed | Should -Be 1
    }

    It 'copies the folders inside the build too' {
        $source = New-PublishedBuild (New-ScratchFolder)
        New-Item -ItemType Directory -Path (Join-Path $source 'runtimes') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path (Join-Path $source 'runtimes') 'native.dll') -Value 'native' -NoNewline
        $install = New-ScratchFolder

        Copy-AgentProgram -Source $source -Destination $install | Out-Null

        Get-Content -LiteralPath (Join-Path (Join-Path $install 'runtimes') 'native.dll') -Raw | Should -Be 'native'
    }

    It 'creates the program folder on a machine that has never had the agent' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = Join-Path (New-ScratchFolder) 'Oasis Race Control'

        $result = Copy-AgentProgram -Source $source -Destination $install

        Test-Path -LiteralPath (Join-Path $install 'OasisRigAgent.exe') | Should -BeTrue
        $result.Copied | Should -Be 2
        $result.Preserved | Should -BeNullOrEmpty
    }
}

Describe 'what the installer says after checking the simulator' {
    It 'treats a rig with no iRacing running as installed, not failed' {
        # Nobody is sitting at the machine when it is installed, so this is the answer
        # on almost every one of the twenty-plus. Reading it as a failure would end
        # every good install with a red line and teach the operator to ignore them.
        $advice = Get-SimCheckAdvice -ExitCode 4

        $advice.LeaveItAsItIs | Should -BeTrue
        $advice.Summary | Should -BeLike '*not running*'
    }

    It 'treats a rig reading its simulator as done' {
        (Get-SimCheckAdvice -ExitCode 0).LeaveItAsItIs | Should -BeTrue
    }

    It 'refuses to call an agent that cannot see the sim from where it was started done' {
        $advice = Get-SimCheckAdvice -ExitCode 5

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*score nothing*'
    }

    It 'refuses to call a telemetry format this build cannot read done' {
        $advice = Get-SimCheckAdvice -ExitCode 6

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*newer agent*'
    }

    It 'refuses to call a rig that cannot keep a lap done' {
        (Get-SimCheckAdvice -ExitCode 3).LeaveItAsItIs | Should -BeFalse
    }

    It 'refuses an answer it does not recognise rather than assuming it is fine' {
        # A future exit code must not read as success on twenty-plus machines.
        $advice = Get-SimCheckAdvice -ExitCode 42

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*42*'
    }
}

Describe 'what the installer says after checking this rig''s identity' {
    It 'treats a backend that recognises the rig as done' {
        (Get-BackendCheckAdvice -ExitCode 0).LeaveItAsItIs | Should -BeTrue
    }

    It 'refuses to call a rig the backend will not accept done' {
        # The whole reason the check was added. Reporting Done here is what leaves a
        # machine queueing every lap of the night and absent from /staff.
        $advice = Get-BackendCheckAdvice -ExitCode 8

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*refused*'
        $advice.Summary | Should -BeLike '*token this rig was given*'
    }

    It 'refuses to call a rig holding another rig''s token done' {
        # The install that looks perfect: the command was right and the machine was
        # wrong. Reporting Done sends the operator to the next rig, and every lap
        # driven at this one lands on the other rig's customer for the night.
        $advice = Get-BackendCheckAdvice -ExitCode 9

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*belongs to a different rig*'
        $advice.Summary | Should -BeLike '*THIS rig*'
    }

    It 'answers a wrong rig and a refused token with different exit codes' {
        # They are fixed by different things - one by retyping a secret, the other
        # by re-running the right command here - so an installer that collapsed them
        # would send somebody hunting a mistyped token that does not exist.
        (Get-BackendCheckAdvice -ExitCode 9).ExitCode |
            Should -Not -Be (Get-BackendCheckAdvice -ExitCode 8).ExitCode
    }

    It 'gives every passing answer the done code' {
        foreach ($code in 0, 7) {
            (Get-BackendCheckAdvice -ExitCode $code).ExitCode | Should -Be 0
        }
    }

    It 'does not fail an install just because the backend could not be reached' {
        # Enrolment happens on a bench and before the venue network is up. Refusing
        # here would stop installs that are completely correct, and the token has not
        # been judged either way - so it says so and leaves the rig alone.
        $advice = Get-BackendCheckAdvice -ExitCode 7

        $advice.LeaveItAsItIs | Should -BeTrue
        $advice.Summary | Should -BeLike '*not been checked*'
        $advice.Summary | Should -BeLike '*--check-backend*'
    }

    It 'refuses a rig whose config the agent could not read' {
        (Get-BackendCheckAdvice -ExitCode 1).LeaveItAsItIs | Should -BeFalse
    }

    It 'refuses an answer it does not recognise rather than assuming it is fine' {
        $advice = Get-BackendCheckAdvice -ExitCode 42

        $advice.LeaveItAsItIs | Should -BeFalse
        $advice.Summary | Should -BeLike '*42*'
    }

    It 'never reads a simulator answer as a backend one' {
        # Both checks are run by the same helper against the same exe, and their
        # codes deliberately do not overlap. If 4 ("no iRacing here", the ordinary
        # answer at an empty rig) ever read as a passing backend check, a mistyped
        # token would report Done on every machine in the room.
        foreach ($simCode in 3, 4, 5, 6) {
            (Get-BackendCheckAdvice -ExitCode $simCode).LeaveItAsItIs | Should -BeFalse
        }
        foreach ($backendCode in 7, 8, 9) {
            (Get-SimCheckAdvice -ExitCode $backendCode).LeaveItAsItIs | Should -BeFalse
        }
    }
}

Describe 'the build number an install is verified against' {
    It 'drops the commit .NET appends, which the agent drops too' {
        Get-BuildNumber '0.5.0+9f2c1ab3' | Should -Be '0.5.0'
    }

    It 'passes an ordinary version through' {
        Get-BuildNumber '0.5.0' | Should -Be '0.5.0'
    }

    It 'answers empty for a file with no version rather than throwing mid-install' {
        Get-BuildNumber $null | Should -Be ''
    }
}

Describe 'what a run decides to do to this machine' {
    It 'puts a new rig identity in the data folder, out of reach of the next update' {
        # Beside the executable is what an update copies over the top of. A token
        # written there survives only until the next build, and a rig that loses its
        # token stops scoring with nothing on screen to say why.
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $source = New-PublishedBuild (New-ScratchFolder)

        $plan = Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data `
            -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'https://oasis.example'

        $plan.IsEnrolment | Should -BeTrue
        $plan.ConfigPath | Should -Be (Join-Path $data 'agent.config.json')
    }

    It 'recognises a machine that is already a rig and keeps pointing at its own identity' {
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $source = New-PublishedBuild (New-ScratchFolder)
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'

        $plan = Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data

        $plan.IsEnrolment | Should -BeFalse
        $plan.ConfigPath | Should -Be (Join-Path $data 'agent.config.json')
    }

    It 'refuses an identity typed onto a machine that already has one' {
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $source = New-PublishedBuild (New-ScratchFolder)
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'

        $refusal = Get-Refusal {
            Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data `
                -RigNumber 4 -RigToken 'someone-elses-token' -BackendBaseUrl 'https://oasis.example'
        }

        $refusal.Code | Should -Be 2
        $refusal.Message | Should -BeLike '*already enrolled*'
    }

    It 'decides before it touches anything, so a refused command leaves a scoring rig alone' {
        # The agent is stopped between the decision and the copy. A refusal that came
        # later would have taken a working rig off the air on its way to saying no.
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Value 'the build that is scoring' -NoNewline
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'
        $source = New-PublishedBuild (New-ScratchFolder) -Body 'a build that will not be installed'

        Get-Refusal {
            Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data -RigNumber 4
        } | Should -Not -BeNullOrEmpty

        Get-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Raw | Should -Be 'the build that is scoring'
    }
}

Describe 'carrying out a plan' {
    It 'writes this rig identity once, at enrolment' {
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $source = New-PublishedBuild (New-ScratchFolder)
        $plan = Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data `
            -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'https://oasis.example'

        Write-RigInstall -Plan $plan -RigNumber 3 -RigToken 'r3-secret' -BackendBaseUrl 'https://oasis.example' | Out-Null

        $written = Get-Content -LiteralPath $plan.ConfigPath -Raw | ConvertFrom-Json
        $written.rigNumber | Should -Be 3
        $written.rigToken | Should -Be 'r3-secret'
        # No BOM: the file is read by .NET, by an operator, and by whatever they open it in.
        [System.IO.File]::ReadAllBytes($plan.ConfigPath)[0] | Should -Be ([byte][char]'{')
    }

    It 'writes no identity on an update, wherever this rig keeps its own' {
        # The single property the whole update round rests on, at the level that
        # decides it rather than at the level that copies files.
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $source = New-PublishedBuild (New-ScratchFolder) -Body 'the new build'
        $identity = '{ "rigNumber": 7, "rigToken": "r7-secret" }'
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value $identity -NoNewline

        $plan = Get-RigInstallPlan -SourceFolder $source -InstallRoot $install -DataRoot $data
        Write-RigInstall -Plan $plan -RigNumber 0 -RigToken '' -BackendBaseUrl '' | Out-Null

        Get-Content -LiteralPath (Join-Path $data 'agent.config.json') -Raw | Should -Be $identity
        Test-Path -LiteralPath (Join-Path $install 'agent.config.json') | Should -BeFalse
        Get-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Raw | Should -Be 'the new build'
    }

    It 'enrols a machine and then updates it without disturbing what it was told it is' {
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $first = New-PublishedBuild (New-ScratchFolder) -Body 'build 0.5.0'

        $enrol = Get-RigInstallPlan -SourceFolder $first -InstallRoot $install -DataRoot $data `
            -RigNumber 12 -RigToken 'r12-secret' -BackendBaseUrl 'https://oasis.example'
        Write-RigInstall -Plan $enrol -RigNumber 12 -RigToken 'r12-secret' -BackendBaseUrl 'https://oasis.example' | Out-Null
        $identityAfterEnrolment = Get-Content -LiteralPath $enrol.ConfigPath -Raw

        $second = New-PublishedBuild (New-ScratchFolder) -Body 'build 0.6.0'
        $update = Get-RigInstallPlan -SourceFolder $second -InstallRoot $install -DataRoot $data
        Write-RigInstall -Plan $update -RigNumber 0 -RigToken '' -BackendBaseUrl '' | Out-Null

        $update.IsEnrolment | Should -BeFalse
        Get-Content -LiteralPath $enrol.ConfigPath -Raw | Should -Be $identityAfterEnrolment
        Get-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Raw | Should -Be 'build 0.6.0'
    }
}

Describe 'the whole command, run against a machine' {
    # Invoke-Main is what an operator actually runs, and the parts of it that only
    # exist on Windows - the logon task, stopping the agent, asking the installed
    # exe which build it is - are stood in for here so the ORDER and the verdict
    # can be checked on any machine. The real ones are exercised against real
    # Windows in .github/workflows/rig-agent.yml.
    BeforeAll {
        function Invoke-InstallCommand {
            param([hashtable] $Arguments, [hashtable] $Machine)

            & {
                . (Join-Path $PSScriptRoot 'Install-RigAgent.ps1') @Arguments

                $script:Journal = $Machine.Journal
                $script:Machine = $Machine

                function Assert-RunningWhereTheRigSignsIn { }
                function Stop-RigAgent {
                    param([string] $TaskName, [string] $ExePath)
                    # What the rig was running at the moment it was stopped, so a copy
                    # that happened first is visible rather than only its consequence.
                    $onDisk = if (Test-Path -LiteralPath $ExePath) { Get-Content -LiteralPath $ExePath -Raw } else { '(nothing installed)' }
                    $script:Journal.Add("stopped:$onDisk") | Out-Null
                    return 1
                }
                function Install-RigTask {
                    param([string] $TaskName, [string] $ExePath, [string] $RigUser)
                    $script:Journal.Add("task:$RigUser") | Out-Null
                    return [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = $RigUser } }
                }
                function Get-SourceBuild { param([string] $SourceFolder) return $script:Machine.SourceBuild }
                function Start-ScheduledTask { param([string] $TaskName) $script:Journal.Add('started') | Out-Null }
                function Wait-ForRunningAgent {
                    param([string] $ExePath, [int] $TimeoutSeconds = 30)
                    if (-not $script:Machine.AgentStaysUp) { return $null }
                    return [pscustomobject]@{ Id = 4242 }
                }
                function Invoke-AgentCommand {
                    param([string] $ExePath, [string] $Argument, [int] $TimeoutSeconds = 60)
                    $script:Journal.Add("ran:$Argument") | Out-Null
                    if ($Argument -eq '--version') {
                        return [pscustomobject]@{ ExitCode = 0; Output = "oasis-rig-agent/$($script:Machine.ReportedBuild)" }
                    }
                    if ($Argument -eq '--check-backend') {
                        return [pscustomobject]@{ ExitCode = $script:Machine.BackendCheckExit; Output = '' }
                    }
                    return [pscustomobject]@{ ExitCode = $script:Machine.SimCheckExit; Output = '' }
                }

                try { return Invoke-Main }
                catch {
                    if ($_.Exception -and $_.Exception.GetType().Name -eq 'RigInstallRefusal') { return $_.Exception.Code }
                    throw
                }
            }
        }

        function New-Machine {
            param(
                [string] $SourceBuild = '0.6.0',
                [string] $ReportedBuild = '0.6.0',
                [int] $SimCheckExit = 4,
                # Accepted by default: the ordinary answer at a rig enrolled with the
                # token it was given, which is what every other case is measured against.
                [int] $BackendCheckExit = 0,
                [bool] $AgentStaysUp = $true)
            return @{
                Journal = [System.Collections.ArrayList]::new()
                SourceBuild = $SourceBuild
                ReportedBuild = $ReportedBuild
                SimCheckExit = $SimCheckExit
                BackendCheckExit = $BackendCheckExit
                AgentStaysUp = $AgentStaysUp
            }
        }
    }

    It 'enrols an untouched computer: the build lands, the identity is written, and it reports done' {
        $source = New-PublishedBuild (New-ScratchFolder) -Body 'build 0.6.0'
        $install = Join-Path (New-ScratchFolder) 'Oasis Race Control'
        $data = Join-Path (New-ScratchFolder) 'OasisRaceControl'
        $machine = New-Machine

        $code = Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-03\oasis'
            RigNumber = 3; RigToken = 'r3-secret'; BackendBaseUrl = 'https://oasis.example'
        }

        $code | Should -Be 0
        Get-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Raw | Should -Be 'build 0.6.0'
        (Get-Content -LiteralPath (Join-Path $data 'agent.config.json') -Raw | ConvertFrom-Json).rigNumber | Should -Be 3
        $machine.Journal | Should -Contain 'task:RIG-03\oasis'
        $machine.Journal | Should -Contain 'stopped:(nothing installed)'
    }

    It 'stops the agent before replacing the file it is running from' {
        # A copy over a running executable fails on Windows, so an installer that
        # copied first would leave the rig on its old build and then report the new
        # one - the machine gets counted as updated and is not.
        $source = New-PublishedBuild (New-ScratchFolder) -Body 'build 0.6.0'
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $install 'OasisRigAgent.exe') -Value 'build 0.5.0' -NoNewline
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'
        $machine = New-Machine

        Invoke-InstallCommand -Machine $machine -Arguments @{ Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-07\oasis' } | Out-Null

        $machine.Journal | Should -Contain 'stopped:build 0.5.0'
        $machine.Journal.IndexOf('ran:--version') | Should -BeLessThan $machine.Journal.IndexOf('started')
    }

    It 'refuses to report done on a rig the backend will not accept' {
        # A mistyped token is the one enrolment mistake nothing could catch: the rig
        # installs perfectly, starts, reports the right build, and then queues every
        # lap of the night into its own outbox while /staff shows nothing at all.
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $machine = New-Machine -BackendCheckExit 8

        $code = Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-03\oasis'
            RigNumber = 3; RigToken = 'r3-secert'; BackendBaseUrl = 'https://oasis.example'
        }

        $code | Should -Be 7
        # And it stopped there: a rig that cannot be authenticated is not left to
        # pass or fail on whether iRacing happened to be open at install time.
        $machine.Journal | Should -Not -Contain 'ran:--check-sim'
    }

    It 'refuses to report done on a rig holding another rig''s token' {
        # The enrolment mistake with nothing wrong in it: the command was correct,
        # and it was run at the machine next door. Everything installs, the agent
        # starts, the token authenticates - and every lap driven here would be
        # credited to the other rig's customer.
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $machine = New-Machine -BackendCheckExit 9

        $code = Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-04\oasis'
            RigNumber = 4; RigToken = 'the-token-for-rig-7'; BackendBaseUrl = 'https://oasis.example'
        }

        # Its own code, not the refused-token one: the two are fixed by different
        # things and an operator branches on this number.
        $code | Should -Be 8
        $machine.Journal | Should -Not -Contain 'ran:--check-sim'
    }

    It 'reports done when the backend cannot be reached from the bench' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $machine = New-Machine -BackendCheckExit 7

        $code = Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-03\oasis'
            RigNumber = 3; RigToken = 'r3-secret'; BackendBaseUrl = 'https://oasis.example'
        }

        $code | Should -Be 0
        $machine.Journal | Should -Contain 'ran:--check-sim'
    }

    It 'checks the identity it was given before it checks the simulator' {
        # A rig that reads its sim perfectly and cannot be authenticated scores
        # nothing, so the answer to the question this command was given comes first.
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $machine = New-Machine

        Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-03\oasis'
            RigNumber = 3; RigToken = 'r3-secret'; BackendBaseUrl = 'https://oasis.example'
        } | Out-Null

        # Asserted present first: IndexOf answers -1 for a command that never ran,
        # which is less than any real position, so the ordering alone would pass on
        # an installer that does not check the identity at all.
        $machine.Journal | Should -Contain 'ran:--check-backend'
        $machine.Journal | Should -Contain 'ran:--check-sim'
        $machine.Journal.IndexOf('ran:--check-backend') | Should -BeLessThan $machine.Journal.IndexOf('ran:--check-sim')
    }

    It 'refuses to call a rig done when it reports a build that is not the one installed' {
        # The copy silently failing is how a machine gets counted as updated on
        # /staff while still running the build that cannot score.
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'

        $code = Invoke-InstallCommand -Machine (New-Machine -SourceBuild '0.6.0' -ReportedBuild '0.5.0') -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-07\oasis'
        }

        $code | Should -Be 5
    }

    It 'refuses to call a rig done when the agent it started stopped again' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'

        $code = Invoke-InstallCommand -Machine (New-Machine -AgentStaysUp $false) -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-07\oasis'
        }

        $code | Should -Be 5
    }

    It 'says the rig will not score when the simulator check says it cannot see the sim' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        Set-Content -LiteralPath (Join-Path $data 'agent.config.json') -Value '{ "rigNumber": 7 }'

        $code = Invoke-InstallCommand -Machine (New-Machine -SimCheckExit 5) -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-07\oasis'
        }

        $code | Should -Be 6
    }

    It 'refuses an unenrolled machine with no identity before it stops or copies anything' {
        $source = New-PublishedBuild (New-ScratchFolder)
        $install = New-ScratchFolder
        $data = New-ScratchFolder
        $machine = New-Machine

        $code = Invoke-InstallCommand -Machine $machine -Arguments @{
            Source = $source; InstallRoot = $install; DataRoot = $data; RigUser = 'RIG-09\oasis'
        }

        $code | Should -Be 2
        @($machine.Journal | Where-Object { $_ -like 'stopped:*' }).Count | Should -Be 0
        Test-Path -LiteralPath (Join-Path $install 'OasisRigAgent.exe') | Should -BeFalse
    }
}
