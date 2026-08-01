import { z } from "zod";
import { isUniqueViolation, query, queryOne } from "@/lib/db";
import { ensureOpenSeason, getOpenRound } from "@/lib/league-queries";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import { venueToday } from "@/lib/venue";

const body = z.object({
  trackName: z.string().trim().min(1).max(120),
  trackConfig: z.string().trim().max(120).nullish(),
  carName: z.string().trim().min(1).max(120),
  name: z.string().trim().max(80).nullish(),
  incidentLimit: z.number().int().min(0).max(99).default(0),
});

/**
 * Open tonight's league round against a chosen combo.
 *
 * Side effect worth knowing about: this also sets today's featured combo to
 * the round's combo. Lap validity (src/lib/validity.ts) is judged against the
 * featured combo at ingestion time, so without this a league round on a
 * different combo than the day's featured one would mark every league lap
 * invalid. Laps already logged today keep the validity they were given.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const alreadyOpen = await getOpenRound();
  if (alreadyOpen) {
    return Response.json(
      { error: "round_already_open", roundId: alreadyOpen.id },
      { status: 409 },
    );
  }

  const trackConfig = input.trackConfig?.trim() ? input.trackConfig.trim() : null;

  try {
    const season = await ensureOpenSeason();

    const round = await queryOne<{ id: string; round_number: number }>(
      `insert into league_rounds
         (season_id, round_number, name, track_name, track_config, car_name, incident_limit)
       select $1,
              coalesce(max(round_number), 0) + 1,
              $2, $3, $4, $5, $6
       from league_rounds where season_id = $1
       returning id, round_number`,
      [season.id, input.name?.trim() || null, input.trackName, trackConfig, input.carName, input.incidentLimit],
    );
    if (!round) return Response.json({ error: "server_error" }, { status: 500 });

    await query(
      `insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
       values ($1, $2, $3, $4, $5)
       on conflict (combo_date) do update
         set track_name = excluded.track_name,
             track_config = excluded.track_config,
             car_name = excluded.car_name,
             incident_limit = excluded.incident_limit`,
      [venueToday(), input.trackName, trackConfig, input.carName, input.incidentLimit],
    );

    await writeAudit({
      staffUserId: staff.userId,
      action: "open_league_round",
      targetType: "league_round",
      targetId: round.id,
      detail: {
        seasonId: season.id,
        roundNumber: round.round_number,
        trackName: input.trackName,
        trackConfig,
        carName: input.carName,
        incidentLimit: input.incidentLimit,
      },
    });

    return Response.json({ roundId: round.id, roundNumber: round.round_number });
  } catch (error) {
    // Two staff opening a round at the same moment: one_open_round_venue_wide
    // rejects the loser rather than leaving laps ambiguous.
    if (isUniqueViolation(error)) {
      return Response.json({ error: "round_already_open" }, { status: 409 });
    }
    console.error("[staff/league/open-round] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
