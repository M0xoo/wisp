// The app's frame, as v1 draws it (web/css/split.css, crew.css, layout.css): the crew rail on the
// window's edge, the sidebar as a raised panel beside it (its head: the brand, Search, the avatar,
// the sidebar button and the project chips; its body: New task and the list), the main pane, and the
// grip on the sidebar's edge. Split (≥ 900 px) shows them side by side; stack shows one page.
// Every element carries v1's PARTS name (web/js/spell-schema.js) as its data-part.
import { For, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { Spirit } from '../crew/Spirit.tsx';

export type StagePage = 'list' | 'main';

export interface StageProps {
  readonly layout: 'split' | 'stack';
  /** stack only: the page on screen */
  readonly page: StagePage;
  readonly rail?: JSX.Element;
  readonly head: JSX.Element;
  readonly list: JSX.Element;
  readonly main: JSX.Element;
  readonly gripLabel: string;
  /** stack, main page: the list stays laid out behind it (Home's prompt box opened from the list) */
  readonly listBehind?: boolean;
  readonly onGripReset?: () => void;
}

/** v1 #stage: the rail, the sidebar's head and body, the main pane, the grip. */
export function Stage(props: StageProps): JSX.Element {
  return (
    <main data-kit="stage" data-part="shell.app" data-layout={props.layout} data-page={props.page} data-behind={flag(props.listBehind)} data-rail={flag(props.rail !== undefined)}>
      {props.layout === 'split' ? props.rail : null}
      <header data-kit="topbar" data-part="topbar">{props.head}</header>
      <div data-kit="feed-wrap" data-part="sidebar" inert={props.layout === 'stack' && props.page === 'main'}>{props.list}</div>
      <section data-kit="split-main" data-part="split.main">{props.main}</section>
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
    <button type="button" data-kit="cl-btn" data-a={props.kind} data-part={props.part} data-on={flag(props.on)} aria-label={props.label} title={props.label} aria-pressed={props.on === undefined ? undefined : props.on} onClick={() => props.onClick?.()}>
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
    <nav data-kit="cl-rail" data-part="crew.rail" aria-label={props.label}>
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
  readonly onBrand?: () => void;
  readonly onSearch?: () => void;
  readonly onAccount?: () => void;
  readonly onView?: () => void;
  readonly onChip?: (id: string) => void;
  readonly onManage?: () => void;
}

/** v1 #topbar in split: the brand, Search, the avatar, the sidebar button, then the project chips. */
export function SidebarHead(props: SidebarHeadProps): JSX.Element {
  return (
    <>
      <a data-kit="brand" data-part="topbar.brand" href="#" title={props.brandLabel} aria-label={props.brandLabel} onClick={(e) => (e.preventDefault(), props.onBrand?.())}>
        <span data-kit="brand-orb" />
      </a>
      <div data-kit="projects" data-part="topbar.projects">
        <div data-kit="p-scroll">
          <For each={props.chips}>
            {(c) => (
              <button type="button" data-kit="p-chip" data-on={flag(props.on === c.id)} data-color={c.color ?? 'slate'} title={c.title} onClick={() => props.onChip?.(c.id)}>
                <Show when={c.color}>
                  <i data-kit="p-dot" />
                </Show>
                <span data-text="control">{c.name}</span>
                <Show when={c.need > 0}>
                  <span data-kit="p-need" title={c.needLabel}>{c.need}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <button type="button" data-kit="p-chip" data-add="" title={props.manageLabel} aria-label={props.manageLabel} onClick={() => props.onManage?.()}>
          <Icon name="plus" />
        </button>
      </div>
      <button type="button" data-kit="view-btn" data-part="topbar.view" title={props.viewLabel} aria-label={props.viewLabel} onClick={() => props.onView?.()}>
        <Icon name="split" />
      </button>
      <button type="button" data-kit="search-btn" data-part="topbar.search" title={props.searchLabel} aria-label={props.searchLabel} onClick={() => props.onSearch?.()}>
        <Icon name="search" />
      </button>
      <button type="button" data-kit="me-btn" data-part="sidebar.foot" title={props.accountLabel} aria-label={props.accountLabel} onClick={() => props.onAccount?.()}>
        <span data-kit="sf-av" data-part="topbar.account">
          <Icon name="user" />
        </span>
      </button>
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
        <button type="button" data-kit="split-new" data-part="sidebar.new" data-on={flag(props.on)} title={props.newTitle} onClick={() => props.onNew?.()}>
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
        <span data-kit="sec-name" data-text="control">{props.name}</span>
        <span data-kit="sec-n">{props.count}</span>
      </h4>
      <Show when={!props.collapsed}>
        <div data-kit="f-list">{props.children}</div>
      </Show>
    </section>
  );
}
