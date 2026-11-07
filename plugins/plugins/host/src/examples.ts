// The worked examples the Make a plugin agent sees (v1 server/spell-guide.js SPELL_EXAMPLES): each is
// a valid spell (a test checks), so the agent copies shapes that load.

export interface Example {
  ask: string;
  spell: Readonly<Record<string, unknown>>;
}

export const SPELL_EXAMPLES: readonly Example[] = [
  {
    "ask": "Pin my Task board and Roadmap apps on home, the board twice as wide, and my PR notes app beside each task",
    "spell": {
      "wispSpell": 1,
      "id": "my-panes",
      "name": "My panes",
      "version": "1.0.0",
      "description": "Pins My Stuff apps as panes: two side by side on home, one as a tab in the side panel. What they may use (their wisp-app.json \"uses\") you allow yourself.",
      "settings": {
        "panes": "Task board@home,Roadmap@home,PR notes@task"
      },
      "parts": {
        "split.panes": {
          "props": {
            "height": 560,
            "columns": 2,
            "widths": "2,1"
          }
        }
      }
    }
  },
  {
    "ask": "A floating button that opens all my open PRs",
    "spell": {
      "wispSpell": 1,
      "id": "my-prs",
      "name": "My PRs",
      "version": "1.0.0",
      "description": "Open every PR you have open on GitHub, from a floating button.",
      "data": {
        "prs": {
          "gh": [
            "search",
            "prs",
            "--author",
            "@me",
            "--state",
            "open",
            "--json",
            "url,title,repository"
          ],
          "refresh": 120
        }
      },
      "buttons": [
        {
          "slot": "float",
          "icon": "github",
          "label": "My PRs",
          "badge": {
            "count": "prs"
          },
          "do": {
            "openAll": {
              "data": "prs",
              "field": "url"
            }
          }
        }
      ]
    }
  },
  {
    "ask": "A top bar button that shows my wisp tool stats",
    "spell": {
      "wispSpell": 1,
      "id": "tool-stats",
      "name": "Tool stats",
      "version": "1.0.0",
      "data": {
        "tools": {
          "wisp": "/usage/tools?days=30"
        }
      },
      "buttons": [
        {
          "slot": "topbar",
          "icon": "stats",
          "label": "Tools",
          "do": {
            "panel": "tools"
          }
        }
      ],
      "panels": [
        {
          "id": "tools",
          "title": "Tool calls · last 30 days",
          "as": "dialog",
          "data": [
            "tools"
          ],
          "render": "tools"
        }
      ],
      "script": "export function tools({ tools: t }) {\n  return [\n    { type: 'stats', items: [{ label: 'tool calls', value: t.total.calls }, { label: 'turns', value: t.total.turns }, { label: 'spend', value: Math.round(t.total.cost * 100) / 100, unit: '$' }] },\n    { type: 'chart', title: 'By kind', items: t.kinds.map((k) => ({ label: k.kind, value: k.calls })) },\n    { type: 'chart', title: 'By harness', items: t.agents.map((a) => ({ label: a.agent, value: a.calls })) },\n  ];\n}"
    }
  },
  {
    "ask": "A deploy block agents use after deploying",
    "spell": {
      "wispSpell": 1,
      "id": "deploy-block",
      "name": "Deploy block",
      "version": "1.0.0",
      "blocks": [
        {
          "type": "deploy",
          "doc": "{\"type\":\"deploy\",\"env\":\"staging\",\"url\":\"https://…\",\"status\":\"ok|failed\",\"checks\":[{\"label\":\"health\",\"ok\":true}]} After you deploy: where it went and whether it is healthy.",
          "summary": "Deployed {env} → {url} ({status})",
          "render": "deploy"
        }
      ],
      "script": "export function deploy(b) {\n  return [\n    { type: 'callout', tone: b.status === 'ok' ? 'success' : 'danger', title: `${b.env} · ${b.status}`, text: b.url },\n    { type: 'checklist', items: (b.checks || []).map((c) => ({ text: c.label, done: !!c.ok })) },\n  ];\n}"
    }
  },
  {
    "ask": "A block agents use to have me rank options, by moving them up a list",
    "spell": {
      "wispSpell": 1,
      "id": "rank-block",
      "name": "Rank block",
      "version": "1.0.0",
      "blocks": [
        {
          "type": "rank",
          "doc": "{\"type\":\"rank\",\"title\":\"…\",\"items\":[\"option\",\"…\"]} When the user should put several options in order before you go on.",
          "summary": "Rank: {title}",
          "render": "rank"
        }
      ],
      "script": "export function rank(b) {\n  const items = (b.items || []).map(String);\n  const css = '<style>ol{margin:0;padding:12px 14px 8px;list-style:none;display:flex;flex-direction:column;gap:6px}li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px}li span{flex:1;min-width:0}li button{border:1px solid var(--line-2);border-radius:6px;background:var(--surface);cursor:pointer}.go{margin:4px 14px 14px;padding:7px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}</style>';\n  const js = \"let o=wisp.state||\" + JSON.stringify(items).replace(/</g, '\\\\u003c') + \";const l=document.getElementById('l');\" +\n    \"const draw=()=>{l.innerHTML=o.map((t,i)=>'<li><span></span>'+(i?'<button data-i=\\\"'+i+'\\\">Up</button>':'')+'</li>').join('');l.querySelectorAll('span').forEach((s,i)=>{s.textContent=(i+1)+'. '+o[i]});wisp.save(o)};\" +\n    \"l.onclick=(e)=>{const i=+e.target.dataset.i;if(i){[o[i-1],o[i]]=[o[i],o[i-1]];draw()}};\" +\n    \"document.getElementById('go').onclick=()=>{wisp.send('My order:\\\\n'+o.map((t,i)=>(i+1)+'. '+t).join('\\\\n'))};draw();\";\n  const html = css + '<ol id=\"l\"></ol><button class=\"go\" id=\"go\">Send this order</button><script>' + js + '</scr' + 'ipt>';\n  return [{ type: 'app', title: b.title || 'Rank these', html, fallback: [{ type: 'checklist', items: items.map((t) => ({ text: t })) }] }];\n}"
    }
  },
  {
    "ask": "Compact cards, bold titles, PR first, no machine or project, and Open PR on hover",
    "spell": {
      "wispSpell": 1,
      "id": "compact-cards",
      "name": "Compact cards",
      "version": "1.0.0",
      "parts": {
        "card": {
          "props": {
            "density": "compact"
          }
        },
        "card.title": {
          "style": {
            "fontWeight": "650"
          }
        },
        "card.head": {
          "order": [
            "pr",
            "pill",
            "time"
          ]
        }
      },
      "ui": {
        "hide": [
          "card.machine",
          "card.project"
        ]
      },
      "buttons": [
        {
          "slot": "card.hover",
          "icon": "github",
          "label": "Open PR",
          "when": {
            "hasPr": true
          },
          "do": {
            "open": "{pr.url}"
          }
        }
      ]
    }
  },
  {
    "ask": "Split view with a wider task list showing full details, and a PR button in the task header",
    "spell": {
      "wispSpell": 1,
      "id": "split-wide",
      "name": "Wide split view",
      "version": "1.0.0",
      "parts": {
        "sidebar": {
          "props": {
            "width": 420,
            "details": "full"
          }
        },
        "split.main": {
          "props": {
            "readWidth": 1000
          }
        },
        "split.home": {
          "props": {
            "greeting": "What should we ship today?"
          }
        }
      },
      "buttons": [
        {
          "slot": "split.head",
          "icon": "github",
          "label": "PR",
          "when": {
            "hasPr": true
          },
          "do": {
            "open": "{pr.url}"
          }
        }
      ]
    }
  },
  {
    "ask": "Quick replies above the follow-up box, and a second-opinion button",
    "spell": {
      "wispSpell": 1,
      "id": "quick-replies",
      "name": "Quick replies",
      "version": "1.0.0",
      "buttons": [
        {
          "slot": "composer.chips",
          "label": "Run the tests",
          "do": {
            "send": "Run the tests and show me the output."
          }
        },
        {
          "slot": "composer.chips",
          "label": "Explain why…",
          "do": {
            "insert": "Explain why "
          }
        },
        {
          "slot": "composer.bar",
          "icon": "agent",
          "label": "Second opinion",
          "do": {
            "rerun": {
              "agent": "codex",
              "mode": "plan",
              "prompt": "Review the changes on branch {branch} and say what you would do differently."
            }
          }
        }
      ]
    }
  },
  {
    "ask": "When tests fail, send the task back once",
    "spell": {
      "wispSpell": 1,
      "id": "fix-failing-tests",
      "name": "Fix failing tests",
      "version": "1.0.0",
      "hooks": [
        {
          "on": "turn.finished",
          "if": {
            "testsFailed": true
          },
          "max": 1,
          "do": {
            "reply": "Some tests fail. Fix them, rerun the suite and report again."
          }
        }
      ]
    }
  },
  {
    "ask": "A crew member who reviews my PRs every hour, with a review checklist",
    "spell": {
      "wispSpell": 1,
      "id": "pr-reviewer",
      "name": "PR reviewer",
      "version": "1.0.0",
      "description": "Quill, a crew member who reviews new and changed pull requests every hour.",
      "crew": [
        {
          "key": "quill",
          "name": "Quill",
          "role": "PR reviewer",
          "avatar": "blob.violet.wide.flat.headphones",
          "cron": "0 * * * *",
          "mode": "plan",
          "brief": "Review pull requests that are new or changed since your last check-in (`gh pr list`, `gh pr diff`). Look for bugs, missing tests and risky changes, worst first, one short review per PR. Never push, approve or merge.",
          "kit": [
            {
              "kind": "skill",
              "name": "review-checklist",
              "description": "When reviewing a pull request",
              "body": "1. Read the description and the linked issue.\n2. Read the diff file by file; note bugs first, then missing tests, then style.\n3. Run the tests when the change touches logic.\n4. One short review: what to fix, worst first."
            }
          ]
        }
      ]
    }
  }
];
