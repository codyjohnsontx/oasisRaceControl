import { listBoards } from "@/lib/leaderboards-queries";
import { getDriverSession } from "@/lib/driver-session";
import { Leaderboards } from "@/components/leaderboards";

/** Public leaderboards browser. Anyone can open it (like /tv); if a driver is
 *  signed in we pass their id so the client can highlight their own row. */
export default async function LeaderboardsPage() {
  const [boards, session] = await Promise.all([listBoards(), getDriverSession()]);
  return <Leaderboards boards={boards} viewerDriverId={session?.driverId ?? null} />;
}
