import { queryOne } from "@/lib/db";
import { getDriverSession } from "@/lib/driver-session";
import { CheckInFlow } from "@/components/check-in-flow";

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // A failed lookup throws to the error boundary — never tell a customer
  // their (valid) QR code isn't registered because the database hiccupped.
  const rig = await queryOne<{ rig_number: number }>(
    `select r.rig_number
     from rig_qr_tokens t
     join rigs r on r.id = t.rig_id
     where t.token = $1 and t.active`,
    [token],
  );

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
