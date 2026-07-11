import { serviceClient } from "@/lib/supabase";
import { getDriverSession } from "@/lib/driver-session";
import { CheckInFlow } from "@/components/check-in-flow";

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const { data: qr, error } = await serviceClient()
    .from("rig_qr_tokens")
    .select("active, rigs ( rig_number, display_name )")
    .eq("token", token)
    .maybeSingle();

  // A failed lookup is not an unknown rig — fail loudly rather than telling
  // the customer their (valid) QR code isn't registered.
  if (error) {
    throw new Error(`Rig QR lookup failed: ${error.message}`);
  }

  const rig = qr?.active ? (Array.isArray(qr.rigs) ? qr.rigs[0] : qr.rigs) : null;

  if (!rig) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <h1 className="text-3xl font-black">Unknown simulator</h1>
        <p className="text-muted mt-3 max-w-xs">
          This QR code isn&apos;t registered. Grab a staff member and we&apos;ll get
          you driving.
        </p>
      </main>
    );
  }

  const session = await getDriverSession();

  return (
    <CheckInFlow
      qrToken={token}
      rigNumber={rig.rig_number}
      signedInAs={session ? { displayName: session.displayName, isGuest: session.isGuest } : null}
    />
  );
}
