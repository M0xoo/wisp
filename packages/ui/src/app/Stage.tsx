// The app's frame, as v1 draws it (web/css/split.css, crew.css, layout.css): the crew rail on the
// window's edge, the sidebar as a raised panel beside it (its head: the brand, Search, the avatar,
// the sidebar button and the project chips; its body: New task and the list), the main pane, and the
// grip on the sidebar's edge. Split (≥ 900 px) shows them side by side; stack shows one page.
// Every element carries v1's PARTS name (web/js/spell-schema.js) as its data-part.
import { For, Show, type JSX } from 'solid-js';
import { flag, type PartName } from '../core/props.ts';
import { reorderable, type OnReorder } from '../core/reorder.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { Spirit } from '../crew/Spirit.tsx';
import { WithAct, type Act } from './act.tsx';

export type StagePage = 'list' | 'main';

export interface StageProps {
  readonly layout: 'split' | 'stack';
  /** stack only: the page on screen */
  readonly page: StagePage;
  readonly rail?: JSX.Element;
  readonly head: JSX.Element;
  readonly list: JSX.Element;
  readonly main: JSX.Element;
  /** v1 #panel: the pane beside the open task (Changes, Shell, PR), the window's full height at its right edge.
   *  Stacked (a phone), it covers the task as its own page, closed with its own close. */
  readonly side?: JSX.Element;
  readonly gripLabel: string;
  /** stack, main page: the list stays laid out behind it (Home's prompt box opened from the list) */
  readonly listBehind?: boolean;
  /** the page is the window's title bar, its buttons over the top-left corner (the desktop app on a
   * Mac, v1 body.desktop.mac): room for them, and the top bar, rail and task head drag the window */
  readonly titlebar?: 'mac';
  readonly onGripReset?: () => void;
  /** split with the rail: the picked crew member's colour (a crew colour name); the list and its top bar take a very
   *  light wash of it (v1 #768 .crew-tint) */
  readonly tint?: string | undefined;
}

/** v1 #stage: the rail, the sidebar's head and body, the main pane, the grip. */
export function Stage(props: StageProps): JSX.Element {
  return (
    <main
      data-kit="stage"
      data-part="shell.app"
      data-layout={props.layout}
      data-page={props.page}
      data-behind={flag(props.listBehind)}
      data-titlebar={props.titlebar}
      data-rail={flag(props.rail !== undefined)}
      data-side={flag(props.side !== undefined)}
    >
      {props.layout === 'split' ? props.rail : null}
      <header data-kit="topbar" data-part="topbar" data-drag={flag(props.titlebar !== undefined)} data-tint={flag(!!props.tint)} data-color={props.tint || undefined}>
        {props.head}
      </header>
      <div data-kit="feed-wrap" data-part="sidebar" inert={props.layout === 'stack' && props.page === 'main'} data-tint={flag(!!props.tint)} data-color={props.tint || undefined}>
        {props.list}
      </div>
      <section data-kit="split-main" data-part="split.main">
        {props.main}
      </section>
      <Show when={props.side}>
        <aside data-kit="side-pane" data-part="side">
          {props.side}
        </aside>
      </Show>
      <Show when={props.layout === 'split'}>
        <div data-kit="split-grip" data-part="sidebar.grip" role="separator" aria-orientation="vertical" aria-label={props.gripLabel} onDblClick={() => props.onGripReset?.()} />
      </Show>
    </main>
  );
}

export interface RailMember {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  /** the member's colour (v1 c-<colour>) */
  readonly color: string;
}

export interface CrewRailProps {
  readonly label: string;
  readonly allLabel: string;
  readonly orgLabel: string;
  readonly addLabel: string;
  /** the list beside it shows every task (All picked) */
  readonly allOn: boolean;
  readonly members: readonly RailMember[];
  readonly onAll?: () => void;
  readonly onMember?: (id: string) => void;
  readonly onOrg?: () => void;
  readonly onAdd?: () => void;
}

function RailBtn(props: { readonly icon: IconName; readonly label: string; readonly part: string; readonly kind: string; readonly on?: boolean; readonly onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-kit="cl-btn"
      data-a={props.kind}
      data-part={props.part}
      data-on={flag(props.on)}
      aria-label={props.label}
      title={props.label}
      aria-current={props.on ? 'page' : undefined}
      onClick={() => props.onClick?.()}
    >
      <Show when={props.on !== undefined}>
        <i data-kit="cl-pip" data-part="crew.rail.pick" />
      </Show>
      <Icon name={props.icon} />
    </button>
  );
}

/** v1 #crewRail: All, the members' faces, then Org and + at the foot. */
export function CrewRail(props: CrewRailProps): JSX.Element {
  return (
    <nav data-kit="cl-rail" data-part="crew.rail" aria-label={props.label} data-drag="">
      <RailBtn icon="feed" label={props.allLabel} part="crew.rail.all" kind="all" on={props.allOn} onClick={() => props.onAll?.()} />
      <div data-kit="cl-faces">
        <For each={props.members}>
          {(m) => (
            <button type="button" data-kit="cl-face" data-part="crew.rail.face" aria-label={m.name} title={m.name} onClick={() => props.onMember?.(m.id)}>
              <i data-kit="cl-pip" data-part="crew.rail.pick" />
              <span data-kit="cl-av">
                <span data-kit="cr-av" data-part="crew.avatar" data-color={m.color}>
                  <Spirit code={m.avatar} seed={m.name} />
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
      <div data-kit="cl-foot">
        <RailBtn icon="org" label={props.orgLabel} part="crew.org" kind="org" onClick={() => props.onOrg?.()} />
        <RailBtn icon="plus" label={props.addLabel} part="crew.add" kind="add" onClick={() => props.onAdd?.()} />
      </div>
    </nav>
  );
}

export interface ProjectChip {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** a project colour (v1's c-<colour>); undefined for All */
  readonly color?: string;
  readonly need: number;
  readonly needLabel: string;
}

export interface SidebarHeadProps {
  readonly brandLabel: string;
  readonly searchLabel: string;
  readonly accountLabel: string;
  readonly viewLabel: string;
  readonly manageLabel: string;
  readonly chips: readonly ProjectChip[];
  /** the chip on (All is '') */
  readonly on: string;
  /** one selector instead of the row of chips (owner, 2026-11-12): the project on, a ▾, and this opens the switcher */
  readonly onSwitch?: () => void;
  /** the selector's tip ("Switch project ⌘P") */
  readonly switchLabel?: string;
  readonly onBrand?: () => void;
  /** Home is open: the brand (which goes there) is where you are */
  readonly homeOn?: boolean;
  readonly onSearch?: () => void;
  readonly onAccount?: () => void;
  readonly onView?: () => void;
  readonly onChip?: (id: string) => void;
  /** drag a project chip (or Alt+←/→) into your own order (v1 #772); All stays first */
  readonly onReorder?: OnReorder;
  readonly onManage?: () => void;
  readonly accountAct?: Act;
  readonly manageAct?: Act;
  /** what plugins put in the head (v1's spell SLOTS on #topbar): `lead` sits beside the brand, `chips`
   * after the project chips; brand, search, account and view replace the built-in one when given */
  readonly slots?: {
    readonly lead?: JSX.Element;
    readonly chips?: JSX.Element;
    readonly brand?: JSX.Element;
    readonly search?: JSX.Element;
    readonly account?: JSX.Element;
    readonly view?: JSX.Element;
  };
}

/** v1's row of project chips (draggable into your order): what the head shows without a switcher. */
function Chips(props: SidebarHeadProps & { readonly projectIds: () => string[] }): JSX.Element {
  return (
    <div data-kit="p-scroll">
      <For each={props.chips}>
        {(c) => (
          <button
            type="button"
            {...reorderable('topbar.projects', c.id, props.projectIds, c.color === undefined ? undefined : props.onReorder)}
            data-kit="p-chip"
            data-on={flag(props.on === c.id)}
            aria-current={props.on === c.id ? 'true' : undefined}
            data-color={c.color ?? 'slate'}
            title={c.title}
            onClick={() => props.onChip?.(c.id)}
          >
            <Show when={c.color}>
              <i data-kit="p-dot" />
            </Show>
            <span data-text="control">{c.name}</span>
            <Show when={c.need > 0}>
              <span data-kit="p-need" title={c.needLabel}>
                {c.need}
              </span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}

/** v1 #topbar in split: the brand, Search, the avatar, the sidebar button, then the project chips. */
export function SidebarHead(props: SidebarHeadProps): JSX.Element {
  const projectIds = (): string[] => props.chips.filter((c) => c.color !== undefined).map((c) => c.id);
  return (
    <>
      <div data-kit="tb-lead">
        {props.slots?.brand ?? (
          <a
            data-kit="brand"
            data-part="topbar.brand"
            href="#"
            aria-current={props.homeOn ? 'page' : undefined}
            title={props.brandLabel}
            aria-label={props.brandLabel}
            onClick={(e) => (e.preventDefault(), props.onBrand?.())}
          >
            <span data-kit="brand-orb" />
          </a>
        )}
        {props.slots?.lead}
      </div>
      <div data-kit="projects" data-part="topbar.projects" data-no-drag="">
        <Show when={props.onSwitch} fallback={<Chips {...props} projectIds={projectIds} />}>
          {(open) => {
            const cur = (): ProjectChip | undefined => props.chips.find((c) => c.id === props.on) ?? props.chips[0];
            return (
              <button type="button" data-kit="p-select" data-part="topbar.project-select" data-color={cur()?.color ?? 'slate'} title={props.switchLabel} aria-label={props.switchLabel} aria-haspopup="dialog" onClick={() => open()()}>
                <Show when={cur()?.color} fallback={<Icon name="feed" />}>
                  <i data-kit="p-dot" />
                </Show>
                <span data-kit="p-name" data-text="control">{cur()?.name}</span>
                <Show when={(cur()?.need ?? 0) > 0}>
                  <span data-kit="p-need" title={cur()?.needLabel}>
                    {cur()?.need}
                  </span>
                </Show>
                <Icon name="chevron" />
              </button>
            );
          }}
        </Show>
        {props.slots?.chips}
        <WithAct
          act={props.manageAct ?? { onClick: () => props.onManage?.() }}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="p-chip" data-add="" title={props.manageLabel} aria-label={props.manageLabel}>
              <Icon name="plus" />
            </button>
          )}
        />
      </div>
      <div data-kit="tb-view">
        {props.slots?.view ?? (
          <button type="button" data-kit="view-btn" data-part="topbar.view" title={props.viewLabel} aria-label={props.viewLabel} onClick={() => props.onView?.()}>
            <Icon name="split" />
          </button>
        )}
      </div>
      <div data-kit="tb-search">
        {props.slots?.search ?? (
          <button type="button" data-kit="search-btn" data-part="topbar.search" title={props.searchLabel} aria-label={props.searchLabel} onClick={() => props.onSearch?.()}>
            <Icon name="search" />
          </button>
        )}
      </div>
      <div data-kit="tb-account">
        {props.slots?.account ?? (
          <WithAct
            act={props.accountAct ?? { onClick: () => props.onAccount?.() }}
            render={(trigger) => (
              <button type="button" {...trigger()} data-kit="me-btn" data-part="sidebar.foot" title={props.accountLabel} aria-label={props.accountLabel}>
                <span data-kit="sf-av" data-part="topbar.account">
                  <Icon name="user" />
                </span>
              </button>
            )}
          />
        )}
      </div>
    </>
  );
}

export interface SplitTopProps {
  readonly newLabel: string;
  readonly newTitle: string;
  readonly stuffLabel: string;
  /** Home is open beside it */
  readonly on: boolean;
  readonly onNew?: () => void;
  readonly onStuff?: () => void;
}

/** v1 .split-top: New task (a small prompt box) and My Stuff. */
export function SplitTop(props: SplitTopProps): JSX.Element {
  return (
    <div data-kit="split-top">
      <div data-kit="st-row">
        <button type="button" data-kit="split-new" data-part="sidebar.new" data-on={flag(props.on)} aria-current={props.on ? 'page' : undefined} title={props.newTitle} onClick={() => props.onNew?.()}>
          <Icon name="plus" />
          <span data-text="control">{props.newLabel}</span>
          <kbd>N</kbd>
        </button>
        <button type="button" data-kit="split-stuff" data-part="stuff.button" title={props.stuffLabel} aria-label={props.stuffLabel} onClick={() => props.onStuff?.()}>
          <Icon name="stuff" />
        </button>
      </div>
    </div>
  );
}

export interface FeedSectionProps {
  /** v1's section id: needs, working, done … (its part is section.<id>) */
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly children?: JSX.Element;
}

/** v1 #feed .item: one task's row in a feed, its 1px border (transparent at rest) around the row's head. */
export function FeedItem(props: { readonly part?: PartName; readonly children?: JSX.Element }): JSX.Element {
  return (
    <div data-kit="feed-item" data-part={props.part ?? 'ui.feed-item'}>
      {props.children}
    </div>
  );
}

/** v1 #feed: the sections, each a heading that folds it and its rows. */
export function Feed(props: { readonly children?: JSX.Element }): JSX.Element {
  return (
    <div data-kit="feed" data-part="feed">
      {props.children}
    </div>
  );
}

export function FeedSection(props: FeedSectionProps): JSX.Element {
  return (
    <section data-kit="f-group" data-part={`section.${props.id}`} data-collapsed={flag(props.collapsed)}>
      <h4 data-kit="sec-toggle" data-part="section.heading" role="button" tabindex="0" aria-expanded={!props.collapsed} onClick={() => props.onToggle?.()}>
        <Icon name="chevron" />
        <span data-kit="sec-name" data-text="control">
          {props.name}
        </span>
        <span data-kit="sec-n">{props.count}</span>
      </h4>
      <Show when={!props.collapsed}>
        <div data-kit="f-list">{props.children}</div>
      </Show>
    </section>
  );
}
