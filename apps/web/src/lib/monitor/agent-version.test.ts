import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_AGENT_VERSION } from "./agent-version";

const AGENT_CONFIG = join(
  __dirname,
  "..", "..", "..", "..",
  "rig-agent", "OasisRigAgent.Core", "AgentConfig.cs",
);

/** The default the agent reports on every heartbeat, read from its source. */
function agentVersionInSource(source: string): string | null {
  return source.match(/public string AgentVersion\s*\{\s*get;\s*init;\s*\}\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

describe("CURRENT_AGENT_VERSION", () => {
  it("is the version AgentConfig.cs reports, so rule 11 asks for the build that ships", () => {
    const version = agentVersionInSource(readFileSync(AGENT_CONFIG, "utf8"));
    expect(version, "AgentVersion's default not found in AgentConfig.cs").not.toBeNull();
    expect(CURRENT_AGENT_VERSION).toBe(version);
  });

  it("reads the default from the property, whatever else the file says", () => {
    const source = `
      /// <summary>was "rig-agent/0.3-event"</summary>
      public string AgentVersion { get; init; } = "rig-agent/9.9-next";`;
    expect(agentVersionInSource(source)).toBe("rig-agent/9.9-next");
    expect(agentVersionInSource("public string Other { get; init; } = \"x\";")).toBeNull();
  });
});
