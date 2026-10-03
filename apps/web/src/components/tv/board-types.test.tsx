import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { venueToday } from "@/lib/venue";
import { SESSION_STATE } from "@/lib/events";
import type { LiveRaceView } from "@/components/use-live-race";
import { liveRaceFeed, liveRaceRow } from "@/test/live-race-fixture";
import type { RoundResult } from "@/lib/league";
import { TV_BOARD_TYPES, buildRotation } from "./board-types";
import { SLOT_COUNT } from "./arcade-board";

const liveRace = vi.hoisted(() => ({
  view: { race: null, finished: false, moves: new Map(), stale: false } as LiveRaceView,
  asked: [] as boolean[],
}));
vi.mock("@/components/use-live-race", () => ({
  useLiveRace: (active: boolean) => {
    liveRace.asked.push(active);
    return liveRace.view;
  },
}));

/**
 * The two rotation lists. The event view is one slide - the tonight board
 * asked for everyone - and the venue's rotation is exactly what it was before
 * the event view existed, so the wall in the shop cannot have changed under a
 * laptop feature.
 */

const boards = [
  { track_name: "Circuit of the Americas", track_config: "Grand Prix", driver_count: 24, lap_count: 47 },
  { track_name: "Spa-Francorchamps", track_config: null, driver_count: 3, lap_count: 9 },
];

describe("buildRotation", () => {
  it("event view is the tonight board with everyone on it, and nothing else", () => {
    const slides = buildRotation(boards, "event");
    expect(slides).toEqual([{ key: "event", kind: "tonight", spec: { everyone: true } }]);
  });

  it("the venue rotation is league, tonight (top slots), then every track, in order", () => {
    const slides = buildRotation(boards);
    expect(slides.map((s) => s.key)).toEqual([
      "league",
      "tonight",
      "track:Circuit of the Americas|Grand Prix",
      "track:Spa-Francorchamps|",
    ]);
    expect(slides[1].spec).toEqual({ everyone: false });
    expect(buildRotation(boards, "rotation")).toEqual(slides);
  });

  it("every slide names a registered board type", () => {
    for (const mode of ["rotation", "event"] as const) {
      for (const slide of buildRotation(boards, mode)) {
        expect(TV_BOARD_TYPES[slide.kind]?.kind).toBe(slide.kind);
      }
    }
  });
});

/**
 * The off-track mark. The tonight feed says how many incidents each shown lap
 * had; a lap with any gets an asterisk after its time, and nothing else on the
 * board explains it - the owner wanted the mark alone, no legend.
 */
const tonight = TV_BOARD_TYPES.tonight;
const combo = { track_name: "Spa-Francorchamps", track_config: "Grand Prix Pits", car_name: "Porsche 911 GT3 R" };
const row = (n: number, incident_delta: number | null) => ({
  driver_id: `d${n}`,
  display_name: `Driver ${n}`,
  lap_time_ms: 130_000 + n * 500,
  car_name: combo.car_name,
  incident_delta,
});
const asterisksIn = (html: string) => (html.match(/data-tv-asterisk/g) ?? []).length;

/**
 * What the tonight board asks the feed for. The event view promises every
 * driver of the day, so it asks for all of them - it once asked for a
 * 200-row ceiling and the 201st driver vanished while the board still read
 * "200 drivers". The rotation's slide makes the request it always has.
 */
describe("tonight board feed request", () => {
  afterEach(() => vi.unstubAllGlobals());

  const requestedUrl = async (everyone: boolean) => {
    const fetch = vi.fn(async () => Response.json({ rows: [row(1, 0)], combo }));
    vi.stubGlobal("fetch", fetch);
    await tonight.load({ everyone }, new AbortController().signal);
    return (fetch.mock.calls[0] as unknown[])[0];
  };

  it("the event view asks for every driver of the day", async () => {
    expect(await requestedUrl(true)).toBe("/api/leaderboard/tonight?limit=all");
  });

  it("the rotation's slide asks with no limit, as it always has", async () => {
    expect(await requestedUrl(false)).toBe("/api/leaderboard/tonight");
  });
});

describe("tonight board off-track mark", () => {
  it("marks the lap with an incident, not a clean lap or one with no count", () => {
    const data = { rows: [row(1, 0), row(2, 2), row(3, null)], combo };
    const html = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: true }} data={data} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(html)).toBe(1);
    const mark = html.indexOf("data-tv-asterisk");
    expect(mark).toBeGreaterThan(html.indexOf("Driver 2"));
    expect(mark).toBeLessThan(html.indexOf("Driver 3"));
  });

  it("marks on the wall's ten slots too, and draws no legend for it", () => {
    // An incident lap below the rotation's cut is not on screen there; in the
    // event view, which shows everyone, it is.
    const rows = Array.from({ length: SLOT_COUNT + 1 }, (_, i) => row(i + 1, i === SLOT_COUNT ? 3 : 0));
    const slots = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: false }} data={{ rows, combo }} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(slots)).toBe(0);
    const everyone = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: true }} data={{ rows, combo }} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(everyone)).toBe(1);
    // No visible legend for the mark, on either layout.
    expect(everyone).not.toContain("* lap");
    expect(slots).not.toContain("* lap");
  });
});

/**
 * League night's screens. While tonight's round is open the league board is
 * the round's qualifying ranking, read from the round endpoint the phone's
 * round page reads; on every other day it is the season standings and asks
 * for nothing else. What the race screen draws is `race-board.test.tsx`; its
 * header, which this board builds, is pinned here.
 */
describe("league board on league night", () => {
  afterEach(() => vi.unstubAllGlobals());

  const league = TV_BOARD_TYPES.league;
  const season = { id: "s1", name: "October 2026", league_name: "Wednesday Night League" };
  const round = (round_date: string, closed_at: string | null = null) => ({
    id: "11111111-1111-4111-8111-111111111111",
    season_id: "s1",
    season_name: season.name,
    league_name: season.league_name,
    round_number: 1,
    name: null,
    round_date,
    track_name: "Spa-Francorchamps",
    track_config: "Grand Prix Pits",
    car_name: "Porsche 911 GT3 R",
    incident_limit: 99,
    opened_at: "2026-10-01T23:00:00Z",
    closed_at,
  });
  /** A row of a round with no race result: placed, and qualified, by best lap. */
  function result(
    driver_id: string,
    display_name: string,
    position: number | null,
    best_lap_ms: number | null,
    extra: Partial<RoundResult> = {},
  ): RoundResult {
    return {
      round_id: "r1",
      round_number: 1,
      driver_id,
      display_name,
      position,
      best_lap_ms,
      lap_count: 3,
      valid_lap_count: 3,
      raced: false,
      qualifying_lap_ms: best_lap_ms,
      qualifying_position: position,
      qualifying_lap_count: 3,
      finish_source: null,
      ...extra,
    };
  }
  const field = [
    result("d1", "Jordan R.", 1, 137_683, { lap_count: 7, valid_lap_count: 7, qualifying_lap_count: 7 }),
    result("d2", "Cody J.", 2, 137_879, { lap_count: 6, valid_lap_count: 5, qualifying_lap_count: 6 }),
    result("d3", "Alexis M.", null, null, { lap_count: 1, valid_lap_count: 0, qualifying_lap_count: 1 }),
  ];
  const standing = {
    driver_id: "d1",
    display_name: "Jordan R.",
    points: 5,
    rounds_entered: 1,
    wins: 1,
    best_position: 1,
    rounds: [],
  };

  const stubFeeds = (rounds: ReturnType<typeof round>[]) => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith("/api/league/rounds/")
        ? Response.json({ round: rounds[0], field, laps: null })
        : Response.json({ season, rounds, standings: [standing] }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("reads tonight's round field while the round is open, and only the season otherwise", async () => {
    const tonight = stubFeeds([round(venueToday())]);
    const data = await league.load(null, new AbortController().signal);
    expect(tonight.mock.calls.map((call) => call[0])).toEqual([
      "/api/league/season",
      `/api/league/rounds/${round("").id}`,
    ]);
    expect((data as { qualifying: unknown }).qualifying).toMatchObject({ field });

    const closed = stubFeeds([round(venueToday(), "2026-10-02T03:00:00Z")]);
    const rest = await league.load(null, new AbortController().signal);
    expect(closed.mock.calls).toHaveLength(1);
    expect((rest as { qualifying: unknown }).qualifying).toBeNull();
  });

  it("shows the round as qualifying while it is open, ranked by best lap, and the standings otherwise", () => {
    const tonight = { season, rounds: [round(venueToday())], standings: [standing], qualifying: { round: round(venueToday()), field } };
    const html = renderToStaticMarkup(
      <league.Board spec={null} data={tonight} stale={false} hold={() => {}} />,
    );
    expect(html).toContain("Round 1 · Qualifying · live");
    // Under the title the track alone, as on the race screen (the owner, 2026-10-02).
    expect(html).toContain(">Spa-Francorchamps</p>");
    for (const absent of ["Grand Prix Pits", "Porsche 911 GT3 R", "drivers"]) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain("Best lap");
    expect(html.indexOf("Jordan R.")).toBeLessThan(html.indexOf("Cody J."));
    expect(html).toContain("2:17.683");
    expect(html).toContain("+0.196");
    // A driver with no valid lap yet is in the field with no time.
    expect(html).toContain("Alexis M.");
    expect(html).not.toContain("Season standings");

    const ordinary = { ...tonight, qualifying: null, rounds: [round("2026-09-24", "2026-09-25T03:00:00Z")] };
    const standings = renderToStaticMarkup(
      <league.Board spec={null} data={ordinary} stale={false} hold={() => {}} />,
    );
    expect(standings).toContain("Season standings");
    expect(standings).toContain("Points");
    expect(standings).not.toContain("Qualifying");
  });

  it("shows every qualifying driver, in two halves once the field is past ten", () => {
    const entrant = (n: number) => result(`q${n}`, `Qualifier ${n}`, n, 137_000 + n * 100);
    const render = (size: number) => {
      const field = Array.from({ length: size }, (_, i) => entrant(i + 1));
      const data = { season, rounds: [round(venueToday())], standings: [standing], qualifying: { round: round(venueToday()), field } };
      return renderToStaticMarkup(<league.Board spec={null} data={data} stale={false} hold={() => {}} />);
    };
    const lists = (html: string) => html.match(/<ol[\s\S]*?<\/ol>/g) ?? [];
    const ranks = (list = "") =>
      [...list.matchAll(/tabular-nums[^>]*>(\d+)</g)].map((match) => Number(match[1]));

    const eighteen = lists(render(18));
    expect(eighteen).toHaveLength(2);
    expect(ranks(eighteen[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ranks(eighteen[1])).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    for (let n = 1; n <= 18; n++) {
      expect(eighteen[n <= 9 ? 0 : 1]).toContain(`>Qualifier ${n}<`);
    }
    // The gap is still to the overall leader in the second half.
    expect(eighteen[1]).toContain("+1.700");
    expect(eighteen[1]).not.toContain("· · · · ·");

    // A field the arcade table holds keeps the approved single table of ten slots.
    const two = lists(render(2));
    expect(two).toHaveLength(1);
    expect(ranks(two[0])).toHaveLength(SLOT_COUNT);
    expect(two[0]).toContain("· · · · ·");
  });

  it("ranks qualifying by qualifying laps after the race has placed the round", () => {
    // The race finished Cody, Alexis, Jordan, and Cody's race lap beat every
    // qualifying lap; qualifying was Jordan, then Alexis, and Cody set no clean
    // lap before the start. Jordan drove 3 laps in qualifying, then a 20-lap race.
    const raced = { raced: true, finish_source: "flag" as const };
    const placed = [
      result("d2", "Cody J.", 1, 136_900, { ...raced, qualifying_lap_ms: null, qualifying_position: null }),
      result("d3", "Alexis M.", 2, 137_300, { ...raced, qualifying_lap_ms: 137_900, qualifying_position: 2 }),
      result("d1", "Jordan R.", 3, 137_500, {
        ...raced,
        qualifying_lap_ms: 137_683,
        qualifying_position: 1,
        lap_count: 23,
        qualifying_lap_count: 3,
      }),
    ];
    const data = { season, rounds: [round(venueToday())], standings: [standing], qualifying: { round: round(venueToday()), field: placed } };
    const html = renderToStaticMarkup(<league.Board spec={null} data={data} stale={false} hold={() => {}} />);
    const rows = html.match(/<li[\s\S]*?<\/li>/g) ?? [];
    expect(rows[0]).toContain(">Jordan R.<");
    expect(rows[0]).toContain("2:17.683");
    expect(rows[0]).toContain(">3 laps<");
    expect(html).not.toContain("23 laps");
    expect(rows[1]).toContain(">Alexis M.<");
    expect(rows[1]).toContain("2:17.900");
    expect(rows[1]).toContain("+0.217");
    expect(rows[2]).toContain(">Cody J.<");
    expect(rows[2]).toContain("--.---");
    for (const raceLap of ["2:16.900", "2:17.300", "2:17.500"]) expect(html).not.toContain(raceLap);
  });

  it("heads the race with only 'Race' and the track, under green and under the flag", () => {
    const tonight = { season, rounds: [round(venueToday())], standings: [standing], qualifying: { round: round(venueToday()), field } };
    const rows = [liveRaceRow(1, 1), liveRaceRow(2, 2), liveRaceRow(3, 3)];
    try {
      for (const [race, finished] of [
        [liveRaceFeed(rows, { timeRemainS: 754 }), false],
        [liveRaceFeed(rows, { lapsRemain: 5, timeRemainS: null }), false],
        [liveRaceFeed(rows, { lapsRemain: 1, timeRemainS: null }), false],
        [liveRaceFeed(rows, { sessionState: SESSION_STATE.checkered }), true],
      ] as const) {
        liveRace.view = { race, finished, moves: new Map(), stale: false };
        const html = renderToStaticMarkup(
          <league.Board spec={null} data={tonight} stale={false} hold={() => {}} />,
        );
        expect(html).toContain(">Race<");
        expect(html).toContain(">Spa-Francorchamps</p>");
        for (const absent of ["to go", "Final lap", "Round 1", "Qualifying", "Racing", "Chequered", "Grand Prix Pits", "Porsche 911 GT3 R", "3 cars"]) {
          expect(html).not.toContain(absent);
        }
      }
    } finally {
      liveRace.view = { race: null, finished: false, moves: new Map(), stale: false };
    }
  });

  it("shows a race only while tonight's round is open, and asks the feed only then", () => {
    liveRace.view = {
      race: liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)]),
      finished: false,
      moves: new Map(),
      stale: false,
    };
    const yesterday = new Date(Date.now() - 86_400_000);
    const render = (rounds: ReturnType<typeof round>[]) => {
      liveRace.asked = [];
      const data = { season, rounds, standings: [standing], qualifying: null };
      const html = renderToStaticMarkup(
        <league.Board spec={null} data={data} stale={false} hold={() => {}} />,
      );
      return { html, asked: liveRace.asked };
    };
    try {
      for (const rounds of [
        [round(venueToday(), "2026-10-02T03:00:00Z")],
        [round(venueToday(yesterday))],
      ]) {
        const ordinary = render(rounds);
        expect(ordinary.asked).toEqual([false]);
        expect(ordinary.html).toContain("Season standings");
        expect(ordinary.html).not.toContain("data-tv-race-row");
      }

      const leagueNight = render([round(venueToday())]);
      expect(leagueNight.asked).toEqual([true]);
      expect(leagueNight.html).toContain("data-tv-race-row");
      expect(leagueNight.html).not.toContain("Season standings");
    } finally {
      liveRace.view = { race: null, finished: false, moves: new Map(), stale: false };
    }
  });
});
