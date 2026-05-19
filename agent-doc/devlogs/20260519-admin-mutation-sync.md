# AI Gateway - 20260519 Admin Mutation 同步与拖拽体验修复

## 背景

20260518 上线 dnd-kit 拖拽排序之后，admin panel 暴露出三个相互独立但层层递进的体验问题：

1. **改动不反映到 UI**：拖拽改顺序、删除 mapping、改 endpoint 之后，UI 仍然是旧数据，只有手动刷新整页才能看到最新状态。最离谱的是拖拽——松手之后元素直接弹回原位，肉眼以为操作根本没生效。
2. **拖拽闪烁**：上述「弹回原位」修复后，新顺序终于能落下来，但仍能看到一帧的「先弹回旧位置 → 再跳到新位置」过渡，依旧抢眼。
3. **并发竞态**：所有 mutation 都是异步 + 乐观更新，用户在请求飞行期间继续操作（连续拖、拖完再点删除等）会让多个 in-flight optimistic update 互相覆盖，最终落地的状态不可预测。

本次迭代用一系列从「数据层 → 渲染层 → 交互层」的渐进式修复把这三个问题一并解决。

## 主要变更

### 1. 修 query key 不匹配，让 mutation 结果立即写回订阅者

之前 `useGatewayConfig` 用的是 `["gateway-config", authRevision]`，但所有 mutation 的 `onSuccess` 都写到 `["gateway-config"]`——两个 key 不匹配，setQueryData 写入了一个没人订阅的 cache 槽位，所以 UI 永远拿到旧数据，只有刷新页面重新走 `getConfig` 才能从服务端拉到新状态。

把 query key 提取成共享常量，并通过 `invalidateQueries` 兼容 authRevision 切换语义：

```ts
// apps/admin/src/main.tsx
const GATEWAY_CONFIG_QUERY_KEY = ["gateway-config"] as const;

function useGatewayConfig() {
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const authRevision = useAdminStore((store) => store.authRevision);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    queryClient.invalidateQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
  }, [authRevision]);

  return useQuery({
    queryKey: GATEWAY_CONFIG_QUERY_KEY,
    queryFn: getConfig,
    enabled: gatewayApiKey.trim().length > 0,
  });
}
```

所有 `reorder` / `remove` / `addMapping` / `upsertEndpoint` / `deleteEndpoint` 的 `setQueryData` 也都改用同一个常量，彻底消除 key drift。

参考：`apps/admin/src/main.tsx:74`。

### 2. 给 reorder / remove 加乐观更新 + 回滚

仅修 query key 还不够——mutation 是异步的，从松手到服务端响应回来这段时间，UI 仍然渲染旧数据。引入 React Query 的标准乐观更新流程：

```ts
const reorder = useMutation({
  mutationFn: reorderProviders,
  onMutate: async ({ modelId, protocol, providers: nextOrder }) => {
    await queryClient.cancelQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
    const previous = queryClient.getQueryData<AdminConfigSnapshot>(
      GATEWAY_CONFIG_QUERY_KEY,
    );
    if (previous) {
      queryClient.setQueryData<AdminConfigSnapshot>(
        GATEWAY_CONFIG_QUERY_KEY,
        reorderProvidersInSnapshot(previous, modelId, protocol, nextOrder),
      );
    }
    return { previous };
  },
  onError: (error, _vars, context) => {
    if (context?.previous) {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, context.previous);
    }
    message.error(error.message);
  },
  onSuccess: (data) => {
    queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
    message.success("Priority saved");
  },
});
```

辅助函数 `mapModelRoute` / `reorderProvidersInSnapshot` / `removeProviderFromSnapshot` 都是不可变地构造下一帧的 snapshot，方便 React Query diff。

参考：`apps/admin/src/main.tsx:96`、`apps/admin/src/main.tsx:195`。

### 3. 拖拽闪烁的真正原因：dnd-kit transform 重置 vs React rerender 时序

加完乐观更新之后，依然能看到一帧闪烁。用 chrome-devtools 录下逐帧 DOM 状态后看清了时序：

| dt (ms) | 列表顺序 | transform | 说明                                              |
| ------- | -------- | --------- | ------------------------------------------------- |
| 0       | 旧顺序   | 无        | 初始                                              |
| 拖拽中  | 旧顺序   | 有        | dnd-kit 用 transform 视觉上预览成新顺序           |
| drop+1帧 | **旧顺序** | **无**  | 🚨 transform 已清，但 React props 还没更新（弹回）|
| drop+~100ms | 新顺序 | 无        | onMutate → setQueryData → rerender，新顺序落地    |

根因是：dnd-kit 在松手瞬间**同步**清除 transform；但 React Query 的 setQueryData → 订阅者 rerender 至少要等到下一轮微任务/宏任务循环，新顺序的 DOM 大约 100ms 后才到位。中间这一帧就是「弹回」。

修法是在 `ProviderPriorityList` 内部维护一个本地草稿态 `draftOrder`，在 `handleDragEnd` 里**同步**用 setState 写入，React 会把这次 setState 和 dnd-kit 清 transform 合并到同一个 commit，下一帧渲染就是新顺序：

```tsx
// apps/admin/src/components/ProviderPriorityList.tsx
const [draftOrder, setDraftOrder] = React.useState<string[] | null>(null);

const propsOrder = React.useMemo(() => providers.map((p) => p.name), [providers]);

if (draftOrder) {
  const matchesProps =
    draftOrder.length === propsOrder.length &&
    draftOrder.every((name, i) => name === propsOrder[i]);
  if (matchesProps) {
    setDraftOrder(null);
  }
}

const effectiveOrder = draftOrder ?? propsOrder;
// ...用 effectiveOrder 重排 providers，渲染 + 传给 SortableContext...

function handleDragEnd(event: DragEndEvent) {
  if (disabled) return;
  // ...
  const nextOrder = arrayMove(items, oldIndex, newIndex);
  setDraftOrder(nextOrder);
  onReorder(nextOrder);
}
```

草稿的清除策略：在 render 阶段直接比对 `propsOrder`，一旦上游缓存追上草稿就 `setDraftOrder(null)`，自动跟随 props（mutation 失败回滚时也能正确恢复）。

参考：`apps/admin/src/components/ProviderPriorityList.tsx:115`。

### 4. 表级 disabled 锁，阻止并发竞态

任何 reorder / remove mutation pending 期间，整张表的拖拽手柄和删除按钮都禁用，避免多个乐观更新互相覆盖：

```tsx
// apps/admin/src/main.tsx
const isMutating = reorder.isPending || remove.isPending;

// 列渲染时透传
<ProviderPriorityList
  providers={providers}
  primaryColor={PROTOCOL_COLORS[protocol]}
  disabled={isMutating}
  onReorder={...}
  onRemove={...}
/>
```

`ProviderPriorityList` 把 disabled 透传到三处兜底：

- `useSortable({ id, disabled })`：dnd-kit 内核级禁用，连 PointerSensor 都不会激活；
- 手柄按钮和删除按钮的 `disabled` 属性；
- `handleDragEnd` 入口的 `if (disabled) return` 守卫。

CSS 上整个列表加 `opacity: 0.6`，按钮加 `cursor: not-allowed`，肉眼能看出「不可交互」状态：

```css
.provider-priority-list--disabled {
  opacity: 0.6;
}

.provider-row__handle:disabled,
.provider-row__remove:disabled {
  cursor: not-allowed;
  color: rgba(0, 0, 0, 0.25);
  background: transparent;
}
```

参考：`apps/admin/src/components/ProviderPriorityList.tsx:48`、`apps/admin/src/style.css:204`。

## 验证

```bash
bunx tsc --noEmit  # zero errors
```

用 chrome-devtools 在浏览器里实测（节流 Slow 4G 方便观察）：

**拖拽闪烁修复前后对比**（首格 gpt-5.5，把 vercel 拖到底部）：

| 阶段       | 旧版（有bug）                  | 新版（修复后）                |
| ---------- | ------------------------------ | ----------------------------- |
| 拖前       | vercel, aihubmix, openrouter   | vercel, openrouter, aihubmix  |
| 拖拽中     | 带 transform                   | 带 transform                  |
| **drop+1帧** | **vercel, aihubmix, openrouter（旧顺序！）⚠️** | **openrouter, aihubmix, vercel（新顺序！）✅** |
| 请求结束   | 跳到正确顺序                   | 已经在正确顺序，无变化        |

**Disabled 锁时序**：

| dt (ms) | listDisabled | handleDisabled | removeDisabled | 事件                    |
| ------- | ------------ | -------------- | -------------- | ----------------------- |
| 0       | false        | false          | false          | 初始                    |
| 5476    |              |                |                | PATCH 请求发出          |
| 5598    | **true**     | **true**       | **true**       | 🔒 mutation 进入 pending |
| 6057    |              |                |                | 服务端返回 200          |
| 6228    | **false**    | **false**      | **false**      | 🔓 mutation 完成        |

整张表在 mutation 飞行期间全部禁用（约 600ms），完成后自动解禁。

## 提交

```txt
f87cbe2 fix(admin): keep provider list in sync after mutations
```
