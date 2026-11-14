// The `map` block (v1 R.map): the places an agent named, on a Google map. One place: its map and Open in Google
// Maps. Several: numbered, the map shows the one picked (the first at start), each with its own Open; `route` adds
// directions through them in order. No address at all says so in one line. The frame loads lazily.
import { For, Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { InlineMd } from './content-parts.tsx';
import { useBlockT } from './context.tsx';
import { embedUrl, mapPlaces, mapZoom, placeLine, placeUrl, routeUrl } from './map-spec.ts';
import { bool, opt, str } from './read.ts';
import { CantShow, OutLink } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

export function MapBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const places = mapPlaces(props.block);
  const many = places.length > 1;
  const title = opt(props.block['title']);
  const route = bool(props.block['route']) ? routeUrl(places) : undefined;
  const [at, setAt] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const pick = (i: number): void => {
    if (i === at()) return;
    setLoaded(false);
    setAt(i);
  };
  const nameOf = (i: number): string => {
    const p = places[i];
    return p ? p.name || p.address || p.q : '';
  };
  return (
    <Show when={places.length > 0} fallback={<CantShow part="block.map.none">{t('block.map.none', { title: title ?? t('block.map.name') })}</CantShow>}>
      <figure data-kit="rb-map" data-card="" data-part="block.map" data-many={many ? '' : undefined}>
        <Show when={title || many || route}>
          <div data-kit="rb-map-head">
            <span data-kit="rb-map-title">
              <Icon name="pin" size="sm" />
              <b>{title ?? t('block.map.places')}</b>
              <Show when={many}>
                <i>{t('block.map.count', { n: places.length })}</i>
              </Show>
            </span>
            <Show when={route}>{(r) => <OutLink href={r()} part="block.map.route" icon="arrow" label={t('block.map.route')} title={t('block.map.routeTip')} />}</Show>
          </div>
        </Show>
        <div data-kit="rb-map-stage" data-loaded={loaded() ? '' : undefined}>
          <iframe
            src={embedUrl(places[at()] ?? places[0] ?? { name: '', address: '', note: '', q: '' }, mapZoom(props.block))}
            title={t('block.map.frame', { name: nameOf(at()) })}
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
            allowfullscreen
            onLoad={() => setLoaded(true)}
          />
        </div>
        <ol data-kit="rb-map-list">
          <For each={places}>
            {(p, i) => (
              <li data-kit="rb-map-place" data-on={i() === at() ? '' : undefined}>
                <button type="button" data-kit="rb-map-pick" tabIndex={many ? 0 : -1} title={many ? t('block.map.pick') : undefined} onClick={() => many && pick(i())}>
                  <span data-kit="rb-map-k">{many ? i() + 1 : <Icon name="pin" size="sm" />}</span>
                  <span data-kit="rb-map-main">
                    <Show when={p.name}>
                      <b>{p.name}</b>
                    </Show>
                    <span data-kit="rb-map-addr">{placeLine(p) || (p.lat !== undefined ? `${p.lat}, ${p.lng}` : '')}</span>
                    <Show when={p.note}>
                      <span data-kit="rb-map-note">
                        <InlineMd source={p.note} part="block.map.note" />
                      </span>
                    </Show>
                  </span>
                </button>
                <OutLink href={placeUrl(p)} part="block.map.open" label={t('block.map.open')} title={t('block.map.openPlace', { name: nameOf(i()) })} />
              </li>
            )}
          </For>
        </ol>
        <Show when={str(props.block['caption'])}>
          <figcaption data-kit="rb-caption">
            <InlineMd source={str(props.block['caption'])} part="block.map.caption" />
          </figcaption>
        </Show>
      </figure>
    </Show>
  );
}
