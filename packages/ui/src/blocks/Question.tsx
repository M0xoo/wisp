// The `question` block (v1 R.question): the agent's question with its numbered options. Live only on the task's
// latest answer (BlockContext.latest): a click sends the option (its own reply when it has one); Answer in my own
// words puts the reply box in front. On an earlier answer it reads "Agent asked", greyed, its options inert.
import { For, Show, type JSX } from "solid-js";
import { Icon } from "../content/Icon.tsx";
import { Wrap } from "../layout/Stack.tsx";
import { InlineMd } from "./content-parts.tsx";
import { useBlockT, useBlocks } from "./context.tsx";
import { items, opt, str } from "./read.ts";
import type { BlockProps } from "./types.ts";

interface Option {
  readonly label: string;
  readonly detail: string | undefined;
  readonly reply: string;
}

export function QuestionBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const live = (): boolean => ctx.latest === true && !!ctx.reply;
  const options = (): Option[] =>
    items<Option>(
      props.block["options"],
      (o) => ({
        label: str(o["label"]),
        detail: opt(o["detail"]),
        reply: opt(o["reply"]) ?? str(o["label"]),
      }),
      (s) => ({ label: s, detail: undefined, reply: s }),
    ).filter((o) => o.label);
  return (
    <div
      data-kit="rb-question"
      data-part="block.question"
      data-answered={live() ? undefined : ""}
    >
      <div data-kit="rb-q-head">
        <Icon name="ask" size="sm" />
        <span>
          {live() ? t("block.question.live") : t("block.question.asked")}
        </span>
      </div>
      <p data-kit="rb-q-text">
        <InlineMd
          source={str(props.block["question"])}
          part="block.question.text"
        />
      </p>
      <Wrap gap="4" part="block.question.options">
        <For each={options()}>
          {(o, i) => (
            <button
              type="button"
              data-kit="rb-opt"
              data-part="block.question.option"
              disabled={!live()}
              onClick={() => ctx.reply?.(o.reply)}
            >
              <span data-kit="rb-opt-k">{i() + 1}</span>
              <span>
                {o.label}
                <Show when={o.detail}>{(d) => <small>{d()}</small>}</Show>
              </span>
            </button>
          )}
        </For>
        <Show when={live() && ctx.draft}>
          <button
            type="button"
            data-kit="rb-opt"
            data-own=""
            onClick={() => ctx.draft?.("")}
          >
            <Icon name="pen" size="sm" />
            {t("block.question.own")}
          </button>
        </Show>
      </Wrap>
    </div>
  );
}
