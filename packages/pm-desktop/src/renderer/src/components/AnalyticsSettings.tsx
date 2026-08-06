import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function AnalyticsSettings() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void window.pm.getAnalyticsEnabled().then((result) => {
      if (result.ok) {
        setEnabled(result.value);
      } else {
        setError(result.error.message);
      }
    });
  }, [open]);

  const onCheckedChange = (next: boolean) => {
    setLoading(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    void window.pm.setAnalyticsEnabled(next).then((result) => {
      setLoading(false);
      if (!result.ok) {
        setEnabled(previous);
        setError(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Settings" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Preferences for this install. Stored locally on your machine.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="analytics-enabled" className="text-sm text-foreground">
              Share anonymous usage data
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Helps us understand which features are used. Never includes prompts, ticket text,
              project paths, or credentials. You can turn this off anytime.
            </p>
          </div>
          <Switch
            id="analytics-enabled"
            checked={enabled}
            disabled={loading}
            onCheckedChange={onCheckedChange}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
