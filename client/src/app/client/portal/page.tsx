import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { buildMetadata } from "@/lib/seo";
import LogoutButton from "@/components/client-auth/LogoutButton";
import OverviewSection from "@/components/client-portal/OverviewSection";
import ConfirmEmailBanner from "@/components/client-portal/ConfirmEmailBanner";
import type { ClientDashboard } from "@/components/client-portal/types";

export const metadata = buildMetadata({
  title: "My Portal",
  description: "Your Kemchuta Homes client portal.",
  path: "/client/portal",
});

type ClientProfile = {
  firstName: string;
  lastName: string;
  email: string;
};

// Server Component — forwards the incoming request's cookies to the API
// (which reads them via protectClient's cookie fallback, PRD FR-4) rather
// than fetching client-side, so the portal renders authenticated content
// in the initial HTML instead of flashing an empty/loading state first.
//
// proxy.ts guards this route optimistically (cookie present or not); this
// page does the real verification (session actually valid) and renders the
// dashboard overview. Subscription list/detail, inspections, and documents
// are separate follow-ups — this covers the Overview section only.
export default async function ClientPortalPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  // A thrown fetch (network hiccup) or non-JSON response used to be
  // uncaught here, crashing the page to app/error.tsx instead of just
  // sending the visitor back to /client/login — same failure mode fixed in
  // dashboard/layout.tsx for the realtor/admin side.
  let client: ClientProfile | null = null;
  let dashboard: ClientDashboard | null = null;
  try {
    const [profileRes, dashboardRes] = await Promise.all([
      fetch(`${apiBase}/api/clients/me`, { headers: { Cookie: cookieHeader }, cache: "no-store" }),
      fetch(`${apiBase}/api/clients/dashboard`, { headers: { Cookie: cookieHeader }, cache: "no-store" }),
    ]);
    if (profileRes.ok) client = await profileRes.json();
    if (dashboardRes.ok) dashboard = await dashboardRes.json();
  } catch {
    client = null;
  }

  if (!client) {
    // proxy.ts only checked that a cookie was present, not that it's still
    // valid (expired access token, revoked session, etc.) — this is the
    // real verification, and an invalid session sends the user back to
    // login rather than rendering an error.
    redirect("/client/login");
  }

  return (
    <div className="mx-auto w-11/12 max-w-5xl py-10 lg:w-10/12 lg:py-16">
      <div
        className="relative mb-10 overflow-hidden rounded-[2rem] px-6 py-8 text-white sm:px-9 sm:py-10"
        style={{ background: "linear-gradient(135deg, #3F0C91, #700CEB)" }}
      >
        <div className="pointer-events-none absolute -top-12 -right-12 h-56 w-56 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-20 -left-14 h-64 w-64 rounded-full bg-white/5" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-2xl font-black backdrop-blur-sm">
              {client.firstName?.[0]?.toUpperCase() || "K"}
            </div>
            <div>
              <p className="text-[11px] font-bold tracking-widest text-white/60 uppercase">Client Portal</p>
              <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
                Welcome back, {client.firstName}
              </h1>
              <p className="mt-1 text-sm text-white/60">{client.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/client/portal/inspections"
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-bold whitespace-nowrap text-white backdrop-blur-sm transition-colors hover:bg-white/20"
            >
              <CalendarCheck size={15} />
              My Inspections
            </Link>
            <LogoutButton variant="dark" />
          </div>
        </div>
      </div>

      {dashboard?.emailVerified === false && <ConfirmEmailBanner email={client.email} />}

      {dashboard ? (
        <OverviewSection dashboard={dashboard} />
      ) : (
        <div className="rounded-2xl border border-customBlack-100 bg-white p-8 text-center text-gray-600">
          Couldn&rsquo;t load your dashboard right now — please refresh the page.
        </div>
      )}
    </div>
  );
}
