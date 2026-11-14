// ProjectHead: inside a section, the line over one project's rows while several projects are picked (2026-11-14,
// docs/v2-queue.md GUI item 7): the project's dot and name, quieter than the section's own heading.
import type { JSX } from 'solid-js';
import type { ProjectColor } from '@wisp/tokens';
import { Dot } from './Dot.tsx';

export interface ProjectHeadProps {
  readonly name: string;
  readonly color: ProjectColor;
  /** its folder, as the tip */
  readonly title?: string;
}

export function ProjectHead(props: ProjectHeadProps): JSX.Element {
  return (
    <div data-kit="proj-head" data-part="list.project-head" title={props.title}>
      <Dot size="project" color={props.color} />
      <span data-text="control">{props.name}</span>
    </div>
  );
}
