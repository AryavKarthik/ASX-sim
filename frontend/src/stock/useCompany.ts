import { useEffect, useState } from "react";

import type { Company } from "../live/company";

export type CompanyState = { data: Company | null; error: string | null };

/** Company profile, fundamentals, dividends and price statistics, up to the session day. */
export function useCompany(symbol: string | null, sessionDay: string | null): CompanyState {
  const [state, setState] = useState<CompanyState>({ data: null, error: null });
  useEffect(() => {
    if (!symbol) return;
    let current = true;
    setState({ data: null, error: null });
    const params = new URLSearchParams({ symbol });
    if (sessionDay) params.set("until", sessionDay);
    fetch(`/api/live/company?${params}`)
      .then(async (response) => {
        const body = (await response.json()) as Company & { detail?: string };
        if (!response.ok) throw new Error(body.detail ?? response.statusText);
        if (current) setState({ data: body, error: null });
      })
      .catch((e: Error) => current && setState({ data: null, error: e.message }));
    return () => {
      current = false;
    };
  }, [symbol, sessionDay]);
  return state;
}
