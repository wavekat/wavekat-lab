import { useState, useEffect, useCallback } from "react";
import {
  fetchDatasets,
  fetchClips,
  type Clip,
  type Dataset,
  type Filters,
} from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import { FilterPanel } from "@/components/FilterPanel";
import { ClipList } from "@/components/ClipList";
import { AudioPlayer } from "@/components/AudioPlayer";

interface ExplorerProps {
  user: AuthUser;
  onLogout: () => void;
}

export function Explorer({ user, onLogout }: ExplorerProps) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [filters, setFilters] = useState<Filters>({
    locale: "en",
    split: "validated",
  });
  const [clips, setClips] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  // Fetch datasets on mount
  useEffect(() => {
    fetchDatasets()
      .then((ds) => {
        setDatasets(ds);
        if (ds.length > 0) {
          const first = ds[0];
          setFilters({
            version: first.version,
            locale: first.locale,
            split: first.split,
          });
        }
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  // Fetch clips when filters or offset change
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    fetchClips(filters, offset)
      .then((data) => {
        setClips(data.clips);
        setTotal(data.total);
      })
      .catch(() => {
        setClips([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [filters, offset, ready]);

  const handleDatasetChange = useCallback(
    (datasetId: string) => {
      const ds = datasets.find((d) => d.id === datasetId);
      if (ds) {
        setFilters((f) => ({
          ...f,
          version: ds.version,
          locale: ds.locale,
          split: ds.split,
        }));
        setOffset(0);
        setSelectedClip(null);
      }
    },
    [datasets],
  );

  const handleFiltersChange = useCallback((f: Filters) => {
    setFilters(f);
    setOffset(0);
  }, []);

  // Arrow key navigation for clips
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (clips.length === 0) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const idx = selectedClip
          ? clips.findIndex((c) => c.id === selectedClip.id)
          : -1;
        if (idx < clips.length - 1) setSelectedClip(clips[idx + 1]);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const idx = selectedClip
          ? clips.findIndex((c) => c.id === selectedClip.id)
          : clips.length;
        if (idx > 0) setSelectedClip(clips[idx - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clips, selectedClip]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h1 className="text-sm font-semibold tracking-tight">
          Common Voice Explorer
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {total.toLocaleString()} clips
          </span>
          <a
            href="https://github.com/wavekat/wavekat-lab"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
            title="Source code"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
          </a>
          {user.avatar_url && (
            <img
              src={user.avatar_url}
              alt=""
              className="size-5 rounded-full"
            />
          )}
          <button
            onClick={onLogout}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Filter sidebar */}
        <aside className="w-56 shrink-0 overflow-y-auto border-r p-3">
          <FilterPanel
            datasets={datasets}
            filters={filters}
            onFiltersChange={handleFiltersChange}
            onDatasetChange={handleDatasetChange}
          />
        </aside>

        {/* Clip list */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <ClipList
            clips={clips}
            total={total}
            offset={offset}
            loading={loading}
            selectedClip={selectedClip}
            onSelectClip={setSelectedClip}
            onOffsetChange={setOffset}
          />
        </main>
      </div>

      {/* Audio player */}
      {selectedClip && <AudioPlayer clip={selectedClip} />}
    </div>
  );
}
