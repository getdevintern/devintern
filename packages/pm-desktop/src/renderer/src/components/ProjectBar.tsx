import { FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

interface ProjectBarProps {
  status: ProjectStatus;
  onChangeProject: () => void;
}

export function ProjectBar({ status, onChangeProject }: ProjectBarProps) {
  return (
    <header className="flex items-center gap-2 border-b bg-card px-3 py-2">
      <span className="text-sm font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onChangeProject} title={status.projectDir}>
        <FolderOpen data-icon="inline-start" />
        <span className="max-w-72 truncate">{status.projectDir}</span>
      </Button>

      <span className="ml-auto flex items-center gap-2">
        {status.backendName && <Badge variant="secondary">{status.backendName}</Badge>}
        {status.harnessDisplayName && <Badge variant="outline">{status.harnessDisplayName}</Badge>}
      </span>
    </header>
  );
}
