// The `next` block (v1 R.next): Follow up, and a chip per suggestion. A click puts it in the reply box
// (BlockContext.draft) to read first; ⌘/Ctrl-click sends it at once (reply). An item may carry its own reply.
import { For, Show, type JSX } from "solid-js";
import { Icon } from "../content/Icon.tsx";
import { Wrap } from "../layout/Stack.tsx";
import { useBlockT, useBlocks } from "./context.tsx";
import { items, opt, str } from "./read.ts";
import type { BlockProps } from "./types.ts";

interface Chip {
  readonly label: string;
  readonly reply: string;
}

export function NextBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const chips = (): Chip[] =>
    items<Chip>(
      props.block["items"],
      (o) => ({
        label: str(o["label"]),
        reply: opt(o["reply"]) ?? str(o["label"]),
      }),
      (s) => ({ label: s, reply: s }),
    ).filter((c) => c.label);
  const pick = (c: Chip, e: MouseEvent): void => {
    if ((e.metaKey || e.ctrlKey || !ctx.draft) && ctx.reply) ctx.reply(c.reply);
    else ctx.draft?.(c.reply);
  };
  return (
    <Show when={chips().length > 0}>
      <div data-kit="rb-next" data-part="block.next">
        <div data-kit="rb-next-head">
          <Icon name="spark" size="sm" />
          {t("block.next.head")}
        </div>
        <Wrap gap="3" part="block.next.chips">
          <For each={chips()}>
            {(c, i) => (
              <button
                type="button"
                data-kit="rb-chip"
                data-part="block.next.chip"
                style={{ "--k": String(i()) }}
                disabled={!ctx.reply && !ctx.draft}
                onClick={(e) => pick(c, e)}
              >
                {c.label}
              </button>
            )}
          </For>
        </Wrap>
      </div>
    </Show>
  );
}
