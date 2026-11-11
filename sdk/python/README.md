# wisp (Python SDK)

wisp's Python SDK (ADR-0028). Every call is a wisp command or a topic subscription, so permissions,
idempotency and live updates behave as they do in the app. No dependencies beyond the standard library.

```python
import wisp

w = wisp.connect()                                   # the running wisp (~/.wisp/server.json)
t = w.run(prompt="fix the flaky auth test", cwd=".")
done = w.wait(t["id"])                               # until it stops working: live, not polled
print(w.presentation(done["id"]))
w.cmd("runtime.followUp", id=t["id"], text="and add a test")
w.call.runtime.stop(id=t["id"])                      # any command in the catalogue, by its id
```
