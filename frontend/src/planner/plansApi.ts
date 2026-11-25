// Saved trade plans, kept by the backend beside your simulated account.

export type ChecklistItem = { text: string; done: boolean };

export type PlanFields = {
  symbol: string;
  title: string;
  setup: string | null;
  entry: string;
  stop: string | null;
  target: string | null;
  risk_mode: "percent" | "dollars";
  risk_value: string | null;
  shares: number | null; // null: sized from the risk
  notes: string;
  checklist: ChecklistItem[];
};

export type SavedPlan = PlanFields & { id: string; created_at: string; updated_at: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `${response.status} ${response.statusText}`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

export const listPlans = () => call<SavedPlan[]>("/api/plans");

export const savePlan = (fields: PlanFields, id: string | null) =>
  call<SavedPlan>(id ? `/api/plans/${id}` : "/api/plans", { method: id ? "PUT" : "POST", body: JSON.stringify(fields) });

export const deletePlan = (id: string) => call<null>(`/api/plans/${id}`, { method: "DELETE" });
