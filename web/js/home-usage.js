// Usage at a glance on home (split.js paintUsage): under the prompt box, each account's plan as
// its CLI last reported it (server/budget.js, `budget` on the harness list), two windows at most:
// the 5-hour one and the fullest weekly one. DOM-free, so a test can read it.

const SHORT = { five_hour: '5h', seven_day: 'Week', seven_day_opus: 'Opus week', seven_day_sonnet: 'Sonnet week' };
export const shortLabel = (w) => SHORT[w.id] || w.label;

// agents: S.agents. [{ agent, name, account, accountLabel, windows: [{ id, label, short, used, resetsAt, hitAt }] }], at most `max`.
export function homeUsage(agents, max = 3) {
  const out = [];
  for (const a of agents || []) {
    if (!a.available) continue;
    const many = a.accounts?.length > 1;
    for (const b of a.budget || []) {
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue; // an account since removed
      const wins = (b.windows || []).filter((w) => typeof w.used === 'number');
      const five = wins.find((w) => w.id === 'five_hour');
      const week = wins.filter((w) => w !== five).sort((x, y) => y.used - x.used)[0];
      const pick = [five, week].filter(Boolean);
      if (!pick.length) continue;
      out.push({ agent: a.id, name: a.name, account: b.account, accountLabel: acc?.label || '', windows: pick.map((w) => ({ ...w, short: shortLabel(w) })) });
    }
  }
  return out.slice(0, max);
}
