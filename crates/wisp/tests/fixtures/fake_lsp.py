# A stand-in language server for crates/wisp/tests/serve_lsp.rs: LSP over stdio, just enough to answer
# definition, references, hover, completion, rename and to publish diagnostics for an opened file.
import json, sys

def read():
    n = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        k, _, v = line.decode().partition(':')
        if k.lower() == 'content-length':
            n = int(v)
    return json.loads(sys.stdin.buffer.read(n))

def send(msg):
    b = json.dumps(msg).encode()
    sys.stdout.buffer.write(b'Content-Length: %d\r\n\r\n' % len(b) + b)
    sys.stdout.buffer.flush()

docs = {}
while True:
    m = read()
    if m is None:
        break
    meth, mid, p = m.get('method'), m.get('id'), m.get('params') or {}
    loc = lambda uri, line, ch: {'uri': uri, 'range': {'start': {'line': line, 'character': ch}, 'end': {'line': line, 'character': ch + 3}}}
    if meth == 'initialize':
        send({'id': mid, 'result': {'capabilities': {}}})
    elif meth == 'textDocument/didOpen':
        d = p['textDocument']; docs[d['uri']] = d['text']
        send({'method': 'textDocument/publishDiagnostics', 'params': {'uri': d['uri'], 'diagnostics': [{'range': {'start': {'line': 1, 'character': 0}, 'end': {'line': 1, 'character': 3}}, 'severity': 2, 'message': 'unused expression'}]}})
    elif meth == 'textDocument/definition':
        send({'id': mid, 'result': loc(p['textDocument']['uri'], 0, 13)})
    elif meth == 'textDocument/references':
        u = p['textDocument']['uri']; send({'id': mid, 'result': [loc(u, 0, 13), loc(u, 1, 0)]})
    elif meth == 'textDocument/hover':
        send({'id': mid, 'result': {'contents': {'kind': 'markdown', 'value': 'const add: 1'}}})
    elif meth == 'textDocument/completion':
        send({'id': mid, 'result': [{'label': 'addAll', 'detail': 'function'}]})
    elif meth == 'textDocument/rename':
        u = p['textDocument']['uri']; nn = p['newName']
        send({'id': mid, 'result': {'changes': {u: [{'range': {'start': {'line': 0, 'character': 13}, 'end': {'line': 0, 'character': 16}}, 'newText': nn}, {'range': {'start': {'line': 1, 'character': 0}, 'end': {'line': 1, 'character': 3}}, 'newText': nn}]}}})
    elif mid is not None:
        send({'id': mid, 'result': None})
