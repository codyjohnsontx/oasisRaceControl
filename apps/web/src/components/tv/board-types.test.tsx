import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { venueToday } from "@/lib/venue";
import type { LiveRaceView } from "@/components/use-live-race";
import { liveRaceFeed, liveRaceRow } from "@/test/live-race-fixture";
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
  const field = [
    { round_id: "r1", round_number: 1, driver_id: "d1", display_name: "Jordan R.", position: 1, best_lap_ms: 137_683, lap_count: 7, valid_lap_count: 7 },
    { round_id: "r1", round_number: 1, driver_id: "d2", display_name: "Cody J.", position: 2, best_lap_ms: 137_879, lap_count: 6, valid_lap_count: 5 },
    { round_id: "r1", round_number: 1, driver_id: "d3", display_name: "Alexis M.", position: null, best_lap_ms: null, lap_count: 1, valid_lap_count: 0 },
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

  it("heads the race with only 'Race', the track and what is left", () => {
    liveRace.view = {
      race: liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2), liveRaceRow(3, 3)], {
        timeRemainS: 754,
      }),
      finished: false,
      moves: new Map(),
      stale: false,
    };
    try {
      const tonight = { season, rounds: [round(venueToday())], standings: [standing], qualifying: { round: round(venueToday()), field } };
      const html = renderToStaticMarkup(
        <league.Board spec={null} data={tonight} stale={false} hold={() => {}} />,
      );
      expect(html).toContain(">Race<");
      expect(html).toContain("Spa-Francorchamps · 12:34 to go");
      for (const absent of ["Round 1", "Qualifying", "Racing", "Grand Prix Pits", "Porsche 911 GT3 R", "3 cars"]) {
        expect(html).not.toContain(absent);
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
