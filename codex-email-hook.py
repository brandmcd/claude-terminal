#!/usr/bin/env python3
"""Adapt the shared Claude email gate to Codex's allow/deny-only hook protocol."""
import http.client
import json
import os
import socket
import subprocess
import sys


def decision(value, reason):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": value, "permissionDecisionReason": reason}}


def main():
    try:
        event = json.load(sys.stdin)
        # Native Codex hooks normalize exec_command to Bash, including code-mode calls.
        result = subprocess.run(
            [sys.executable, os.path.expanduser("~/.claude/hooks/email-gate.py")],
            input=json.dumps(event), text=True, capture_output=True, timeout=10, check=True)
        if not result.stdout.strip():
            return
        output = json.loads(result.stdout)
        detail = output["hookSpecificOutput"]
        if detail["permissionDecision"] == "allow":
            print(json.dumps(output))
            return
        reason = detail.get("permissionDecisionReason", "Approve this email before it is sent.")
        if str(event.get("tool_name", "")).startswith("mcp__"):
            reason += "\n\nComplete send arguments:\n" + json.dumps(event.get("tool_input"), indent=2)
        path = os.environ.get("CT_EMAIL_GATE_SOCKET")
        if not path:
            print(json.dumps(decision("deny", reason + "\nEmail approval is available in the chat app. No email was sent.")))
            return
        connection = http.client.HTTPConnection("localhost", timeout=310)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(310)
        connection.sock.connect(path)
        try:
            connection.request("POST", "/approve", json.dumps({"reason": reason}), {"Content-Type": "application/json"})
            response = connection.getresponse()
            approved = response.status == 200 and json.loads(response.read()).get("approved") is True
        finally:
            connection.close()
        print(json.dumps(decision("allow" if approved else "deny",
              "The user approved this exact email send." if approved else "Email send cancelled or approval expired. Do not retry without new approval.")))
    except Exception:
        # Codex hook exceptions are fail-open; explicitly return deny for every adapter failure.
        print(json.dumps(decision("deny", "Email approval gate unavailable. No tool execution is permitted until the gate recovers.")))


if __name__ == "__main__":
    main()
