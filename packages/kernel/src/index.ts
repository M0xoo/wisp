// @wisp/kernel: the plugin host (ADR-0003). The contract types plus everything that implements them.
export type * from './contract.ts';
// the kernel services' interfaces (proc, http, secrets, notify, net, paths): what ctx.service(name) gives
export type * from './kernel-services.ts';
export { SERVICE_NAMES } from './kernel-services.ts';

export { asPeerId, asPluginId, brander, formatOriginId, isPluginId, isUuid, isUuidV7, localName, ownedBy, ownerPrefix, parseOriginId, PLUGIN_ID, uuidv7, uuidv7Time } from './ids.ts';
export { compare, majorOf, parseRange, parseVersion, satisfies, validRange, validVersion, type SemVer } from './semver.ts';
export { fail, KernelError, toKernelError, toWireError } from './errors.ts';
export { covers, formatPermission, glob, parsePermission, permissionProblem, type Permission } from './permissions.ts';
export {
  AGENT_SESSION, allowed, APIKEY, BOX, CAPPED_DENY, CapabilityRegistry, cappedRefusal, cappedSet, crewSet, explain, MODE_LABEL, MODE_RANK, paneSet, pluginSet, PREVIEW, sessionSet, USER_FULL,
  type CapabilitySet, type Decision, type Deny, type Mode,
} from './capabilities.ts';
export { settingProblem, validateManifest, type ManifestError, type ManifestResult } from './manifest.ts';
export { convertSpell, slotInput, spellPluginId, type SpellResult } from './spell.ts';
export { dependentsOf, KERNEL_API, providerCandidates, resolve, type Resolution, type ResolveInput } from './resolve.ts';
export { build, pluginGroup, PluginGroupBuilder, type GroupEntry, type PluginGroup } from './group.ts';
export { createScope, realTimers, ScopeImpl, type ScopeOptions, type Timers } from './scope.ts';
export { Diagnostics, Ring, type Failure } from './diagnostics.ts';
export { SettingsRegistry, type SettingInfo, type SettingsBackend } from './settings.ts';
export { pointRef, Points, type PointDecl } from './points.ts';
export { EventBus, type EventBusOptions } from './events.ts';
export { defineService } from './services.ts';
export { defaultPermission, INTERCEPTOR_TIMEOUT_MAX_MS, INTERCEPTOR_TIMEOUT_MS, KERNEL_ID, MAX_DEPTH } from './dispatch.ts';
export { eager, parseActivation, wakes, type ActivationKind } from './activation.ts';
export type { TestHooks } from './host-types.ts';
export { Kernel, type KernelOptions, type LeakReport, type RegisterOptions } from './kernel.ts';
export { execPluginDef, type ChildProcessLike, type ExecOptions } from './exec/host.ts';
export { serve, type ServeOptions } from './exec/child.ts';
export { RpcPeer } from './exec/rpc.ts';
