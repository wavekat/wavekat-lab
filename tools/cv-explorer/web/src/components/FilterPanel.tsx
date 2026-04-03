import { useState, useEffect, useCallback } from "react";
import type { Dataset, Filters } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RotateCcwIcon, SearchIcon } from "lucide-react";

const GENDERS = ["", "male", "female", "other"] as const;
const AGES = [
  "",
  "teens",
  "twenties",
  "thirties",
  "fourties",
  "fifties",
  "sixties",
  "seventies",
  "eighties",
  "nineties",
] as const;

interface FilterPanelProps {
  datasets: Dataset[];
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  onDatasetChange: (datasetId: string) => void;
}

export function FilterPanel({
  datasets,
  filters,
  onFiltersChange,
  onDatasetChange,
}: FilterPanelProps) {
  const [searchText, setSearchText] = useState(filters.q || "");

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchText !== (filters.q || "")) {
        onFiltersChange({ ...filters, q: searchText || undefined });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentDatasetId = filters.version
    ? `${filters.version}/${filters.locale}/${filters.split}`
    : undefined;

  const handleReset = useCallback(() => {
    setSearchText("");
    const base: Filters = {
      version: filters.version,
      locale: filters.locale,
      split: filters.split,
    };
    onFiltersChange(base);
  }, [filters.version, filters.locale, filters.split, onFiltersChange]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        <Button variant="ghost" size="icon-xs" onClick={handleReset} title="Reset filters">
          <RotateCcwIcon />
        </Button>
      </div>

      {/* Dataset selector */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dataset">Dataset</Label>
        {datasets.length > 0 ? (
          <Select
            value={currentDatasetId}
            onValueChange={(val) => onDatasetChange(val as string)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select dataset" />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {ds.locale} / {ds.split}
                  <span className="ml-1 text-muted-foreground">
                    ({ds.clip_count.toLocaleString()})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">No datasets synced</p>
        )}
      </div>

      {/* Text search */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="search">Search text</Label>
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="search"
            placeholder="Search sentences..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-7"
          />
        </div>
      </div>

      {/* Word count range */}
      <div className="flex flex-col gap-1.5">
        <Label>Word count</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            placeholder="Min"
            min={0}
            value={filters.min_words ?? ""}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                min_words: e.target.value ? parseInt(e.target.value, 10) : undefined,
              })
            }
            className="w-20"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            placeholder="Max"
            min={0}
            value={filters.max_words ?? ""}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                max_words: e.target.value ? parseInt(e.target.value, 10) : undefined,
              })
            }
            className="w-20"
          />
        </div>
      </div>

      {/* Gender */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gender">Gender</Label>
        <Select
          value={filters.gender || "all"}
          onValueChange={(val) =>
            onFiltersChange({
              ...filters,
              gender: val === "all" ? undefined : (val as string),
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {GENDERS.filter(Boolean).map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Age */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="age">Age</Label>
        <Select
          value={filters.age || "all"}
          onValueChange={(val) =>
            onFiltersChange({
              ...filters,
              age: val === "all" ? undefined : (val as string),
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {AGES.filter(Boolean).map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
