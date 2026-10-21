# vault-terminal's pty helper. Bundled into main.js as a string and run as
#   python3 -I -c <bootstrap> vault-terminal <id> --rows R --cols C [--xpixel W --ypixel H] --cwd DIR -- PROGRAM [ARGS...]
#
# Descriptors, set up by the plugin:
#   0  bytes typed into the terminal, passed to the program unaltered
#   1  bytes the program wrote, passed to the plugin unaltered
#   2  the helper's own diagnostics, never terminal output
#   3  control: one JSON object per line, both ways (or in only, with --ctl-out)
#
# Control in:  {"type": "resize", "rows": R, "cols": C, "width": W, "height": H}  {"type": "close"}
#   (width and height: the text area in pixels, optional)
# Control out: {"type": "ready", ...}  {"type": "exit", ...}  {"type": "error", ...}
#   {"type": "foreground", "pgid": G, "name": N, "script": S}: the terminal's
#   foreground program changed; S is the script an
#   interpreter (node, python...) runs, or "".
#
# The helper owns cleanup. It ends everything the program started when the
# plugin says close, when either pipe from the plugin reaches EOF (which is how
# it learns the renderer is gone, a crash included), when its parent changes,
# and after the program exits on its own.
#
# Written for Python 3.8: no match, no "X | Y" types, no str.removeprefix.

import ctypes
import errno
import fcntl
import json
import os
import select
import selectors
import signal
import struct
import sys
import termios
import time

CTL_IN = 3
READ_SIZE = 65536
# The most reads one shutdown drain makes before the deadlines are checked again.
DISCARD_READS = 64
OUT_HIGH = 1 << 20  # stop reading the pty while this much output is unsent
IN_HIGH = 1 << 20  # stop reading input while this much is unwritten to the pty
LINE_CAP = 65536
TICK = 0.25
HUP_WAIT = 1.0
TERM_WAIT = 0.5
DRAIN_LIMIT = 0.5
IUTF8 = getattr(termios, "IUTF8", 0x4000)  # Darwin's value; Python doesn't export it
CHILD_SIGNALS = ("SIGPIPE", "SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGTSTP",
                 "SIGTTIN", "SIGTTOU", "SIGCHLD", "SIGWINCH", "SIGXFSZ")


def log(msg):
    try:
        os.write(2, ("vault-terminal helper: " + msg + "\n").encode("utf-8", "replace"))
    except OSError:
        pass


def parse_args(argv):
    opts = {"rows": 24, "cols": 80, "xpixel": 0, "ypixel": 0, "test_delay": 0.0, "cwd": None, "ctl_out": CTL_IN, "id": "", "program": []}
    i = 0
    if argv and argv[0] == "vault-terminal":
        opts["id"] = argv[1] if len(argv) > 1 else ""
        i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--":
            opts["program"] = argv[i + 1:]
            break
        if a in ("--rows", "--cols", "--xpixel", "--ypixel", "--ctl-out"):
            opts[a[2:].replace("-", "_")] = int(argv[i + 1])
            i += 2
        elif a == "--test-delay":
            # The self-test's slow start: wait before starting the program.
            opts["test_delay"] = float(argv[i + 1])
            i += 2
        elif a == "--cwd":
            opts["cwd"] = argv[i + 1]
            i += 2
        else:
            raise ValueError("unknown argument: " + a)
    if not opts["program"]:
        raise ValueError("no program given")
    return opts


def valid_size(rows, cols):
    return isinstance(rows, int) and isinstance(cols, int) and 0 < rows <= 10000 and 0 < cols <= 10000


def valid_pixels(n):
    return isinstance(n, int) and 0 <= n <= 65535


def set_size(fd, rows, cols, xpixel=0, ypixel=0):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, xpixel, ypixel))


def set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def spawn(opts):
    """Open a pty sized before the fork, and run the program as the leader of a
    new session with the pty as its controlling terminal. Returns
    (pid, master, slave, tty) or raises OSError with the exec failure."""
    master, slave = os.openpty()
    set_size(slave, opts["rows"], opts["cols"], opts["xpixel"], opts["ypixel"])
    attrs = termios.tcgetattr(slave)
    attrs[0] |= IUTF8
    termios.tcsetattr(slave, termios.TCSANOW, attrs)
    tty = os.ttyname(slave)
    err_r, err_w = os.pipe()  # close-on-exec: EOF with no data means exec succeeded
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            keep = {0, 1, 2, err_w}
            for name in os.listdir("/dev/fd"):
                fd = int(name)
                if fd not in keep:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            for name in CHILD_SIGNALS:
                signal.signal(getattr(signal, name), signal.SIG_DFL)
            signal.pthread_sigmask(signal.SIG_SETMASK, [])
            if opts["cwd"]:
                os.chdir(opts["cwd"])
            program = opts["program"]
            os.execvpe(program[0], program, os.environ)
        except BaseException as e:  # noqa: B902 - anything here must reach the parent
            code = getattr(e, "errno", 0) or 0
            msg = json.dumps({"errno": code, "message": str(e)})
            try:
                os.write(err_w, msg.encode("utf-8"))
            finally:
                os._exit(127)
    os.close(err_w)
    chunks = []
    while True:
        chunk = os.read(err_r, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(err_r)
    if chunks:
        os.close(master)
        os.close(slave)
        os.waitpid(pid, 0)
        failure = json.loads(b"".join(chunks).decode("utf-8", "replace"))
        raise OSError(failure["errno"], failure["message"])
    return pid, master, slave, tty


class _BsdInfo(ctypes.Structure):
    # struct proc_bsdinfo, <sys/proc_info.h>; 136 bytes
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32),
                ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
                ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32),
                ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32),
                ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
                ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64),
                ("start_usec", ctypes.c_uint64)]


PROC_PIDTBSDINFO = 3
FOREGROUND_EVERY = 0.2
# Programs that run an agent from a script: the script's name says which.
INTERPRETERS = ("node", "bun", "deno", "python", "python3", "ruby", "perl")
try:
    _libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
except OSError:
    _libproc = None


def snapshot():
    """This user's processes as {pid: (ppid, pgid, tty device)}. Read through
    libproc rather than ps: no /proc on macOS, and no process to start."""
    if _libproc is None:
        return {}
    n = _libproc.proc_listallpids(None, 0)
    if n <= 0:
        return {}
    pids = (ctypes.c_int * (n + 256))()
    n = _libproc.proc_listallpids(pids, ctypes.sizeof(pids))
    info = _BsdInfo()
    size = ctypes.sizeof(info)
    uid = os.getuid()
    table = {}
    for pid in pids[:max(n, 0)]:
        if pid <= 0:
            continue
        if _libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size) != size:
            continue  # gone, or another user's
        if info.uid == uid:
            table[pid] = (info.ppid, info.pgid, info.tdev)
    return table


def bsdinfo(pid):
    if _libproc is None or pid <= 0:
        return None
    info = _BsdInfo()
    size = ctypes.sizeof(info)
    if _libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size) != size:
        return None
    return info


try:
    _libc = ctypes.CDLL(None, use_errno=True)
except OSError:
    _libc = None


def proc_args(pid):
    """A process's arguments, through sysctl KERN_PROCARGS2: argc, then the
    executable's path, padding, then the arguments, each NUL-ended."""
    if _libc is None:
        return []
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(0)
    if _libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 4:
        return []
    buf = ctypes.create_string_buffer(size.value)
    if _libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return []
    raw = buf.raw[:size.value]
    argc = int.from_bytes(raw[:4], "little")
    rest = raw[4:]
    end = rest.find(b"\0")
    if end < 0:
        return []
    rest = rest[end:].lstrip(b"\0")
    return [a.decode("utf-8", "replace") for a in rest.split(b"\0")[:argc]]


def foreground_of(program_pid):
    """The foreground process group of the program's terminal, its leader's
    name, and for an interpreter, the script it runs."""
    info = bsdinfo(program_pid)
    if info is None or not info.tpgid:
        return None
    pgid = info.tpgid
    lead = bsdinfo(pgid)
    if lead is None:
        return None
    name = (lead.name or lead.comm).decode("utf-8", "replace")
    script = ""
    if name.lower().startswith(INTERPRETERS):
        script = script_of(proc_args(pgid))
    return {"pgid": pgid, "name": name, "script": script}


# An interpreter's options that take the next argument as their value:
# node's preloads and settings, python's -m, -c, -W and -X. Not the script.
VALUE_OPTIONS = {"-r", "--require", "--import", "--loader", "--experimental-loader", "-e", "--eval", "-p", "--print",
                 "--input-type", "--env-file", "--conditions", "-C", "--title", "--inspect-port",
                 "-c", "-W", "-X", "--stack-size"}


def script_of(args):
    """The script an interpreter runs: its first argument that isn't an
    option or an option's value (node --require preload.js claude: claude)."""
    skip = skip_module = ended = False
    for a in args[1:]:
        if skip:
            skip = False
            continue
        if ended:
            return os.path.basename(a)
        if a == "--":
            # After it, the next argument is the script, whatever it starts with.
            ended = True
            continue
        if skip_module:
            return a
        # deno run x.ts, bun run x: the subcommand isn't the script.
        if a in ("run", "x", "exec") and os.path.basename(args[0]).lower().startswith(("deno", "bun")):
            continue
        if a == "-m":
            skip_module = True
            continue
        if a.startswith("-"):
            skip = a in VALUE_OPTIONS
            continue
        return os.path.basename(a)
    return ""


def targets(root, tty_dev, table):
    """The program's descendants by parent chain, plus every process on its
    tty, which catches double-forked processes that kept the terminal."""
    found = set()
    if root in table:
        found.add(root)
    children = {}
    for pid, (ppid, _, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    stack = [root]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in found:
                found.add(child)
                stack.append(child)
    for pid, (_, _, tdev) in table.items():
        if tdev == tty_dev:
            found.add(pid)
    found.discard(os.getpid())
    return found


def signal_all(pids, groups, sig):
    for pgid in groups:
        if pgid > 1 and pgid != os.getpgrp():
            try:
                os.killpg(pgid, sig)
            except OSError:
                pass
    for pid in pids:
        if pid > 1:
            try:
                os.kill(pid, sig)
            except OSError:
                pass


class Helper:
    def __init__(self, opts):
        self.opts = opts
        self.ctl_out = opts["ctl_out"]
        self.sel = selectors.DefaultSelector()
        self.interest = {}
        self.inbuf = bytearray()  # plugin -> pty
        self.outbuf = bytearray()  # pty -> plugin
        self.ctl_inbuf = bytearray()
        self.ctl_outbuf = bytearray()
        self.pid = 0
        self.master = -1
        self.slave = -1
        self.tty = ""
        self.tty_dev = -1
        self.status = None  # (code, signal) once the program has exited
        self.closing = None  # why the helper is shutting down
        self.input_open = True
        self.parent = os.getppid()
        self.last_parent_check = 0.0
        self.last_foreground = None
        self.last_foreground_check = 0.0
        wake_r, wake_w = os.pipe()
        set_nonblocking(wake_r)
        set_nonblocking(wake_w)
        self.wake_r = wake_r
        signal.set_wakeup_fd(wake_w)
        signal.signal(signal.SIGCHLD, lambda s, f: None)
        for name in ("SIGTERM", "SIGINT", "SIGHUP"):
            signal.signal(getattr(signal, name), self.on_signal)

    def on_signal(self, signum, frame):
        if not self.closing:
            self.closing = "signal %d" % signum

    # --- control channel ---

    def send(self, msg):
        self.ctl_outbuf += (json.dumps(msg, ensure_ascii=True) + "\n").encode("ascii")
        self.flush_ctl(blocking=False)

    def flush_ctl(self, blocking):
        deadline = time.monotonic() + 1.0
        while self.ctl_outbuf:
            try:
                n = os.write(self.ctl_out, self.ctl_outbuf)
                del self.ctl_outbuf[:n]
            except BlockingIOError:
                if not blocking or time.monotonic() > deadline:
                    return
                time.sleep(0.01)
            except OSError:
                self.ctl_outbuf.clear()
                return

    def on_control(self, data):
        self.ctl_inbuf += data
        resize = None
        while True:
            nl = self.ctl_inbuf.find(b"\n")
            if nl < 0:
                if len(self.ctl_inbuf) > LINE_CAP:
                    log("control line over the cap; dropped")
                    self.ctl_inbuf.clear()
                break
            line = bytes(self.ctl_inbuf[:nl])
            del self.ctl_inbuf[:nl + 1]
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                log("malformed control message dropped")
                continue
            kind = msg.get("type") if isinstance(msg, dict) else None
            if kind == "resize":
                rows, cols = msg.get("rows"), msg.get("cols")
                width, height = msg.get("width", 0), msg.get("height", 0)
                if valid_size(rows, cols):
                    # only the newest of a batch is applied
                    resize = (rows, cols, width if valid_pixels(width) else 0, height if valid_pixels(height) else 0)
                else:
                    log("invalid size dropped: %r x %r" % (rows, cols))
            elif kind == "close":
                self.closing = "close"
            else:
                log("unknown control message: %r" % (kind,))
        if resize and self.slave >= 0 and self.status is None:
            try:
                set_size(self.slave, resize[0], resize[1], resize[2], resize[3])
            except OSError as e:
                log("resize failed: %s" % e)

    # --- the loop ---

    def want(self):
        w = {}

        def add(fd, ev):
            w[fd] = w.get(fd, 0) | ev

        add(self.wake_r, selectors.EVENT_READ)
        add(CTL_IN, selectors.EVENT_READ)
        if self.ctl_outbuf:
            add(self.ctl_out, selectors.EVENT_WRITE)
        if self.input_open and len(self.inbuf) < IN_HIGH:
            add(0, selectors.EVENT_READ)
        if self.master >= 0:
            if len(self.outbuf) < OUT_HIGH:
                add(self.master, selectors.EVENT_READ)
            if self.inbuf:
                add(self.master, selectors.EVENT_WRITE)
        if self.outbuf:
            add(1, selectors.EVENT_WRITE)
        return w

    def update_interest(self):
        w = self.want()
        for fd in list(self.interest):
            if fd not in w:
                self.sel.unregister(fd)
                del self.interest[fd]
        for fd, ev in w.items():
            if fd not in self.interest:
                self.sel.register(fd, ev)
            elif self.interest[fd] != ev:
                self.sel.modify(fd, ev)
            self.interest[fd] = ev

    def read_master(self):
        try:
            data = os.read(self.master, READ_SIZE)
        except BlockingIOError:
            return 0
        except OSError as e:
            if e.errno == errno.EIO:  # no slave left; nothing more will come
                self.close_master()
                return 0
            raise
        if not data:
            self.close_master()
            return 0
        self.outbuf += data
        return len(data)

    def close_master(self):
        if self.master >= 0:
            if self.master in self.interest:
                self.sel.unregister(self.master)
                del self.interest[self.master]
            os.close(self.master)
            self.master = -1

    def write_out(self):
        try:
            n = os.write(1, self.outbuf)
            del self.outbuf[:n]
        except BlockingIOError:
            pass
        except OSError:  # the plugin's end is gone
            self.outbuf.clear()
            if not self.closing:
                self.closing = "stdout closed"

    def step(self, timeout):
        self.update_interest()
        for key, ev in self.sel.select(timeout):
            fd = key.fd
            if fd == self.wake_r:
                try:
                    while os.read(self.wake_r, 512):
                        pass
                except OSError:
                    pass
                continue
            if fd == CTL_IN and ev & selectors.EVENT_READ:
                try:
                    data = os.read(CTL_IN, READ_SIZE)
                except BlockingIOError:
                    data = None
                except OSError:
                    data = b""
                if data == b"":
                    if not self.closing:
                        self.closing = "control EOF"
                elif data:
                    self.on_control(data)
            if fd == self.ctl_out and ev & selectors.EVENT_WRITE:
                self.flush_ctl(blocking=False)
            if fd == 0 and ev & selectors.EVENT_READ:
                try:
                    data = os.read(0, READ_SIZE)
                except BlockingIOError:
                    data = None
                except OSError:
                    data = b""
                if data == b"":
                    self.input_open = False
                    if not self.closing:
                        self.closing = "input EOF"
                elif data:
                    self.inbuf += data
            if fd == self.master and self.master >= 0:
                if ev & selectors.EVENT_WRITE and self.inbuf:
                    try:
                        n = os.write(self.master, self.inbuf)
                        del self.inbuf[:n]
                    except BlockingIOError:
                        pass
                    except OSError:
                        self.inbuf.clear()
                if ev & selectors.EVENT_READ and self.master >= 0:
                    self.read_master()
            if fd == 1 and ev & selectors.EVENT_WRITE:
                self.write_out()
        self.reap()
        now = time.monotonic()
        if now - self.last_foreground_check >= FOREGROUND_EVERY and self.status is None and self.pid:
            self.last_foreground_check = now
            try:
                fg = foreground_of(self.pid)
            except Exception as e:  # never let a lookup end the terminal
                log("foreground lookup failed: %s" % e)
                fg = None
            if fg is not None and fg != self.last_foreground:
                self.last_foreground = fg
                msg = {"type": "foreground"}
                msg.update(fg)
                self.send(msg)
        if now - self.last_parent_check >= 1.0:
            self.last_parent_check = now
            ppid = os.getppid()
            # A parent of 1 always means reparented to launchd: Obsidian is gone,
            # even if that happened before the helper recorded its parent.
            if (ppid != self.parent or ppid == 1) and not self.closing:
                self.closing = "parent gone"

    def reap(self):
        if self.pid and self.status is None:
            try:
                pid, st = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                pid, st = self.pid, 0
            if pid == self.pid:
                # How long the program itself ran: the exit message carries it, so a
                # rule about failing at once isn't stretched by cleanup and delivery.
                self.ran = time.monotonic() - self.started
                if os.WIFSIGNALED(st):
                    self.status = (None, os.WTERMSIG(st))
                else:
                    self.status = (os.WEXITSTATUS(st), None)

    # --- cleanup ---

    def wait_program(self, limit):
        end = time.monotonic() + limit
        while self.status is None and time.monotonic() < end:
            self.discard_master()
            self.reap()
            if self.status is None:
                time.sleep(0.02)

    def discard_master(self):
        """Keep the pty drained during shutdown so nothing blocks writing to it.
        Bounded: a program that ignores HUP and TERM and keeps writing would
        otherwise keep this reading forever, and the deadlines around it, the
        last SIGKILL's included, would never be checked."""
        if self.master < 0:
            return
        try:
            for _ in range(DISCARD_READS):
                if not os.read(self.master, READ_SIZE):
                    break
        except OSError:
            pass

    def cleanup(self, natural):
        """End everything the program started. On a natural exit the program is
        already gone; what's left is jobs it left behind."""
        tty_dev = self.tty_dev
        before = snapshot()
        found = targets(self.pid, tty_dev, before)
        groups = {self.pid}
        if self.master >= 0:
            try:
                groups.add(os.tcgetpgrp(self.master))
            except OSError:
                pass
        groups |= {before[p][1] for p in found if p in before}
        if not natural or found:
            signal_all(found, groups, signal.SIGHUP)
            signal_all(found, groups, signal.SIGCONT)
        if not natural:
            # The plugin is closing the terminal, so its output has nowhere to
            # go: it's read and dropped (wait_program). The pty itself stays
            # open until cleanup is done. Closed earlier, macOS can give the
            # same pty to the next terminal opened, and the sweeps below,
            # which find processes by this tty, would end that terminal's
            # shell (found in testing).
            self.outbuf.clear()
            self.wait_program(HUP_WAIT)
        after = snapshot()
        found = {p for p in found if p in after} | targets(self.pid, tty_dev, after)
        found.discard(os.getpid())
        if found:
            groups = {after[p][1] for p in found if p in after}
            signal_all(found, groups, signal.SIGTERM)
            signal_all(found, groups, signal.SIGCONT)
            end = time.monotonic() + TERM_WAIT
            while time.monotonic() < end:
                self.discard_master()
                self.reap()
                table = snapshot()
                # Something handling TERM may start a replacement, even in a
                # new group: it's a child of a found process, so it's found too.
                found = {p for p in found if p in table}
                fresh = set()
                for p in found:
                    fresh |= targets(p, tty_dev, table)
                fresh -= found
                if fresh:
                    more = {table[p][1] for p in fresh}
                    groups |= more
                    signal_all(fresh, more, signal.SIGTERM)
                    signal_all(fresh, more, signal.SIGCONT)
                    found |= fresh
                if not found:
                    break
                time.sleep(0.05)
            if found:
                table = snapshot()
                for p in list(found):
                    found |= targets(p, tty_dev, table)
                groups |= {table[p][1] for p in found if p in table}
                signal_all(found, groups, signal.SIGKILL)
        self.reap()
        if self.status is None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
            self.wait_program(0.5)

    def drain_after_exit(self):
        """The program exited; collect what it wrote before going. Bounded,
        since a background job still holding the tty could write forever."""
        end = time.monotonic() + DRAIN_LIMIT
        while self.master >= 0 and time.monotonic() < end:
            if self.read_master() == 0:
                break

    def flush_out(self):
        """Send the last of the output, however long the plugin takes to read
        it (it may be paused in the developer tools). Stops only if the plugin
        closes the terminal or goes away."""
        last_check = time.monotonic()
        while self.outbuf and not self.closing:
            self.write_out()
            if not self.outbuf:
                break
            try:
                _, _, _ = select.select([CTL_IN], [1], [], TICK)
            except (OSError, ValueError):
                break
            try:
                data = os.read(CTL_IN, READ_SIZE)
                if data == b"":
                    self.closing = "control EOF"
                else:
                    self.on_control(data)
            except BlockingIOError:
                pass
            except OSError:
                self.closing = "control EOF"
            if time.monotonic() - last_check >= 1.0:
                last_check = time.monotonic()
                if os.getppid() != self.parent or os.getppid() == 1:
                    self.closing = "parent gone"

    def run(self):
        for fd in (0, 1, CTL_IN, self.ctl_out):
            set_nonblocking(fd)
        os.set_inheritable(CTL_IN, False)
        os.set_inheritable(self.ctl_out, False)
        if self.opts.get("test_delay"):
            time.sleep(min(self.opts["test_delay"], 60))
        try:
            self.pid, self.master, self.slave, self.tty = spawn(self.opts)
        except OSError as e:
            self.send({"type": "error", "kind": "spawn", "errno": e.errno,
                       "message": e.strerror or str(e), "program": self.opts["program"][0]})
            self.flush_ctl(blocking=True)
            return 2
        set_nonblocking(self.master)
        self.tty_dev = os.fstat(self.slave).st_rdev
        self.started = time.monotonic()
        self.ran = None
        self.send({"type": "ready", "pid": self.pid, "tty": self.tty})
        while self.status is None and not self.closing:
            self.step(TICK)
        if self.status is not None:
            self.drain_after_exit()
            self.cleanup(natural=True)
            self.flush_out()
            code, sig = self.status
            self.send({"type": "exit", "code": code, "signal": sig, "ran": round(self.ran, 3) if self.ran is not None else None})
        else:
            log("closing: %s" % self.closing)
            self.cleanup(natural=False)
            code, sig = self.status if self.status else (None, None)
            self.send({"type": "exit", "code": code, "signal": sig, "closed": self.closing})
        self.close_master()
        if self.slave >= 0:
            os.close(self.slave)
        self.flush_ctl(blocking=True)
        return 0


def main():
    try:
        opts = parse_args(sys.argv[1:])
    except (ValueError, IndexError) as e:
        log("bad arguments: %s" % e)
        return 2
    if "--ctl-out" not in sys.argv:
        opts["ctl_out"] = CTL_IN
    return Helper(opts).run()


if __name__ == "__main__":
    sys.exit(main())
