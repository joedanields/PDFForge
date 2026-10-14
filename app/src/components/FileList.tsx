import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownAZ,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  GripVertical,
  KeyRound,
  LoaderCircle,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { moveItem, type InputFile } from "@/lib/files";
import { cn, formatBytes } from "@/lib/utils";

interface Props {
  files: InputFile[];
  onReorder: (files: InputFile[]) => void;
  onRemove: (key: string) => void;
  onPassword: (key: string, password: string) => void;
  onSortByName: () => void;
  onSortByDate: () => void;
}

export function FileList({
  files,
  onReorder,
  onRemove,
  onPassword,
  onSortByName,
  onSortByDate,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = files.findIndex((f) => f.key === active.id);
    const to = files.findIndex((f) => f.key === over.id);
    onReorder(moveItem(files, from, to));
  };

  return (
    <div>
      {files.length > 1 && (
        <div className="mb-3 flex gap-2">
          <Button variant="secondary" size="sm" onClick={onSortByName}>
            <ArrowDownAZ aria-hidden />
            {t("tool.sortName")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onSortByDate}>
            <CalendarClock aria-hidden />
            {t("tool.sortDate")}
          </Button>
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={files.map((f) => f.key)} strategy={rectSortingStrategy}>
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            {files.map((file, index) => (
              <FileCard
                key={file.key}
                file={file}
                index={index}
                last={index === files.length - 1}
                onRemove={() => onRemove(file.key)}
                onMove={(delta) => onReorder(moveItem(files, index, index + delta))}
                onPassword={(pw) => onPassword(file.key, pw)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface CardProps {
  file: InputFile;
  index: number;
  last: boolean;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onPassword: (password: string) => void;
}

function FileCard({ file, index, last, onRemove, onMove, onPassword }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.key,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const problem = file.status === "error" || file.status === "locked";

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative flex flex-col rounded-card border bg-surface p-3 shadow-sm",
        isDragging && "z-10 shadow-xl",
        problem && "border-danger",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted">{index + 1}</span>
        <div className="flex">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={index === 0}
            aria-label={t("file.moveUp", { name: file.name })}
            onClick={() => onMove(-1)}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={last}
            aria-label={t("file.moveDown", { name: file.name })}
            onClick={() => onMove(1)}
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("file.remove", { name: file.name })}
            onClick={onRemove}
          >
            <X />
          </Button>
        </div>
      </div>

      <button
        type="button"
        className="mt-2 flex h-40 cursor-grab items-center justify-center overflow-hidden rounded-md bg-surface-2 active:cursor-grabbing"
        aria-label={t("file.drag", { name: file.name })}
        {...attributes}
        {...listeners}
      >
        {file.status === "loading" ? (
          <LoaderCircle className="size-6 animate-spin text-text-muted" aria-hidden />
        ) : file.thumbnail ? (
          <img
            src={file.thumbnail}
            alt=""
            className="max-h-full max-w-full object-contain shadow"
            draggable={false}
          />
        ) : file.status === "locked" ? (
          <KeyRound className="size-8 text-text-muted" aria-hidden />
        ) : (
          <FileText className="size-8 text-text-muted" aria-hidden />
        )}
        <GripVertical
          className="absolute right-2 top-12 size-4 text-text-muted opacity-0 group-hover:opacity-100"
          aria-hidden
        />
      </button>

      <p className="mt-2 truncate text-sm font-medium" title={file.path}>
        {file.name}
      </p>
      <p className="text-xs text-text-muted">
        {file.pages != null &&
          `${file.pages === 1 ? t("file.page") : t("file.pages", { count: file.pages })} · `}
        {formatBytes(file.size)}
      </p>

      {file.status === "locked" && <PasswordForm file={file} onSubmit={onPassword} />}
      {file.status === "error" && file.error && (
        <p className="mt-2 flex gap-1 text-xs text-danger" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {file.error}
        </p>
      )}
    </li>
  );
}

function PasswordForm({
  file,
  onSubmit,
}: {
  file: InputFile;
  onSubmit: (password: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onSubmit(value);
  };
  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <p className="text-xs text-danger" role="alert">
        {file.error ?? t("file.passwordNeeded")}
      </p>
      <div className="flex gap-1">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${t("file.password")}: ${file.name}`}
          placeholder={t("file.password")}
          className="h-8"
          autoComplete="off"
        />
        <Button type="submit" size="sm" disabled={!value}>
          {t("file.unlock")}
        </Button>
      </div>
    </form>
  );
}
