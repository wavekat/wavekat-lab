import { useState } from "react";
import { login } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export function LoginPage() {
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Common Voice Explorer
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">by WaveKat Lab</p>
      </div>

      <p className="max-w-xs text-center text-sm text-muted-foreground">
        Browse and review Common Voice audio clips with rich filtering.
      </p>

      <Button
        onClick={() => {
          setLoading(true);
          login().catch(() => setLoading(false));
        }}
        disabled={loading}
      >
        {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
        Sign in with GitHub
      </Button>

      <a
        href="https://wavekat.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground hover:underline"
      >
        wavekat.com
      </a>
    </div>
  );
}
