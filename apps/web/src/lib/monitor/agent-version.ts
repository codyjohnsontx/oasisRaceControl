/**
 * The rig agent build every rig should be running: the default `AgentVersion`
 * in apps/rig-agent/OasisRigAgent.Core/AgentConfig.cs, which every heartbeat
 * reports. Rule 11 warns about a rig reporting anything else.
 *
 * It is a copy, because the web app cannot read the agent's source at run
 * time, and `agent-version.test.ts` fails whenever the two disagree - so a
 * change that bumps the agent's version bumps this in the same commit, and the
 * monitor starts asking for the new build the moment it deploys.
 */
export const CURRENT_AGENT_VERSION = "rig-agent/0.6-window";
