"use client";

import { useState } from "react";
import { repeatedPlaces, type RaceReview, type RaceReviewEntry } from "@/lib/league";
import { QUALIFYING_BONUS_POINTS } from "@/lib/league-scoring";

type Driver = { driver_id: string; display_name: string };

type Draft = { finishers: Driver[]; dnf: Driver[]; out: Driver[] };

/**
 * Tonight's race result as the rigs captured it, for staff to check and
 * correct before closing the round. The order shown is the order the round is
 * placed by; every driver in the field the result does not mention is listed
 * under it, so a car that crashed out or a rig that stopped reporting is in
 * front of staff rather than silently missing.
 *
 * Editing works on a draft, never on the props: the dashboard refreshes every
 * 15 s while staff are reordering, and a refresh must not undo their changes.
 */
export function StaffRaceResult({
  review,
  busy,
  onSave,
}: {
  review: RaceReview;
  busy: boolean;
  /** Resolves true once the server has the result. */
  onSave: (finishers: string[], dnf: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);

  const finishers = review.entries.filter((entry) => entry.finish_position !== null);
  const dnf = review.entries.filter((entry) => entry.finish_position === null);
  const repeated = repeatedPlaces(review.entries);
  const hasField = review.entries.length > 0 || review.notInRace.length > 0;

  function startEditing() {
    setDraft({ finishers, dnf, out: review.notInRace });
  }

  async function save() {
    if (!draft) return;
    const saved = await onSave(
      draft.finishers.map((driver) => driver.driver_id),
      draft.dnf.map((driver) => driver.driver_id),
    );
    if (saved) setDraft(null);
  }

  return (
    <div className="bg-surface border border-edge rounded-xl p-4 mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-bold">Race result</p>
        <p className={`text-xs font-bold uppercase tracking-wider ${statusTone(review)}`}>
          {statusLabel(review)}
        </p>
      </div>
      <p className="text-muted text-xs max-w-xl">
        The round scores by this finishing order, plus {QUALIFYING_BONUS_POINTS} for the
        fastest clean qualifying lap. Places record from the rigs at the chequered flag;
        with no race result the round scores by fastest lap.
      </p>

      {draft ? (
        <Editor draft={draft} setDraft={setDraft} />
      ) : (
        <Summary
          finishers={finishers}
          dnf={dnf}
          notInRace={review.notInRace}
          repeated={repeated}
        />
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {draft ? (
          <>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || draft.finishers.length + draft.dnf.length === 0}
              onClick={() => void save()}
              className="text-xs font-bold uppercase tracking-wider bg-accent text-bg rounded-md px-3 py-2 disabled:opacity-40"
            >
              Save result
            </button>
          </>
        ) : (
          hasField && (
            <button
              type="button"
              disabled={busy}
              onClick={startEditing}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2 disabled:opacity-40"
            >
              {review.entries.length > 0 ? "Correct order" : "Enter result by hand"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function statusLabel(review: RaceReview): string {
  if (review.confirmed) return "Confirmed by staff";
  if (review.entries.length > 0) return "Captured - check before closing";
  if (review.raceHeard) return "Race on - places record at the flag";
  return "No race yet";
}

function statusTone(review: RaceReview): string {
  if (review.confirmed) return "text-valid";
  if (review.entries.length > 0) return "text-sunset";
  return "text-muted";
}

function Summary({
  finishers,
  dnf,
  notInRace,
  repeated,
}: {
  finishers: RaceReviewEntry[];
  dnf: RaceReviewEntry[];
  notInRace: Driver[];
  repeated: Set<number>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {finishers.length > 0 && (
        <ol className="flex flex-col divide-y divide-edge/60">
          {finishers.map((entry, index) => (
            <li key={entry.driver_id} className="flex items-baseline gap-3 py-1.5 text-sm">
              <span className="laptime w-7 shrink-0 text-right font-bold">P{index + 1}</span>
              <span className="min-w-0 flex-1 truncate font-bold">{entry.display_name}</span>
              <span className="shrink-0 text-muted text-xs">{origin(entry)}</span>
              {entry.finish_position !== null && repeated.has(entry.finish_position) && (
                <span className="shrink-0 text-sunset text-xs font-bold">same place twice</span>
              )}
              {entry.source === "close" && (
                <span className="shrink-0 text-sunset text-xs font-bold">not seen at the flag</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {dnf.length > 0 && (
        <p className="text-sm">
          <span className="text-muted text-xs uppercase tracking-wider">DNF · </span>
          {dnf.map((entry) => entry.display_name).join(", ")}
        </p>
      )}
      {notInRace.length > 0 && (
        <p className="text-sm">
          <span className="text-sunset text-xs font-bold uppercase tracking-wider">
            In the round, no race finish ·{" "}
          </span>
          {notInRace.map((driver) => driver.display_name).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Where a place came from, in the words staff need to check it. */
function origin(entry: RaceReviewEntry): string {
  const parts: string[] = [];
  if (entry.rig_number !== null) parts.push(`Rig ${entry.rig_number}`);
  if (entry.source !== "staff" && entry.finish_position !== null) {
    parts.push(`iRacing P${entry.finish_position}`);
  }
  if (entry.laps_completed !== null) parts.push(`${entry.laps_completed} laps`);
  return parts.join(" · ");
}

function Editor({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
}) {
  function move(index: number, by: -1 | 1) {
    const finishers = [...draft.finishers];
    const [driver] = finishers.splice(index, 1);
    finishers.splice(index + by, 0, driver!);
    setDraft({ ...draft, finishers });
  }

  const without = (list: Driver[], driver: Driver) =>
    list.filter((other) => other.driver_id !== driver.driver_id);

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1.5">
        {draft.finishers.map((driver, index) => (
          <li
            key={driver.driver_id}
            className="flex items-center gap-2 rounded-lg border border-edge bg-bg px-2 py-1.5 text-sm"
          >
            <span className="laptime w-7 shrink-0 text-right font-bold">P{index + 1}</span>
            <span className="min-w-0 flex-1 truncate font-bold">{driver.display_name}</span>
            <EditButton
              label="↑"
              title={`Move ${driver.display_name} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            />
            <EditButton
              label="↓"
              title={`Move ${driver.display_name} down`}
              disabled={index === draft.finishers.length - 1}
              onClick={() => move(index, 1)}
            />
            <EditButton
              label="DNF"
              title={`Mark ${driver.display_name} as not finishing`}
              onClick={() =>
                setDraft({
                  ...draft,
                  finishers: without(draft.finishers, driver),
                  dnf: [...draft.dnf, driver],
                })
              }
            />
            <EditButton
              label="Out"
              title={`Take ${driver.display_name} out of the race`}
              onClick={() =>
                setDraft({
                  ...draft,
                  finishers: without(draft.finishers, driver),
                  out: [...draft.out, driver],
                })
              }
            />
          </li>
        ))}
      </ol>

      {draft.dnf.length > 0 && (
        <DriverChips
          heading="DNF - scores the participation point"
          drivers={draft.dnf}
          action="Finished"
          onPick={(driver) =>
            setDraft({
              ...draft,
              dnf: without(draft.dnf, driver),
              finishers: [...draft.finishers, driver],
            })
          }
        />
      )}
      {draft.out.length > 0 && (
        <DriverChips
          heading="Not in the race - add a driver to the end of the order"
          drivers={draft.out}
          action="Add"
          onPick={(driver) =>
            setDraft({
              ...draft,
              out: without(draft.out, driver),
              finishers: [...draft.finishers, driver],
            })
          }
        />
      )}
    </div>
  );
}

function EditButton({
  label,
  title,
  disabled = false,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 min-w-9 rounded-md border border-edge px-2 py-1.5 text-xs font-bold disabled:opacity-30"
    >
      {label}
    </button>
  );
}

function DriverChips({
  heading,
  drivers,
  action,
  onPick,
}: {
  heading: string;
  drivers: Driver[];
  action: string;
  onPick: (driver: Driver) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted text-xs uppercase tracking-wider">{heading}</p>
      <ul className="flex flex-wrap gap-2">
        {drivers.map((driver) => (
          <li key={driver.driver_id}>
            <button
              type="button"
              aria-label={`${action}: ${driver.display_name}`}
              onClick={() => onPick(driver)}
              className="flex items-center gap-2 rounded-lg border border-edge bg-bg px-3 py-1.5 text-sm"
            >
              <span className="font-bold">{driver.display_name}</span>
              <span className="text-accent text-xs font-bold uppercase tracking-wider">{action}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
