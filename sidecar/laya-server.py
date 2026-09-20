#!/usr/bin/env python3
"""Serve Laya over the one endpoint jeffrey speaks.

Laya (https://github.com/NandhaKishorM/laya, Apache 2.0) ships as a Python package with no
server, and jeffrey is a Node CLI. This is the whole bridge: a standard-library HTTP server that
takes a System One request and hands it to `laya`, unchanged.

    POST /v1/systemone   {"state": ..., "model": "router", "questions": {...}}
                      -> {"model": ..., "answers": {...}, "usage": {...}, "routing": {...}}
    GET  /v1/models      the checkpoints this server can route to
    GET  /healthz        which checkpoints are resident

Run it:

    uv run --python 3.12 --with laya --with torch sidecar/laya-server.py --preload typed-decisions
    python3 sidecar/laya-server.py --preload          # laya already installed

Then point jeffrey at it:

    jeffrey --decider laya "fix the failing test"

Notes that matter for an agent loop:

  * Preload. A cold checkpoint build costs seconds; without --preload the first request of each
    language pays it again.
  * Context. The checkpoints read 512 (english) or 1024 (multilingual, typed-decisions) tokens.
    jeffrey's state is larger than that, and the tail — the recent history and the progress
    rubric — is what gets cut. Raise --max-len if your hardware allows; the encoder behind
    laya-multilingual supports up to 8192.
  * Option budget. Every option label of a `choice` question shares --head-max-len tokens. Too
    many options for that budget is a 400 from this server, naming the question.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHECKPOINTS = {
    "english": "ModernBERT-large, 421M, 512 context, English only",
    "multilingual": "mmBERT-base, 322M, 1024 context, 100+ languages",
    "typed-decisions": "ModernBERT-large, 421M, 1024 context, fine-tuned for typed workflows",
}
ROUTER_NAMES = {"router", "auto", "", None}

# One forward pass at a time: the checkpoints are shared mutable torch modules, and jeffrey asks
# one question batch per step anyway.
LOCK = threading.Lock()


class Server:
    def __init__(self, args: argparse.Namespace) -> None:
        import laya

        self.args = args
        self.version = laya.__version__
        self.router = laya.Router(
            device=args.device,
            max_loaded=3,
            default=args.default_model,
        )
        if args.preload:
            names = args.preload if isinstance(args.preload, list) else None
            self.router.preload(names)

    def apply_limits(self, agent) -> None:
        """Per-server token budgets. Defaults come from the checkpoint's own config."""
        if self.args.head_max_len:
            agent.cfg["head_max_len"] = self.args.head_max_len
        if self.args.max_len:
            agent.cfg["max_len"] = self.args.max_len

    def answer(self, payload: dict) -> dict:
        questions = payload.get("questions") or {}
        if not isinstance(questions, dict) or not questions:
            raise Bad("no questions in the request")
        state = payload.get("state", "")
        model = payload.get("model")
        requested = None if model in ROUTER_NAMES else model

        with LOCK:
            decision = self.router.route(state, questions, model=requested)
            # Laya's own routing sends English to the `english` checkpoint, which is the 512-token
            # one and the weakest on typed workflows. An agent state is always English, so the
            # language router has nothing to decide here: --default-model settles it, and routing
            # still does its job for anything that is not English.
            if requested is None and decision["model"] == "english" and self.args.default_model != "english":
                decision = self.router.route(state, questions, model=self.args.default_model)
            agent = self.router.load(decision["model"])
            self.apply_limits(agent)
            for key in ("head_max_len", "max_len"):
                if payload.get(key):
                    agent.cfg[key] = int(payload[key])
            try:
                result = agent.system_one(state, questions)
            except ValueError as error:
                # "options exceed head_max_len" is the one failure a caller can fix, so say how.
                raise Bad(
                    "%s — raise --head-max-len (currently %s) or split the question"
                    % (error, agent.cfg.get("head_max_len"))
                ) from error

        result["routing"] = dict(decision)
        result["model"] = "laya-%s" % decision["model"]
        return result

    def models(self) -> dict:
        return {
            "models": [
                {"name": "router", "description": "detect the language, then pick a checkpoint", "release_date": ""},
                *(
                    {"name": name, "description": description, "release_date": ""}
                    for name, description in CHECKPOINTS.items()
                ),
            ]
        }


class Bad(Exception):
    """A request this server cannot answer, reported as a 400 with its own text."""


def make_handler(server: Server, api_key: str | None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - base class name
            if server.args.quiet:
                return
            sys.stderr.write("laya %s\n" % (fmt % args))

        def send_json(self, status: int, body: dict) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self) -> bool:
            if not api_key:
                return True
            return self.headers.get("Authorization", "") == "Bearer %s" % api_key

        def do_GET(self) -> None:  # noqa: N802 - base class name
            if self.path.rstrip("/") == "/healthz":
                self.send_json(200, {"ok": True, "laya": server.version, "loaded": server.router.loaded})
            elif self.path.rstrip("/") in ("/v1/models", "/models"):
                self.send_json(200, server.models())
            else:
                self.send_json(404, {"error": "no route %s" % self.path})

        def do_POST(self) -> None:  # noqa: N802 - base class name
            if self.path.rstrip("/") not in ("/v1/systemone", "/systemone"):
                self.send_json(404, {"error": "no route %s" % self.path})
                return
            if not self.authorized():
                self.send_json(401, {"error": "bad or missing Authorization header"})
                return

            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError as error:
                self.send_json(400, {"error": "body is not JSON: %s" % error})
                return

            try:
                self.send_json(200, server.answer(payload))
            except Bad as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - the server must survive one bad request
                traceback.print_exc()
                self.send_json(500, {"error": "%s: %s" % (type(error).__name__, error)})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8137)
    parser.add_argument("--device", default=None, help="cpu, cuda, mps; laya picks one otherwise")
    parser.add_argument(
        "--default-model",
        default="typed-decisions",
        choices=sorted(CHECKPOINTS),
        help="checkpoint for English states, which is what a coding agent sends",
    )
    parser.add_argument(
        "--preload",
        nargs="*",
        default=None,
        metavar="NAME",
        help="build checkpoints at startup (all of them, or the ones named)",
    )
    parser.add_argument("--head-max-len", type=int, default=512, help="token budget shared by a question's options")
    parser.add_argument("--max-len", type=int, default=1024, help="total context per question")
    parser.add_argument("--api-key", default=None, help="require this bearer token")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    if args.preload == []:
        args.preload = True

    try:
        server = Server(args)
    except ImportError:
        sys.stderr.write(
            "laya is not installed. Either:\n"
            "  uv run --python 3.12 --with laya --with torch sidecar/laya-server.py --preload typed-decisions\n"
            "  pip install laya torch\n"
        )
        return 1

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(server, args.api_key))
    sys.stderr.write(
        "laya %s serving http://%s:%d/v1/systemone (default %s, loaded %s)\n"
        % (server.version, args.host, args.port, args.default_model, server.router.loaded or "on demand")
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
