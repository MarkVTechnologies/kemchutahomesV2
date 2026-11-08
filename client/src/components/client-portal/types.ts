// Shapes matching the real GET /api/clients/dashboard response
// (server/controllers/client.controller.js getClientDashboard) — not the
// legacy SPA's ClientPortal.jsx, which references a recentInspections field
// the API doesn't actually return.
export type PortalSubscription = {
  _id: string;
  estateName: string;
  referenceNumber: string;
  plotSize: string;
  plotType: string;
  numberOfPlots: number;
  totalAmount: number;
  amountPaid: number;
  status: string;
  createdAt: string;
};

export type PortalInvestment = {
  _id: string;
  duration: string;
  referenceNumber: string;
  principalAmount: number;
  status: string;
  expectedPayout?: number;
};

export type DashboardStats = {
  totalSubscriptions: number;
  approvedSubscriptions: number;
  pendingSubscriptions: number;
  totalAmountPaid: number;
  totalInvestments: number;
  activeInvestments: number;
  pendingInvestments: number;
  totalInvested: number;
  totalExpectedROI: number;
  totalExpectedPayout: number;
  maturingInvestments: number;
  paidOutInvestments: number;
  totalInspections: number;
  upcomingInspections: number;
};

export type ClientDashboard = {
  emailVerified?: boolean;
  stats: DashboardStats;
  recentSubscriptions: PortalSubscription[];
  recentInvestments: PortalInvestment[];
};

// ── Subscription detail (GET /api/subscriptions/my — same lean documents as
// the list above, just consumed for their full field set instead of the
// summary one) ──────────────────────────────────────────────────────────────
export type SubscriptionPayment = {
  _id: string;
  amount: number;
  paidAt: string;
  method: string;
  reference?: string;
  confirmed: boolean;
  confirmedAt?: string | null;
};

export type SubscriptionInstalment = {
  _id: string;
  instalmentNumber: number;
  dueDate: string;
  amount: number;
  isPaid: boolean;
  paidAt?: string | null;
};

export const DOCUMENT_TYPES = [
  "acknowledgement",
  "invoice",
  "contract",
  "schedule",
  "receipt",
  "allocation",
  "deed",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type SubscriptionDocument = {
  _id: string;
  type: DocumentType | string;
  label: string;
  generatedAt: string;
};

export type SubscriptionDetail = PortalSubscription & {
  paymentPlan: "Outright" | "Instalment";
  instalmentMonths: number | null;
  payments: SubscriptionPayment[];
  instalmentSchedule: SubscriptionInstalment[];
  documents: SubscriptionDocument[];
  confirmedAt?: string | null;
  plotNumber?: string;
};

// ── Inspections (GET /api/clients/inspections) ───────────────────────────────
export type PortalInspection = {
  _id: string;
  estateName: string;
  inspectionDate: string;
  persons: number;
  status: "pending" | "confirmed" | "cancelled" | "completed";
  notes?: string;
  createdAt: string;
};

export type PortalInspectionListResponse = {
  inspections: PortalInspection[];
  total: number;
  page: number;
  pages: number;
};
