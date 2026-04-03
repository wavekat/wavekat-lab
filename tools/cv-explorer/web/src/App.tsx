import { useState, useEffect } from "react";
import { initAuth, logout, type AuthUser } from "@/lib/auth";
import { LoginPage } from "@/components/LoginPage";
import { TermsGate } from "@/components/TermsGate";
import { AuthCallback } from "@/components/AuthCallback";
import { Explorer } from "@/components/Explorer";
import { Loader2 } from "lucide-react";

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const isCallback = window.location.pathname === "/auth/callback";

  useEffect(() => {
    if (isCallback) {
      setLoading(false);
      return;
    }
    initAuth()
      .then((u) => setUser(u))
      .finally(() => setLoading(false));
  }, [isCallback]);

  if (isCallback) {
    return (
      <AuthCallback
        onSuccess={(u) => {
          setUser(u);
          window.history.replaceState(null, "", "/");
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  if (!user.terms_accepted) {
    return <TermsGate onAccept={(u) => setUser(u)} onDecline={() => setUser(null)} />;
  }

  return (
    <Explorer
      user={user}
      onLogout={() => {
        logout();
        setUser(null);
      }}
    />
  );
}
