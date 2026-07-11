import { clearStaffSession } from "@/lib/staff";

export async function POST() {
  await clearStaffSession();
  return Response.json({ ok: true });
}
