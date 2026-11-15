import { notFound } from "next/navigation";
import { getWaitlistEntry } from "@/lib/data/waitlist";
import ClaimOffer from "./ClaimOffer";
import { verifyWaitlistClaimToken } from "@/lib/waitlist-claim-token";

export const dynamic = "force-dynamic";

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ entryId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { entryId } = await params;
  const { token } = await searchParams;
  const verified = token ? verifyWaitlistClaimToken(token, entryId) : null;
  if (!verified) return notFound();
  const entry = await getWaitlistEntry(entryId);
  if (!entry) return notFound();

  return <ClaimOffer entry={entry} claimToken={token!} />;
}
