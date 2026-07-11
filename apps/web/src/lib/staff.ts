import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serviceClient } from "./supabase";

export type StaffUser = { userId: string; displayName: string };

/** Supabase Auth server client bound to the request cookies (staff plane). */
export async function staffAuthClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              store.set(name, value, options);
            }
          } catch {
            // Server components can't set cookies; middleware/route handlers can.
          }
        },
      },
    },
  );
}

/** The signed-in staff member, or null. Staff = Supabase Auth user with a
 * staff_users row; the row is the authorization, the auth user is only identity. */
export async function getStaffUser(): Promise<StaffUser | null> {
  const supabase = await staffAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient()
    .from("staff_users")
    .select("user_id, display_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return null;
  return { userId: data.user_id, displayName: data.display_name };
}

export async function writeAudit(entry: {
  staffUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await serviceClient().from("audit_log").insert({
    staff_user_id: entry.staffUserId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    reason: entry.reason ?? null,
    detail: entry.detail ?? null,
  });
}
