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
}

interface SortableRowProps {
  provider: ProviderEntry;
  index: number;
  primaryColor: string;
  onRemove: (providerName: string) => void;
}

function SortableRow({ provider, index, primaryColor, onRemove }: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.name });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : "auto",
  };

  return (
    <div ref={setNodeRef} style={style} className="provider-row">
      <button
        type="button"
        className="provider-row__handle"
        aria-label={`Drag ${provider.name}`}
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
}: ProviderPriorityListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const items = React.useMemo(() => providers.map((p) => p.name), [providers]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.indexOf(String(active.id));
    const newIndex = items.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="provider-priority-list">
          {providers.map((provider, index) => (
            <SortableRow
              key={provider.name}
              provider={provider}
              index={index}
              primaryColor={primaryColor}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
