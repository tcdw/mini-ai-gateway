# AI Gateway - 20260518 Provider 优先级拖拽排序

## 背景

Admin Web UI 的 Models 表格里，每个 model × 每个 protocol 单元格都需要展示并管理一组 provider 的优先级（第一名命中，后续按 fallback 顺序 retry）。之前的实现是 antd `Tag` 列表 + 一个 `Select` 多选框：

- `Tag` 负责展示「序号 + provider 名 → remap」，自带 `closable` 用于删除 mapping；
- 重新排序得在下方那个 `mode="multiple"` 的 `Select` 里手动调整选项顺序——交互非常反直觉，用户得清楚「点选顺序 = 优先级顺序」这个隐性约定；
- `Tag` 的「名 → remap」全部塞在一行，长 remap（比如 `anthropic/claude-sonnet-4.6`）会把 Tag 撑得很宽，三个 provider 一字排开后 cell 横向溢出。

这次迭代的目标就是把这个不直观的 Select 干掉，换成所见即所得的拖拽排序，同时把 provider 名和 remap 拆成两行降低单行宽度。

## 主要变更

### 1. 引入 `@dnd-kit` 作为拖拽方案

在 `apps/admin` 下新增依赖：

```jsonc
// apps/admin/package.json
"@dnd-kit/core": "^6.3.1",
"@dnd-kit/sortable": "^10.0.0",
"@dnd-kit/utilities": "^3.2.2",
```

之所以选 dnd-kit 而不是 react-dnd / antd 自带的 sortable demo：包小、a11y 友好（自带键盘排序）、不强依赖 HTML5 drag API、和 antd 没有样式冲突。

### 2. 新增 `ProviderPriorityList` 组件

`apps/admin/src/components/ProviderPriorityList.tsx`，封装一个垂直可排序列表，每行结构是 `[拖拽手柄] [序号] [provider tag + remap] [删除按钮]`：

```tsx
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
```

`SortableRow` 内部用 `useSortable({ id: provider.name })` 拿到 `setNodeRef` / `attributes` / `listeners`，并把 listeners 只绑在拖拽手柄按钮上，避免整行都可拖拽（否则会跟删除按钮、Tag 的点击冲突）：

```tsx
<button
  type="button"
  className="provider-row__handle"
  aria-label={`Drag ${provider.name}`}
  {...attributes}
  {...listeners}
>
  <HolderOutlined />
</button>
```

PointerSensor 设 `activationConstraint: { distance: 4 }`，避免轻微抖动触发拖拽；KeyboardSensor 走 `sortableKeyboardCoordinates`，支持空格抓取 + 方向键移动。

参考：`apps/admin/src/components/ProviderPriorityList.tsx:41`、`apps/admin/src/components/ProviderPriorityList.tsx:101`。

### 3. ModelsPage 接入新组件

`apps/admin/src/main.tsx` 里 protocol 列的 render 函数从原来的 `Space + Tag[] + Select` 三件套简化为一个 `<ProviderPriorityList>`：

```tsx
...PROTOCOLS.map<ColumnsType<AdminModelRoute>[number]>((protocol) => ({
  title: PROTOCOL_LABELS[protocol],
  dataIndex: ["protocols", protocol],
  width: 260,
  render: (_, record) => {
    const providers = record.protocols[protocol]?.providers ?? [];
    if (providers.length === 0) {
      return <Typography.Text type="secondary">—</Typography.Text>;
    }
    return (
      <div className="protocol-cell">
        <ProviderPriorityList
          providers={providers}
          primaryColor={PROTOCOL_COLORS[protocol]}
          onReorder={(next) =>
            reorder.mutate({ modelId: record.id, protocol, providers: next })
          }
          onRemove={(providerName) =>
            remove.mutate({ modelId: record.id, protocol, provider: providerName })
          }
        />
      </div>
    );
  },
})),
```

`onReorder` 复用了已有的 `reorderProviders` mutation（PATCH `/admin/api/models/:id/providers`），后端无需任何改动。

参考：`apps/admin/src/main.tsx:146`。

### 4. CSS：两行布局 + 拖拽视觉反馈

`apps/admin/src/style.css` 新增一组 `.provider-priority-list` / `.provider-row` 样式。关键点：

- `.provider-row` 用 flex 横向布局，`align-items: flex-start` 让手柄/序号顶部对齐 Tag；
- `.provider-row__body` 是中间的两行容器（Tag 在上，remap 在下），`flex: 1 1 auto; min-width: 0` 保证长 remap 文本能被 `word-break: break-all` 撑住而不撑爆行宽；
- `.provider-row__remap` 用 11px monospace + `rgba(0,0,0,0.55)`，视觉上明显弱于 Tag，避免抢戏；
- 拖拽手柄 `cursor: grab`，按下时 `cursor: grabbing`，hover 时背景轻微变深；
- 删除按钮 hover 时变红，提示破坏性操作。

```css
.provider-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 4px 0;
  min-width: 0;
}

.provider-row__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.provider-row__remap {
  display: block;
  max-width: 100%;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(0, 0, 0, 0.55);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
```

参考：`apps/admin/src/style.css:107`、`apps/admin/src/style.css:172`。

### 5. 修复删除按钮被切成 `>` 的视觉 bug

集成完毕后发现一个诡异现象：在 OpenAI 列里，每个 row 右侧本该是 `×` 的删除按钮，肉眼看上去只剩左半边，像一个 `>` 符号。一开始误判成 hover 背景叠加导致的「cutoff」，反复调 `:hover` 样式都无效。

最后通过 devtools 实测才发现真相：

- 之前 `.protocol-cell { min-width: 260px }` 强制内容宽度 260px；
- 但 antd Table 的 protocol column 没有显式 `width`，实际只分配了 251px；
- 加上 `.provider-priority-list { padding: 4px 8px }` 的左右 padding，`.provider-row__remove` 按钮的右边界刚好超出 td 9~11px；
- antd Table 单元格默认 `overflow: hidden`，于是按钮的右半边被裁掉 → 看起来像 `>`。

修法是显式给 column 加 `width: 260`、把 `.protocol-cell` 的 `min-width` 改成 `0`、`.provider-priority-list` 左右 padding 去掉：

```css
.protocol-cell {
  min-width: 0;
}

.provider-priority-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}
```

```tsx
// apps/admin/src/main.tsx
...PROTOCOLS.map<ColumnsType<AdminModelRoute>[number]>((protocol) => ({
  title: PROTOCOL_LABELS[protocol],
  dataIndex: ["protocols", protocol],
  width: 260,
  // ...
}))
```

## 验证

```bash
bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities  # in apps/admin
bunx tsc --noEmit                                             # zero errors
```

手动验证：

- 在 `openai/gpt-5.5` 行的 OpenAI 列把 `[openrouter, vercel, aihubmix]` 拖成 `[aihubmix, vercel, openrouter]` 再拖成 `[vercel, openrouter, aihubmix]`，Network 面板观察到 `PATCH /admin/api/models/openai%2Fgpt-5.5/providers` 返回 200，刷新后顺序持久化；
- 删除按钮点击触发 `DELETE /admin/api/models/:id/providers/:provider`，mapping 实际从 `config.json` 中移除；
- 键盘 a11y：Tab 聚焦到拖拽手柄，按空格抓取，方向键移动，再次空格落位——dnd-kit 自带的 sortableKeyboardCoordinates 工作正常；
- 视觉：所有 row 右侧 `×` 完整显示，长 remap（如 `anthropic/claude-sonnet-4.6`）在 body 内换行而不撑破 cell。

## 提交

```txt
58b9b30 feat: replace provider multi-select with dnd-kit drag-and-drop priority list
```
