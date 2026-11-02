"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Application, InboxJob } from "@/lib/career-ops";

type Snapshot = {
  inbox: InboxJob[];
  applications: Application[];
  loading: boolean;
  refetch: () => void;
};

const PipelineContext = createContext<Snapshot | null>(null);

export function usePipeline(): Snapshot {
  const c = useContext(PipelineContext);
  if (!c) throw new Error("usePipeline must be used within <PipelineProvider>");
  return c;
}

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const [inbox, setInbox] = useState<InboxJob[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    setLoading(true);
    fetch("/api/pipeline")
      .then((r) => r.json())
      .then((d) => {
        setInbox(Array.isArray(d.inbox) ? d.inbox : []);
        setApplications(Array.isArray(d.applications) ? d.applications : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return (
    <PipelineContext.Provider value={{ inbox, applications, loading, refetch }}>
      {children}
    </PipelineContext.Provider>
  );
}
