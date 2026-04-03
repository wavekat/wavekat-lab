import { useState, useEffect, useRef } from "react";
import { handleCallback, type AuthUser } from "@/lib/auth";
import { Loader2 } from "lucide-react";

interface AuthCallbackProps {
  onSuccess: (user: AuthUser) => void;
}

export function AuthCallback({ onSuccess }: AuthCallbackProps) {
  const [error, setError] = useState<string | null>(null);
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (!code) {
      setError("No authorization code received");
      return;
    }

    handleCallback(code).then(onSuccess).catch(() => {
      setError("Authentication failed. Please try again.");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm text-destructive">{error}</p>
        <a href="/" className="text-sm text-muted-foreground hover:underline">
          Back to login
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}
