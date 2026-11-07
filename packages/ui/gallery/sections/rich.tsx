// Markdown, Diff and Code in every state.
import type { JSX } from 'solid-js';
import { Code, Diff, Markdown, Stack, Text } from '../../src/index.ts';
import { Area, Specimen, State } from '../frame.tsx';

const ANSWER = `# Rate limit on /login

Added a **sliding-window** limiter: 5 attempts per minute per IP, then \`429\` with *Retry-After*.
It reads the IP from ~~the socket~~ \`X-Forwarded-For\` behind the proxy.  
A hard break sits before this line. Docs: [limiter guide](https://trywisp.dev/guides "Guides") or <https://trywisp.dev>, and a bare one https://github.com/M0xoo/wisp/pull/754.

## What changed

1. \`src/auth/limiter.ts\`, the window itself
   \`\`\`ts
   export function allow(ip: string, now = Date.now()): boolean {
     const hits = window.get(ip) ?? []; // keep the last minute
     return hits.filter((t) => now - t < 60_000).length < 5;
   }
   \`\`\`
2. The login route calls it first
   - and logs a refusal
     - with the IP hashed

- [x] Tests for the window edges
- [ ] A setting for the limit

> The proxy must set \`X-Forwarded-For\`.
> > Nested: otherwise every request shares one IP.

| File | Lines | Status |
|:--|--:|:-:|
| \`limiter.ts\` | 120 | added |
| \`login.ts\` | 8 | modified |
| \`a|b\` pipes stay in code | 0 | — |

---

Raw HTML stays text: <img src=x onerror=alert(1)> <script>alert(1)</script>
A long unbroken word: superlongunbrokenidentifierthatwouldotherwiserunoffthecardandbreakthelayoutatphonewidth`;

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index 3b18e51..a9c0d2f 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -12,7 +12,9 @@ export async function login(req: Request): Promise<Response> {
   const body = await req.json();
-  const user = await findUser(body.email);
+  const ip = clientIp(req);
+  if (!allow(ip)) return tooMany();
+  const user = await findUser(body.email);
   if (!user) return unauthorized();
   return session(user);
 }
\\ No newline at end of file
diff --git a/src/auth/limiter.ts b/src/auth/limiter.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/limiter.ts
@@ -0,0 +1,3 @@
+const window = new Map<string, number[]>();
+
+export const LIMIT = 5;
diff --git a/src/auth/old-throttle.ts b/src/auth/old-throttle.ts
deleted file mode 100644
--- a/src/auth/old-throttle.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// replaced by limiter.ts
-export {};
diff --git a/docs/limits.md b/docs/rate-limits.md
similarity index 92%
rename from docs/limits.md
rename to docs/rate-limits.md
--- a/docs/limits.md
+++ b/docs/rate-limits.md
@@ -1,1 +1,1 @@
-# Limits
+# Rate limits
diff --git a/web/logo.png b/web/logo.png
Binary files a/web/logo.png and b/web/logo.png differ`;

const BIG = `diff --git a/fixtures/big.json b/fixtures/big.json
--- a/fixtures/big.json
+++ b/fixtures/big.json
@@ -1,0 +1,600 @@
${Array.from({ length: 600 }, (_, i) => `+  { "id": ${i}, "name": "row ${i}" },`).join('\n')}`;

export function RichGallery(): JSX.Element {
  return (
    <Area id="rich" title="Markdown, diff, code">
      <Specimen title="Markdown" note="Safe: raw HTML shows as text; javascript: links stay text. Tables scroll sideways.">
        <Markdown source={ANSWER} part="gallery.answer" />
      </Specimen>
      <Specimen title="Markdown, streaming" note="An unclosed fence renders as code while it arrives.">
        <Markdown source={'Working on it:\n\n```sh\nnpm test\nnpm run build'} />
      </Specimen>
      <Specimen title="Diff" note="Modified, added, deleted, renamed and binary files.">
        <Diff diff={DIFF} binaryLabel="Binary file not shown" />
      </Specimen>
      <Specimen title="Diff, large file" note="Over 400 lines: folded until asked, then laid out in chunks near the screen.">
        <Diff diff={BIG} />
      </Specimen>
      <Specimen title="Code">
        <Stack gap="6">
          <State label="Inline">
            <Text>
              Run <Code>npm run gallery</Code> in <Code>packages/ui/a/very/long/path/that/breaks/instead/of/overflowing</Code>
            </Text>
          </State>
          <State label="Block, highlighted, with a title">
            <Stack gap="4" grow>
              <Code block lang="ts" title="src/core/signal.ts">
                {"import { effect } from 'alien-signals';\n\n/* Bridges a signal into Solid. */\nexport function useSignal<T>(read: () => T): Accessor<T> {\n  const [value, setValue] = createSignal<T>(undefined as T);\n  return value; // 42\n}"}
              </Code>
              <Code block lang="sh">{'# install once\nnpm install --no-audit --no-fund && echo "done"'}</Code>
            </Stack>
          </State>
          <State label="Block, plain and wrapped">
            <Stack gap="4" grow>
              <Code block>{'A plain block with a very long line that scrolls sideways rather than wrap: ' + 'x'.repeat(200)}</Code>
              <Code block wrap>{'A wrapped block: ' + 'word '.repeat(60)}</Code>
            </Stack>
          </State>
        </Stack>
      </Specimen>
    </Area>
  );
}
