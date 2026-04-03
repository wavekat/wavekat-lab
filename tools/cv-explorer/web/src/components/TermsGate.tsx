import { useState } from "react";
import { acceptTerms, logout, type AuthUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Loader2 } from "lucide-react";

interface TermsGateProps {
  onAccept: (user: AuthUser) => void;
  onDecline: () => void;
}

export function TermsGate({ onAccept, onDecline }: TermsGateProps) {
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    setLoading(true);
    try {
      const user = await acceptTerms();
      onAccept(user);
    } catch {
      setLoading(false);
    }
  };

  const handleDecline = async () => {
    await logout();
    onDecline();
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Usage Terms</CardTitle>
          <CardDescription>
            This tool provides access to data from the{" "}
            <a
              href="https://commonvoice.mozilla.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Mozilla Common Voice
            </a>{" "}
            project. By continuing, you agree to the following:
          </CardDescription>
        </CardHeader>

        <CardContent>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              You will <strong>not</strong> attempt to determine the identity of
              any speaker in the dataset.
            </li>
            <li>
              You will <strong>not</strong> re-distribute, re-host, or share any
              data obtained through this tool.
            </li>
            <li>
              Data accessed through this tool is for personal or team review
              purposes only.
            </li>
            <li>
              You acknowledge that the underlying data is licensed under{" "}
              <a
                href="https://creativecommons.org/publicdomain/zero/1.0/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                CC-0
              </a>{" "}
              (text) and{" "}
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                CC-BY 4.0
              </a>{" "}
              (audio) by Mozilla Common Voice.
            </li>
          </ol>
        </CardContent>

        <CardFooter className="flex-col gap-3">
          <Button
            onClick={handleAccept}
            disabled={loading}
            className="w-full"
          >
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            I Agree
          </Button>
          <button
            onClick={handleDecline}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Decline and sign out
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/60">
            WaveKat is not affiliated with or endorsed by Mozilla.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
