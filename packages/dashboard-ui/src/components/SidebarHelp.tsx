import { useEffect, useState } from "react";
import { BookOpen, Bug, Lightbulb } from "lucide-react";

import { isDemoMode } from "@/lib/demo";
import { DOCS_URL, newIssueUrl, parseHealthVersion } from "@/lib/feedback-links";
import { ReportDialog } from "@/views/run-detail/ReportProblem";

/** The running CLI version from `GET /api/health`; null until known or on error. */
function useWorkerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!cancelled) setVersion(parseHealthVersion(body));
      })
      .catch(() => {
        // Version is a nice-to-have for the issue form.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

/**
 * Sidebar footer: report a bug (the private, redacted report flow), request a
 * feature (a public GitHub issue form), docs, and the running version.
 */
export function SidebarHelp() {
  const [reportOpen, setReportOpen] = useState(false);
  const version = useWorkerVersion();
  const demo = isDemoMode();
  return (
    <div className="dashboard-help" role="group" aria-label="Help and feedback">
      {demo ? null : (
        <>
          <button
            type="button"
            className="dashboard-help-link"
            onClick={() => setReportOpen(true)}
            title="Send a private, redacted bug report"
          >
            <Bug size={16} aria-hidden="true" />
            <span>Report a bug</span>
          </button>
          <ReportDialog open={reportOpen} onOpenChange={setReportOpen} runId={null} />
        </>
      )}
      <a
        className="dashboard-help-link"
        href={newIssueUrl("feature_request.yml", version)}
        target="_blank"
        rel="noreferrer"
        title="Opens a public GitHub issue"
      >
        <Lightbulb size={16} aria-hidden="true" />
        <span>Request a feature</span>
      </a>
      <a className="dashboard-help-link" href={DOCS_URL} target="_blank" rel="noreferrer">
        <BookOpen size={16} aria-hidden="true" />
        <span>Docs</span>
      </a>
      {version ? <p className="dashboard-help-version">devintern {version}</p> : null}
    </div>
  );
}
