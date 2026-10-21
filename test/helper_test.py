# Tests for src/vault-terminal/helper.py, run with plain Python outside Obsidian:
#   python3 -I test/helper_test.py
# Each test starts the helper the way the plugin does: the bootstrap below,
# socket pairs on fds 0, 1 and 3, a pipe on fd 2. Needs a real pty, so it
# can't run inside a sandbox that denies /dev/ptmx.

import atexit
import ctypes
import hashlib
import json
import os
import select
import signal
import socket
import sys
import tempfile
import time
import unittest
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "src", "vault-terminal", "helper.py")
BOOT = "import os;exec(compile(os.environ.pop('VAULT_TERMINAL_HELPER'),'vault-terminal-helper','exec'))"
PY = sys.executable

# Every process a run starts carries this in its environment (the helper
# passes its environment on, and children inherit it), and only those: the
# test process itself doesn't. Whatever a run leaves, after a failed check,
# Ctrl+C or SIGTERM, is found by it and ended (end_run_processes).
RUN_TAG = os.environ.get("TL_RUN_TAG") or "tl-run-" + uuid.uuid4().hex[:12]
TAG_ENTRY = ("VAULT_TERMINAL_TEST_RUN=" + RUN_TAG).encode()

_libc = ctypes.CDLL(None, use_errno=True)
_libproc = ctypes.CDLL("/usr/lib/libproc.dylib")


def _all_pids():
    n = _libproc.proc_listallpids(None, 0)
    buf = (ctypes.c_int * (n + 64))()
    n = _libproc.proc_listallpids(buf, ctypes.sizeof(buf))
    return [buf[i] for i in range(max(0, n)) if buf[i] > 0]


def _procargs(pid):
    """A process's arguments and environment (KERN_PROCARGS2), or b"" if it can't be read."""
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(1 << 20)
    buf = ctypes.create_string_buffer(size.value)
    if _libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return b""
    return buf.raw[: size.value]


def _environment(raw):
    """The environment part of KERN_PROCARGS2: after argc, the executable's path, its padding and argc arguments."""
    if len(raw) < 4:
        return []
    argc = int.from_bytes(raw[:4], sys.byteorder)
    rest = raw[4:]
    end = rest.find(b"\0")
    if end < 0:
        return []
    i = end
    while i < len(rest) and rest[i] == 0:
        i += 1
    fields = rest[i:].split(b"\0")
    return fields[argc:]


def run_processes(tag_entry=TAG_ENTRY):
    """Pids of live processes whose environment, not their arguments, carries this run's tag."""
    me = os.getpid()
    return [p for p in _all_pids() if p != me and tag_entry in _environment(_procargs(p))]


def end_run_processes():
    for _ in range(3):
        left = run_processes()
        if not left:
            return
        for pid in left:
            try:
                os.kill(pid, signal.SIGCONT)
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.2)


atexit.register(end_run_processes)
# SIGTERM ends the run through Python's exit path, so atexit runs; Ctrl+C
# (KeyboardInterrupt) already does.
signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def wait_dead(pids, limit=5.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        left = [p for p in pids if alive(p)]
        if not left:
            return []
        time.sleep(0.05)
    return [p for p in pids if alive(p)]


def read_pids(path, count, limit=5.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        try:
            with open(path) as f:
                pids = [int(x) for x in f.read().split()]
            if len(pids) >= count:
                return pids
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("program never wrote its pids")


class Run:
    """One helper, driven the way the plugin drives it."""

    def __init__(self, program, rows=24, cols=80, cwd=None, spawner=None):
        with open(HELPER) as f:
            source = f.read()
        self.data, data_child = socket.socketpair()
        self.out, out_child = socket.socketpair()
        self.ctl, ctl_child = socket.socketpair()
        err_r, err_w = os.pipe()
        env = dict(os.environ)
        env["VAULT_TERMINAL_HELPER"] = source
        env["VAULT_TERMINAL_TEST_RUN"] = RUN_TAG
        args = [PY, "-I", "-c", BOOT, "vault-terminal", "test", "--rows", str(rows), "--cols", str(cols)]
        if cwd:
            args += ["--cwd", cwd]
        args += ["--"] + list(program)
        if spawner:
            args = spawner + args
        actions = [
            (os.POSIX_SPAWN_DUP2, data_child.fileno(), 0),
            (os.POSIX_SPAWN_DUP2, out_child.fileno(), 1),
            (os.POSIX_SPAWN_DUP2, err_w, 2),
            (os.POSIX_SPAWN_DUP2, ctl_child.fileno(), 3),
        ]
        self.pid = os.posix_spawn(args[0], args, env, file_actions=actions)
        for s in (data_child, out_child, ctl_child):
            s.close()
        os.close(err_w)
        self.err = err_r
        self.output = bytearray()
        self.messages = []
        self.ctl_buf = bytearray()
        self.stderr = bytearray()
        self.reaped = None

    def send(self, data):
        self.data.sendall(data)

    def control(self, raw):
        self.ctl.sendall(raw)

    def resize(self, rows, cols):
        self.control((json.dumps({"type": "resize", "rows": rows, "cols": cols}) + "\n").encode())

    def close(self):
        self.control(b'{"type": "close"}\n')

    def pump(self, until, limit=10.0, read_output=True):
        end = time.monotonic() + limit
        while time.monotonic() < end:
            if until():
                return True
            fds = [self.ctl, self.err] + ([self.out] if read_output else [])
            ready, _, _ = select.select(fds, [], [], 0.05)
            for r in ready:
                if r is self.err:
                    chunk = os.read(self.err, 65536)
                    self.stderr += chunk
                    continue
                try:
                    chunk = r.recv(65536)
                except OSError:
                    chunk = b""
                if r is self.out:
                    self.output += chunk
                elif r is self.ctl:
                    self.ctl_buf += chunk
                    while b"\n" in self.ctl_buf:
                        line, _, rest = bytes(self.ctl_buf).partition(b"\n")
                        self.ctl_buf = bytearray(rest)
                        self.messages.append(json.loads(line))
        return until()

    def message(self, kind):
        for m in self.messages:
            if m.get("type") == kind:
                return m
        return None

    def wait_exit(self, limit=10.0):
        # With the control socket closed, as after a renderer crash, no exit
        # message can arrive; the helper ending is the only sign.
        closed = self.ctl.fileno() < 0
        ok = closed or self.pump(lambda: self.message("exit") or self.message("error"), limit)
        end = time.monotonic() + limit
        while self.reaped is None and time.monotonic() < end:
            pid, st = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.reaped = st
            else:
                time.sleep(0.02)
        return self.reaped is not None if closed else ok

    def finish(self):
        if self.reaped is None:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except OSError:
                pass
        for s in (self.data, self.out, self.ctl):
            s.close()
        os.close(self.err)


SIZE_PROGRAM = r"""
import fcntl, os, signal, struct, termios, time
def report(*a):
    r, c = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))[:2]
    os.write(1, ('S %d %d\n' % (r, c)).encode())
signal.signal(signal.SIGWINCH, report)
os.write(1, b'R\n')
while True:
    time.sleep(1)
"""

# Starts the kinds of process a terminal accumulates, writes their pids, then waits:
#   job      a background job in its own process group, as a shell makes
#   session  a child that called setsid but is still a descendant
#   stopped  a job stopped with SIGSTOP, which ignores HUP and TERM until continued
#   orphan   double-forked so it's reparented to launchd, but still on the tty
#   daemon   double-forked and setsid: left the session; the known boundary
FAMILY_PROGRAM = r"""
import os, signal, sys, time
out = sys.argv[1]
pids = []
def child(setup):
    pid = os.fork()
    if pid == 0:
        setup()
        while True:
            time.sleep(1)
    return pid
pids.append(child(lambda: os.setpgid(0, 0)))
pids.append(child(os.setsid))
pids.append(child(lambda: os.kill(os.getpid(), signal.SIGSTOP)))
def double(detach):
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        if os.fork() == 0:
            if detach:
                os.setsid()
            os.write(w, ('%d ' % os.getpid()).encode())
            while True:
                time.sleep(1)
        os._exit(0)
    os.waitpid(pid, 0)
    return int(os.read(r, 32))
pids.append(double(False))
pids.append(double(True))
with open(out, 'w') as f:
    f.write(' '.join(str(p) for p in pids))
os.write(1, b'R\n')
while True:
    time.sleep(1)
"""


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.runs = []
        self.tmp = tempfile.mkdtemp(prefix="vault terminal ")  # a space, on purpose

    def tearDown(self):
        for r in self.runs:
            r.finish()
        # A check that failed partway (or a helper killed above) can leave
        # what the program started.
        end_run_processes()

    def run_helper(self, program, **kw):
        r = Run(program, **kw)
        self.runs.append(r)
        return r

    def test_first_size_reaches_program_before_it_starts(self):
        r = self.run_helper(["/bin/stty", "size"], rows=37, cols=113)
        self.assertTrue(r.wait_exit())
        ready = r.message("ready")
        self.assertIsNotNone(ready)
        self.assertGreater(ready["pid"], 1)
        self.assertTrue(ready["tty"].startswith("/dev/tty"), ready["tty"])
        self.assertIn(b"37 113", r.output)
        self.assertEqual(r.message("exit")["code"], 0)

    def test_working_folder_with_spaces(self):
        r = self.run_helper(["/bin/pwd"], cwd=self.tmp)
        self.assertTrue(r.wait_exit())
        self.assertIn(os.path.realpath(self.tmp).encode(), bytes(r.output).replace(b"\r\n", b"\n"))

    def test_bytes_pass_unaltered_when_split_across_reads(self):
        prog = "import os,time;os.write(1,b'\\xe2\\x82');time.sleep(0.2);os.write(1,b'\\xac\\xf0\\x9f');time.sleep(0.2);os.write(1,b'\\x98\\x80')"
        r = self.run_helper([PY, "-c", prog])
        self.assertTrue(r.wait_exit())
        self.assertIn("€😀".encode(), r.output)

    def test_resize_messages_split_and_merged_end_at_last_size(self):
        r = self.run_helper([PY, "-c", SIZE_PROGRAM])
        self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
        batch = b"".join((json.dumps({"type": "resize", "rows": 10 + i, "cols": 20 + i}) + "\n").encode()
                         for i in range(200))
        r.control(batch)  # merged: 200 messages in one write
        self.assertTrue(r.pump(lambda: b"S 209 219\r\n" in r.output))
        storm = r.output.count(b"S ")
        self.assertLess(storm, 50, "a merged batch should apply few sizes, not all 200")
        for byte in (json.dumps({"type": "resize", "rows": 40, "cols": 120}) + "\n").encode():
            r.control(bytes([byte]))  # split: one byte per write
            time.sleep(0.002)
        self.assertTrue(r.pump(lambda: r.output.endswith(b"S 40 120\r\n")))
        r.control(b'{"type": "resize", "rows": 0, "cols": 80}\n{"type": "resize", "rows": 5}\nnot json\n')
        time.sleep(0.3)
        r.pump(lambda: False, 0.3)
        self.assertTrue(r.output.endswith(b"S 40 120\r\n"), "zero or malformed sizes must be dropped")
        r.close()
        self.assertTrue(r.wait_exit())

    def test_heavy_output_arrives_complete_and_in_order(self):
        prog = ("import hashlib,os\nh=hashlib.sha256()\nfor i in range(400000):\n"
                " line=('%08d ' % i + 'x'*70 + '\\n').encode()\n h.update(line)\n os.write(1,line)\n"
                "os.write(2, h.hexdigest().encode())")
        # Set the pty raw first so it doesn't turn \n into \r\n.
        r = self.run_helper(["/bin/sh", "-c", 'stty raw -echo; exec "$0" -c "$1" 2>"$2"', PY, prog,
                             os.path.join(self.tmp, "digest")])
        time.sleep(1.5)  # let the helper's buffer fill and the program block
        self.assertTrue(r.wait_exit(limit=60))
        with open(os.path.join(self.tmp, "digest")) as f:
            expected = f.read()
        self.assertEqual(len(r.output), 400000 * 80)
        self.assertEqual(hashlib.sha256(bytes(r.output)).hexdigest(), expected)

    def test_large_paste_into_echoing_program_does_not_deadlock(self):
        r = self.run_helper(["/bin/sh", "-c", "stty raw -echo; printf R; exec cat"])
        self.assertTrue(r.pump(lambda: b"R" in r.output))
        payload = bytes((i * 7) % 251 for i in range(4 * 1024 * 1024))
        r.output.clear()
        r.data.setblocking(False)
        sent = 0
        end = time.monotonic() + 60
        while (sent < len(payload) or len(r.output) < len(payload)) and time.monotonic() < end:
            if sent < len(payload):
                try:
                    sent += r.data.send(payload[sent:sent + 65536])
                except BlockingIOError:
                    pass
            r.pump(lambda: True, 0)
            ready, _, _ = select.select([r.out], [], [], 0.01)
            if ready:
                r.output += r.out.recv(262144)
        self.assertEqual(bytes(r.output), payload)
        r.close()
        self.assertTrue(r.wait_exit())

    def test_exec_failure_is_reported(self):
        r = self.run_helper(["/nonexistent/vault-terminal-test"])
        self.assertTrue(r.wait_exit())
        err = r.message("error")
        self.assertEqual(err["kind"], "spawn")
        self.assertEqual(err["errno"], 2)

    def test_signals_are_reset_in_the_program(self):
        r = self.run_helper(["/bin/sh", "-c", "yes | head -1 >/dev/null; echo done"])
        self.assertTrue(r.wait_exit(limit=5), "yes | head never ends when SIGPIPE stays ignored")
        self.assertIn(b"done", r.output)

    def test_pty_has_iutf8(self):
        r = self.run_helper(["/bin/stty", "-a"])
        self.assertTrue(r.wait_exit())
        self.assertIn(b" iutf8", r.output)
        self.assertNotIn(b"-iutf8", r.output)

    def test_program_inherits_only_the_pty(self):
        prog = "import os\nopen_fds=[]\nfor fd in range(3,1024):\n try:\n  os.fstat(fd); open_fds.append(fd)\n except OSError: pass\nprint('FDS', open_fds)"
        r = self.run_helper([PY, "-I", "-c", prog])
        self.assertTrue(r.wait_exit())
        self.assertIn(b"FDS []", r.output)

    def family(self, end):
        path = os.path.join(self.tmp, "pids")
        r = self.run_helper([PY, "-c", FAMILY_PROGRAM, path])
        self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
        job, session, stopped, orphan, daemon = read_pids(path, 5)
        end(r)
        self.assertTrue(r.wait_exit(limit=10), r.stderr.decode())
        left = wait_dead([job, session, stopped, orphan, r.pid], limit=3)
        self.assertEqual(left, [], "left running")
        # The known boundary: double-forked and out of the session. Terminal.app
        # leaves these too. Recorded here so a change in behavior is noticed.
        daemon_survived = alive(daemon)
        if daemon_survived:
            os.kill(daemon, signal.SIGKILL)
        return daemon_survived

    def test_close_ends_everything_the_program_started(self):
        if os.environ.get("TL_FAIL_ON_PURPOSE"):
            # For the harness: fail with the whole family running, as a broken check would.
            path = os.path.join(self.tmp, "pids")
            r = self.run_helper([PY, "-c", FAMILY_PROGRAM, path])
            self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
            read_pids(path, 5)
            if os.environ["TL_FAIL_ON_PURPOSE"] == "wait":
                print("FAMILY-RUNNING", flush=True)
                time.sleep(60)
            self.fail("failing on purpose")
        self.family(lambda r: r.close())

    def test_renderer_death_ends_everything(self):
        def die(r):
            r.data.close()
            r.ctl.close()
        self.family(die)

    def test_parent_gone_without_eof_ends_everything(self):
        # An intermediate process starts the helper and exits; the test keeps the
        # helper's pipes open, so only the parent check can notice.
        spawner = [PY, "-c", "import os,sys;os.posix_spawn(sys.argv[1],sys.argv[1:],os.environ)"]
        path = os.path.join(self.tmp, "pids")
        r = self.run_helper([PY, "-c", FAMILY_PROGRAM, path], spawner=spawner)
        self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
        job, session, stopped, orphan, daemon = read_pids(path, 5)
        self.assertTrue(r.pump(lambda: r.message("exit"), limit=10), r.stderr.decode())
        self.assertEqual(wait_dead([job, session, stopped, orphan], limit=3), [])
        if alive(daemon):
            os.kill(daemon, signal.SIGKILL)

    def test_replacement_started_while_ending_is_ended_too(self):
        # Ignores HUP; on TERM starts a replacement in a session of its own
        # (no tty, so only its parent leads to it) that ignores TERM too.
        prog = r"""
import os, signal, sys, time
out = sys.argv[1]
signal.signal(signal.SIGHUP, signal.SIG_IGN)
def on_term(*a):
    pid = os.fork()
    if pid == 0:
        os.setsid()
        while True:
            time.sleep(1)
    with open(out, 'w') as f:
        f.write(str(pid))
signal.signal(signal.SIGTERM, on_term)
os.write(1, b'R\n')
while True:
    time.sleep(1)
"""
        path = os.path.join(self.tmp, "pid")
        r = self.run_helper([PY, "-c", prog, path])
        self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
        r.close()
        self.assertTrue(r.wait_exit(), r.stderr.decode())
        (replacement,) = read_pids(path, 1)
        survived = wait_dead([replacement], limit=3)
        if survived:
            os.kill(replacement, signal.SIGKILL)
        self.assertEqual(survived, [])

    def test_natural_exit_ends_leftover_jobs_and_reports_code(self):
        path = os.path.join(self.tmp, "pid")
        r = self.run_helper(["/bin/sh", "-c", 'sleep 987003 & echo $! > "$0"; exit 3', path])
        self.assertTrue(r.wait_exit())
        self.assertEqual(r.message("exit")["code"], 3)
        (job,) = read_pids(path, 1)
        self.assertEqual(wait_dead([job], limit=3), [])

    def test_output_before_exit_is_not_lost(self):
        r = self.run_helper(["/bin/sh", "-c", "printf 'last words'; exit 0"])
        self.assertTrue(r.wait_exit())
        self.assertIn(b"last words", r.output)


    def test_close_ends_a_writer_that_ignores_hup_and_term(self):
        # It keeps the pty busy as the helper drains it while closing: the
        # drain must not stop the helper reaching its SIGKILL.
        program = "import os,signal\nsignal.signal(signal.SIGHUP,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nos.write(1,b'R\\n')\nwhile True: os.write(1,b'y'*4096)\n"
        r = self.run_helper([PY, "-c", program])
        self.assertTrue(r.pump(lambda: b"R\r\n" in r.output))
        writer = r.message("ready")["pid"]
        start = time.monotonic()
        r.close()
        self.assertTrue(r.wait_exit(limit=10), r.stderr.decode())
        self.assertEqual(wait_dead([writer, r.pid], limit=3), [], "the writer or the helper left running")
        self.assertLess(time.monotonic() - start, 8)


class ScriptOfTest(unittest.TestCase):
    """The script an interpreter runs, as the foreground program's name (89)."""

    @classmethod
    def setUpClass(cls):
        ns = {"__name__": "helper_under_test"}
        with open(HELPER) as f:
            exec(compile(f.read(), HELPER, "exec"), ns)
        cls.script_of = staticmethod(ns["script_of"])

    def test_options_and_their_values_are_skipped(self):
        self.assertEqual(self.script_of(["node", "/opt/bin/claude", "--resume"]), "claude")
        self.assertEqual(self.script_of(["node", "--require", "preload.js", "/opt/bin/claude"]), "claude")
        self.assertEqual(self.script_of(["node", "-r", "a.js", "--no-warnings", "/opt/bin/codex"]), "codex")
        self.assertEqual(self.script_of(["python3", "-m", "agy"]), "agy")
        self.assertEqual(self.script_of(["node"]), "")
        self.assertEqual(self.script_of(["node", "--", "-odd-name"]), "-odd-name")
        self.assertEqual(self.script_of(["deno", "run", "-A", "/x/agent.ts"]), "agent.ts")
        self.assertEqual(self.script_of(["bun", "run", "/x/codex"]), "codex")


if __name__ == "__main__":
    unittest.main(verbosity=2)
