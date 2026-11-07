import os, pty, select, signal, struct, sys, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
def size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    # The size goes on before the program starts: set only by the parent, it raced the program's
    # first look (stty size said 0 0 on a busy machine).
    try:
        size(0, rows, cols)
    except OSError:
        pass
    try:
        os.close(3)
    except OSError:
        pass
    try:
        os.execvp(sys.argv[3], sys.argv[3:])
    except OSError as e:
        sys.stderr.write('wisp: %s: %s\r\n' % (sys.argv[3], e.strerror))
        os._exit(127)
size(fd, rows, cols)
# Typed input waits here until the terminal takes it: blocking on a write to it while the program
# blocks on printing (nobody reading its output) would hang both.
os.set_blocking(fd, False)
def put(f, data):
    while data:
        n = os.write(f, data)
        data = data[n:]
ctl = b''
typed = b''
watch = [fd, 0, 3]
while True:
    try:
        ready, writable, _ = select.select(watch, [fd] if typed else [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            break
        if data:
            put(1, data)
    if fd in writable:
        try:
            typed = typed[os.write(fd, typed[:4096]):]
        except BlockingIOError:
            pass
        except OSError:
            typed = b''
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            os.kill(pid, signal.SIGHUP)
            break
        typed += data
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            watch.remove(3)
        ctl += data
        while b'\n' in ctl:
            line, ctl = ctl.split(b'\n', 1)
            try:
                r, c = map(int, line.split())
                size(fd, r, c)
            except (ValueError, OSError):
                pass
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
