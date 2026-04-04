import { useState } from "react";
import { login } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  GithubIcon,
  GlobeIcon,
  HeadphonesIcon,
  Loader2,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

export function LoginPage() {
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center pb-2 pt-8">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <HeadphonesIcon className="size-6 text-primary" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            Common Voice Explorer
          </h1>
          <p className="text-xs text-muted-foreground">
            by{" "}
            <a
              href="https://github.com/wavekat/wavekat-lab/tree/main/tools/cv-explorer"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              WaveKat Lab
            </a>
          </p>
        </CardHeader>

        <CardContent className="space-y-5 px-6 pb-6">
          <p className="text-center text-sm text-muted-foreground">
            Browse and play audio clips from Mozilla Common Voice with rich
            filtering.
          </p>

          <div className="grid gap-2.5 text-sm text-muted-foreground">
            <div className="flex items-center gap-2.5">
              <GlobeIcon className="size-4 shrink-0" />
              <span>Filter by locale, split, and demographics</span>
            </div>
            <div className="flex items-center gap-2.5">
              <SearchIcon className="size-4 shrink-0" />
              <span>Full-text sentence search</span>
            </div>
            <div className="flex items-center gap-2.5">
              <SlidersHorizontalIcon className="size-4 shrink-0" />
              <span>Waveform playback powered by WaveSurfer.js</span>
            </div>
          </div>

          <Button
            className="w-full"
            size="lg"
            onClick={() => {
              setLoading(true);
              login().catch(() => setLoading(false));
            }}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <GithubIcon className="mr-2 size-4" />
            )}
            Sign in with GitHub
          </Button>
        </CardContent>

        <CardFooter className="justify-center border-t py-4 text-xs text-muted-foreground">
          <a
            href="https://wavekat.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            wavekat.com
          </a>
        </CardFooter>
      </Card>
    </div>
  );
}
