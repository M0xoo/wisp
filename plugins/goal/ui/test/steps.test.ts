import { describe, expect, it } from 'vitest';
import { railOf, stepOf } from '../src/steps.ts';
import type { RunStep } from '../src/types.ts';

// runtime.quick's steps as a goal check's record holds them (a turn's activity: Activity, snake_case kinds)
const STEPS: RunStep[] = [
  { kind: 'thinking' },
  { kind: 'tool', tool: 'run', label: 'Run tests', callId: 'c1' },
  { kind: 'tool_output', callId: 'c1', text: '3 passed' },
  { kind: 'tool', tool: 'read', label: 'Read src/add.ts', file: 'src/add.ts', callId: 'c2' },
  { kind: 'tool_error', name: 'Bash', text: 'exit 1' },
  { kind: 'text', text: 'Looks met.\n' },
];

describe('a goal check page draws its judge’s tool steps', () => {
  it('folds each output into its call, drops empty thinking and the answer repeated', () => {
    const rail = railOf(STEPS, 'Looks met.');
    expect(rail.map((s) => s.kind)).toEqual(['tool', 'tool', 'tool_error']);
    expect(stepOf(rail[0] as RunStep)).toEqual({ icon: 'terminal', label: 'Run tests', detail: '3 passed' });
    expect(stepOf(rail[1] as RunStep)).toEqual({ icon: 'read', label: 'Read src/add.ts' });
    expect(stepOf(rail[2] as RunStep)).toEqual({ icon: 'warn', label: 'Bash', detail: 'exit 1' });
  });

  it('keeps a text that isn’t the answer, and an output whose call it can’t see', () => {
    const rail = railOf([{ kind: 'text', text: 'Checking the tests first.' }, { kind: 'tool_output', callId: 'gone', text: 'x' }], 'Met.');
    expect(rail.map((s) => s.kind)).toEqual(['text', 'tool_output']);
    expect(stepOf(rail[0] as RunStep).said).toBe('Checking the tests first.');
  });
});
