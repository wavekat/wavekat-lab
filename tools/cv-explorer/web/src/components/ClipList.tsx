import type { Clip } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
} from "lucide-react";

const PAGE_SIZE = 50;

interface ClipListProps {
  clips: Clip[];
  total: number;
  offset: number;
  loading: boolean;
  selectedClip: Clip | null;
  onSelectClip: (clip: Clip) => void;
  onOffsetChange: (offset: number) => void;
}

export function ClipList({
  clips,
  total,
  offset,
  loading,
  selectedClip,
  onSelectClip,
  onOffsetChange,
}: ClipListProps) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : clips.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">No clips found</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50%]">Sentence</TableHead>
                <TableHead className="w-16 text-right">Length</TableHead>
                <TableHead className="w-20">Gender</TableHead>
                <TableHead className="w-20">Age</TableHead>
                <TableHead className="w-12 text-right">+</TableHead>
                <TableHead className="w-12 text-right">-</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clips.map((clip) => (
                <TableRow
                  key={clip.id}
                  data-state={selectedClip?.id === clip.id ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => onSelectClip(clip)}
                >
                  <TableCell className="max-w-0 truncate font-mono text-xs">
                    {clip.sentence}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {clip.char_count}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {clip.gender || "\u2014"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {clip.age || "\u2014"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {clip.up_votes}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {clip.down_votes}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {total > 0
            ? `${from}\u2013${to} of ${total.toLocaleString()}`
            : "No results"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={page <= 1}
            onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="px-1.5 text-xs tabular-nums text-muted-foreground">
            {page}/{totalPages || 1}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={page >= totalPages}
            onClick={() => onOffsetChange(offset + PAGE_SIZE)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
