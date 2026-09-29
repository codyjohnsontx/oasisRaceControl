import { z } from "zod";
import { query } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";

export type StaffDriverMatch = {
  id: string;
  display_name: string;
  is_guest: boolean;
  status: string;
  lap_count: number;
  last_lap_at: string | null;
  locked_until: string | null;
};

const MAX_MATCHES = 10;

const name = z.string().trim().min(1).max(24);

/** Escapes LIKE wildcards so a typed "_" or "%" matches itself. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Staff look a racer up by the name they give at the counter, to reset their
 * PIN. A partial, case-insensitive match (display_name is citext) because a
 * racer who has forgotten their PIN may not remember their exact spelling
 * either; an exact match sorts first. Lap count and last lap are there so staff
 * can tell "chuy" from "chuy2" before changing anyone's PIN. Staff-only, so
 * listing names is not the enumeration leak it would be on a public route.
 */
export async function GET(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = name.safeParse(new URL(request.url).searchParams.get("name"));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const drivers = await query<StaffDriverMatch>(
      `select d.id, d.display_name::text as display_name, d.is_guest,
              d.status::text as status,
              (select count(*)::int from laps l where l.driver_id = d.id) as lap_count,
              (select max(l.completed_at) from laps l where l.driver_id = d.id) as last_lap_at,
              case when p.locked_until > now() then p.locked_until end as locked_until
       from drivers d
       left join pin_attempts p on p.driver_id = d.id
       where d.display_name like $1
       order by d.display_name = $2 desc, d.display_name
       limit ${MAX_MATCHES}`,
      [likeContains(parsed.data), parsed.data],
    );
    return Response.json({ drivers });
  } catch (error) {
    console.error("[staff/drivers] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
