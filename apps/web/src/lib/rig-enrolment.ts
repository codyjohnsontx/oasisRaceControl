import { randomBytes } from "node:crypto";
import { isUniqueViolation, queryOne, withTransaction } from "./db";
import { agentTokenHash } from "./agent-auth";

/**
 * Where a rig's credentials come from.
 *
 * Twenty-plus machines each need their own bearer token, and until this existed
 * the only way to get one was to write sha256 hashes into the production
 * database by hand — twenty-two times, with no audit trail, while the only
 * tokens that existed anywhere were the deliberately guessable ones in
 * `db/seed.sql`. That is how a venue ends up running on `dev-rig-1-secret`, and
 * it is also how two machines end up sharing one token (see "Two computers on
 * one rig's token" in `docs/deploy.md`).
 *
 * Three rules hold this together:
 *
 * 1. **The server mints, the client never supplies.** No request can choose a
 *    rig's token, so no token can be short, guessable, reused from the seed, or
 *    the same as another rig's.
 * 2. **Only the hash is stored.** The plaintext exists in one HTTP response and
 *    nowhere else — not in the row, not in the audit detail, not in a log line.
 *    Losing it costs one rotation; keeping it recoverable would cost the venue
 *    a copy of every rig's credentials sitting in a table staff can read.
 * 3. **A rig is created whole.** The bearer token and the QR token the customer
 *    scans are written in one transaction, because a rig with one and not the
 *    other is a machine that scores laps nobody can check into (or the reverse)
 *    and neither failure names itself.
 */

/** Bytes of randomness behind a rig's bearer token. */
const AGENT_TOKEN_BYTES = 32;

/** Bytes behind the slug printed in a rig's QR code. */
const QR_TOKEN_BYTES = 16;

/**
 * The prefix every minted bearer token carries. It makes the secret
 * recognisable in `agent.config.json`, in a support screenshot, and to a secret
 * scanner — none of which can tell 32 random base64 characters from a session
 * id or a build hash.
 */
export const AGENT_TOKEN_PREFIX = "oasisrig_";

export type MintedRig = {
  id: string;
  rigNumber: number;
  displayName: string;
  /** Shown to staff exactly once. Never stored, never logged, never audited. */
  agentToken: string;
  /** The slug the printed QR encodes as `/r/<qrToken>`. */
  qrToken: string;
};

/** A new bearer token for one rig. Base64url so it survives a PowerShell
 * command line, a JSON config file and an HTTP header without quoting. */
export function mintAgentToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(AGENT_TOKEN_BYTES).toString("base64url");
}

/**
 * A new QR slug. Deliberately carries no rig number: the printed code is on
 * public display in the venue, and a guessable slug would let anyone check
 * themselves into any rig from the car park.
 */
export function mintQrToken(): string {
  return randomBytes(QR_TOKEN_BYTES).toString("base64url");
}

/** What `createRig` answers when the number is already on the floor. */
export const RIG_NUMBER_TAKEN = "rig_number_taken" as const;

/**
 * Creates a rig with its own bearer token and its own QR slug, and returns the
 * plaintext of both. The caller has the only copy of the bearer token from this
 * point on.
 */
export async function createRig(input: {
  rigNumber: number;
  displayName: string;
}): Promise<MintedRig | typeof RIG_NUMBER_TAKEN> {
  const agentToken = mintAgentToken();
  const qrToken = mintQrToken();

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into rigs (rig_number, display_name, agent_token_hash)
         values ($1, $2, $3) returning id`,
        [input.rigNumber, input.displayName, agentTokenHash(agentToken)],
      );
      const id = rows[0]!.id;

      await client.query(
        "insert into rig_qr_tokens (token, rig_id, active) values ($1, $2, true)",
        [qrToken, id],
      );

      return {
        id,
        rigNumber: input.rigNumber,
        displayName: input.displayName,
        agentToken,
        qrToken,
      };
    });
  } catch (error) {
    // rig_number is unique, so two staff tablets adding "Rig 12" at once is
    // arbitrated by the database rather than by whoever pressed first.
    if (isUniqueViolation(error)) return RIG_NUMBER_TAKEN;
    throw error;
  }
}

/**
 * Issues a rig a new bearer token and invalidates the old one in the same
 * statement. This is the revocation path: a token that has been pasted into a
 * chat, typed onto the wrong machine, or is simply lost stops working the
 * moment this returns.
 *
 * The machine at that rig will read `⛔ TOKEN REFUSED` until it is re-enrolled
 * with the new token, which is the honest consequence and is why the caller
 * warns before doing it.
 */
export async function rotateAgentToken(
  rigId: string,
): Promise<Omit<MintedRig, "qrToken"> | null> {
  const agentToken = mintAgentToken();

  // One statement, so the swap of old hash for new is atomic on its own: there
  // is no instant in which this rig has no token or two.
  const rig = await queryOne<{ id: string; rig_number: number; display_name: string }>(
    `update rigs set agent_token_hash = $2 where id = $1
     returning id, rig_number, display_name`,
    [rigId, agentTokenHash(agentToken)],
  );

  if (!rig) return null;
  return {
    id: rig.id,
    rigNumber: rig.rig_number,
    displayName: rig.display_name,
    agentToken,
  };
}

/** `Rig 07` — the default display name, matching the seeded fleet. */
export function defaultRigName(rigNumber: number): string {
  return `Rig ${String(rigNumber).padStart(2, "0")}`;
}
