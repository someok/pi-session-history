#!/usr/bin/env python3
"""用隔离配置和真实 tmux 终端检查 pi 1.1.0，不触碰用户会话或调用模型。"""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
PI = str(Path(os.environ.get("PI_BIN", ROOT / "node_modules/.bin/pi")).absolute())
TMUX = shutil.which("tmux")


def save_session(directory, cwd, session_id, name, marker, ago):
    activity = int(time.time() * 1000) - ago
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(activity / 1000))
    entries = [
        {"type": "session", "version": 3, "id": session_id, "timestamp": timestamp, "cwd": str(cwd)},
        {"type": "message", "id": "user", "parentId": None, "timestamp": timestamp,
         "message": {"role": "user", "content": "Isolated smoke request", "timestamp": activity - 1}},
        {"type": "message", "id": "assistant", "parentId": "user", "timestamp": timestamp,
         "message": {"role": "assistant", "content": [{"type": "text", "text": marker}],
                     "api": "openai-responses", "provider": "openai", "model": "gpt-4.1-mini",
                     "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                     "stopReason": "stop", "timestamp": activity}},
        {"type": "session_info", "id": "name", "parentId": "assistant", "timestamp": timestamp, "name": name},
    ]
    path = directory / (session_id + ".jsonl")
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    return path


class TerminalHost:
    def __init__(self, socket, cwd, env, cli_options):
        self.socket = str(socket)
        self.cwd = cwd
        self.env = env
        self.cli_options = cli_options

    def tmux(self, *args, check=True):
        return subprocess.run(
            [TMUX, "-S", self.socket, "-f", "/dev/null", *args],
            env=self.env, text=True, capture_output=True, check=check, timeout=15,
        )

    def start(self, mode, *options):
        self.tmux("new-session", "-d", "-s", "smoke", "-x", "120", "-y", "44",
                  "-c", str(self.cwd), "exec " + shlex.join([
                      PI, *self.cli_options, "--extension", str(ROOT if mode == "fullscreen" else ROOT / "src/index.ts"),
                      "--tui-mode", mode, *options,
                  ]))
        self.tmux("set-option", "-w", "-t", "smoke", "remain-on-exit", "on")

    def screen(self):
        return self.tmux("capture-pane", "-p", "-t", "smoke:0.0").stdout

    def wait(self, predicate, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            screen = self.screen()
            if predicate(screen):
                return screen
            if self.tmux("display-message", "-p", "-t", "smoke:0.0", "#{pane_dead}").stdout.strip() == "1":
                raise RuntimeError(f"pi 已提前退出：{description}\n{screen}")
            # 只轮询真实外部终端的可见状态，不以等待固定时长作为成功判据。
            time.sleep(0.03)
        raise RuntimeError(f"等待终端超时：{description}\n{self.screen()}")

    def key(self, *keys):
        self.tmux("send-keys", "-t", "smoke:0.0", *keys)

    def command(self, text):
        self.tmux("send-keys", "-t", "smoke:0.0", "-l", text)
        self.key("Enter")

    def session(self, session_id):
        self.command("/session")
        self.wait(lambda screen: f"ID: {session_id}" in screen, f"原生 /session 确认 {session_id}")

    def stop(self):
        self.tmux("kill-session", "-t", "smoke", check=False)

    def close(self):
        self.tmux("kill-server", check=False)


def check_interactive(host, mode, source):
    host.start(mode, "--session", str(source))
    host.wait(lambda screen: "SOURCE_TRANSCRIPT" in screen, f"{mode} 扩展正常加载")
    host.command("/history")
    host.wait(lambda screen: "History (Current Folder)" in screen and "History smoke target" in screen
              and "Original smoke task" in screen and "Loading sessions" not in screen, f"{mode} 打开 /history")
    host.key("Down")
    host.wait(lambda screen: "› Original smoke task" in screen, f"{mode} 向下选择")
    host.key("Up")
    host.wait(lambda screen: "› History smoke target" in screen, f"{mode} 向上选择")
    host.key("Escape")
    host.wait(lambda screen: "History (Current Folder)" not in screen, f"{mode} 取消 /history")
    host.session("smoke-source")
    host.command("/history")
    host.wait(lambda screen: "› History smoke target" in screen and "Loading sessions" not in screen,
              f"{mode} 再次打开 /history")
    host.key("Enter")
    host.wait(lambda screen: "TARGET_TRANSCRIPT" in screen and "History (Current Folder)" not in screen,
              f"{mode} 实际恢复目标会话")
    host.session("smoke-target")
    host.command("/resume")
    host.wait(lambda screen: "Resume Session (Current Folder)" in screen and "Threaded" in screen
              and 're:<pattern> regex' in screen and "Original smoke task" in screen
              and "History smoke target" in screen and "Loading" not in screen, f"{mode} /resume 仍使用原生选择器")
    host.key("Down", "Enter")
    host.wait(lambda screen: "SOURCE_TRANSCRIPT" in screen and "Resume Session (Current Folder)" not in screen,
              f"{mode} 原生 /resume 仍能恢复")
    host.session("smoke-source")
    host.stop()
    print(f"PASS {mode}: /history 打开、选择、取消、真实恢复；原生 /resume 选择器及恢复未替换")


def check_startup_resume(host, mode):
    host.start(mode, "--resume")
    host.wait(lambda screen: "Resume Session (Current Folder)" in screen and "Threaded" in screen
              and 're:<pattern> regex' in screen and "Original smoke task" in screen
              and "History smoke target" in screen and "Loading" not in screen, f"{mode} pi --resume 仍使用原生选择器")
    host.key("Enter")
    host.wait(lambda screen: "TARGET_TRANSCRIPT" in screen, f"{mode} 启动恢复实际目标")
    host.session("smoke-target")
    host.stop()
    print(f"PASS {mode}: pi --resume 原生启动选择器及实际恢复未替换")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if not TMUX:
        raise SystemExit("需要 tmux；普通行为测试请运行 npm test。")
    if not Path(PI).is_file():
        raise SystemExit("找不到 pi，先运行 npm ci，或用 PI_BIN 指定 pi 1.1.0 的可执行文件绝对路径。")
    version = subprocess.check_output([PI, "--version"], text=True).strip()
    if version != "1.1.0":
        raise SystemExit(f"冒烟检查要求 pi 1.1.0，当前为 {version}。")
    node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
    package = ROOT / "node_modules/@earendil-works/pi-coding-agent"
    checked_files = [Path(PI).resolve(), package / "dist/modes/interactive/components/session-selector.js"]
    before = {path: digest(path) for path in checked_files}
    with tempfile.TemporaryDirectory(prefix="pi-history-smoke-") as temp:
        # macOS 的 /var 指向 /private/var；写入与 process.cwd() 一致的规范路径。
        base = Path(temp).resolve()
        cwd, sessions, agent, home = (base / name for name in ["project", "sessions", "agent", "home"])
        for path in [cwd, sessions, agent, home]:
            path.mkdir()
        (agent / "settings.json").write_text(json.dumps({"theme": "dark", "quietStartup": True, "cacheWarming": "off"}))
        # 不继承模型凭据、用户 pi 配置或当前 agent 的 PI_SESSION_* 状态。
        env = {
            "PATH": str(Path(node).parent) + os.pathsep + os.environ["PATH"],
            "HOME": str(home), "TERM": "xterm-256color", "COLORTERM": "truecolor",
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "PI_IMAGE_PROTOCOL": "none",
        }
        source = save_session(sessions, cwd, "smoke-source", "Original smoke task", "SOURCE_TRANSCRIPT", 300_000)
        save_session(sessions, cwd, "smoke-target", "History smoke target", "TARGET_TRANSCRIPT", 60_000)
        host = TerminalHost(base / "tmux.sock", cwd, env, [
            "--offline", "--no-extensions",
            "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp",
            "--no-approve", "--session-dir", str(sessions), "--model", "openai/gpt-4.1-mini", "--thinking", "off",
        ])
        try:
            for mode in ["regular", "fullscreen"]:
                check_interactive(host, mode, source)
                check_startup_resume(host, mode)
            assert all(digest(path) == value for path, value in before.items()), "pi 可执行文件或原生选择器被修改"
            print("PASS pi 1.1.0: CLI/原生选择器文件哈希未变；全部配置和会话均使用已清理的临时数据")
        finally:
            host.close()


if __name__ == "__main__":
    main()
