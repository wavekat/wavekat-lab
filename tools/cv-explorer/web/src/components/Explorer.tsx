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
