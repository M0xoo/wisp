import type { PluginClient } from '@wisp/client';
import type { MemberView } from '../types.ts';

/** What the member page hands each of its sections. */
export interface MemberSectionProps {
  readonly client: PluginClient;
  readonly member: () => MemberView;
}
