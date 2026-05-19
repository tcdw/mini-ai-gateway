import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { HolderOutlined, CloseOutlined } from "@ant-design/icons";
import { Tag, Typography } from "antd";
import React from "react";

export interface ProviderEntry {
  name: string;
  remap: string;
}

interface ProviderPriorityListProps {
  providers: ProviderEntry[];
  primaryColor: string;
  onReorder: (nextOrder: string[]) => void;
  onRemove: (providerName: string) => void;
  /**
   * When true, dragging and removing are blocked. The list still renders the
   * current order, but inputs are disabled to avoid racing in-flight
   * mutations.
   */
  disabled?: boolean;
}

interface SortableRowProps {
  provider: ProviderEntry;
  index: number;
  primaryColor: string;
  disabled: boolean;
  onRemove: (providerName: string) => void;
}

function SortableRow({
  provider,
  index,
  primaryColor,
  disabled,
  onRemove,
}: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.name, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : "auto",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`provider-row${disabled ? " provider-row--disabled" : ""}`}
      aria-busy={disabled || undefined}
    >
      <button
        type="button"
        className="provider-row__handle"
        aria-label={`Drag ${provider.name}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </button>
      <Typography.Text type="secondary" className="provider-row__rank">
        {index + 1}.
      </Typography.Text>
      <div className="provider-row__body">
        <Tag
          color={index === 0 ? primaryColor : "default"}
          className="provider-row__provider-tag"
        >
          {provider.name}
        </Tag>
        <Typography.Text className="provider-row__remap" title={provider.remap}>
          {provider.remap}
        </Typography.Text>
      </div>
      <button
        type="button"
        className="provider-row__remove"
        aria-label={`Remove ${provider.name}`}
        disabled={disabled}
        onClick={() => onRemove(provider.name)}
      >
        <CloseOutlined />
      </button>
    </div>
  );
}

export function ProviderPriorityList({
  providers,
  primaryColor,
  onReorder,
  onRemove,
  disabled = false,
}: ProviderPriorityListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Local draft order kept in sync with the upstream `providers` prop. After a
  // drag-end we synchronously set the draft so the very next render reflects
  // the new order — without this, dnd-kit clears the visual transform before
  // React Query's optimistic update reaches the DOM, producing a single-frame
  // "snap back" to the old order.
  const [draftOrder, setDraftOrder] = React.useState<string[] | null>(null);

  const propsOrder = React.useMemo(
    () => providers.map((p) => p.name),
    [providers],
  );

  // If the upstream order catches up to (or diverges from) our draft, drop it
  // and follow props again. We do this during render so the next paint always
  // reflects either the user's intent or the freshest server state.
  if (draftOrder) {
    const matchesProps =
      draftOrder.length === propsOrder.length &&
      draftOrder.every((name, i) => name === propsOrder[i]);
    if (matchesProps) {
      // Schedule clearing the draft; safe to call in render because React
      // de-dupes identical setState calls.
      setDraftOrder(null);
    }
  }

  const effectiveOrder = draftOrder ?? propsOrder;
  const orderedProviders = React.useMemo(() => {
    const byName = new Map(providers.map((p) => [p.name, p]));
    const ordered: ProviderEntry[] = [];
    for (const name of effectiveOrder) {
      const entry = byName.get(name);
      if (entry) ordered.push(entry);
    }
    // Defensive: surface any providers that arrived via props but aren't yet
    // represented in the draft (e.g. background refetch added a new one).
    for (const provider of providers) {
      if (!effectiveOrder.includes(provider.name)) ordered.push(provider);
    }
    return ordered;
  }, [providers, effectiveOrder]);

  const items = React.useMemo(
    () => orderedProviders.map((p) => p.name),
    [orderedProviders],
  );

  function handleDragEnd(event: DragEndEvent) {
    if (disabled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.indexOf(String(active.id));
    const newIndex = items.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const nextOrder = arrayMove(items, oldIndex, newIndex);
    setDraftOrder(nextOrder);
    onReorder(nextOrder);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div
          className={`provider-priority-list${disabled ? " provider-priority-list--disabled" : ""}`}
        >
          {orderedProviders.map((provider, index) => (
            <SortableRow
              key={provider.name}
              provider={provider}
              index={index}
              primaryColor={primaryColor}
              disabled={disabled}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
