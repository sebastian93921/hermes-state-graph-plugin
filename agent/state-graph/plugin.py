"""state-graph — agent half.

Registers ONE tool, `state_graph_note`, which lets the agent say what it is
working on in its own words. The desktop half of this plugin
(`$HERMES_HOME/desktop-plugins/state-graph/plugin.js`) watches the gateway event
stream, so it sees this call's arguments the moment it happens and paints the
sentence as a TASK BAND on the graph (its own card, with the steps that follow
grouped under it) plus a header above those cards in the trail. Nothing is
pushed between the halves — no socket, no shared file — because the tool call IS
the message.

Why a tool: every automatic summary is a guess made from tool args ("editing
plugin.js"). Only the agent knows it is "adding agent-authored work summaries to
the state graph". A tool call is the cheapest honest channel for that.
"""

from __future__ import annotations

import ast
import json
import re
import os
from typing import Any, Dict

TOOL_NAME = "state_graph_note"

SCHEMA: Dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Declare what you are working on right now, in one short sentence, for the user's "
        "desktop State Graph. Call it when the WORK changes phase — starting a new piece of "
        "work, switching focus to a different file or sub-task, or finishing one — not on every "
        "tool call. The sentence becomes the title of a task band on the graph, and the tool "
        "calls that follow are grouped under it (e.g. 'building the state graph plugin (first "
        "version)', 'adding agent-authored work summaries to the graph'). Keep it under ~10 "
        "words, no trailing punctuation. If you keep a todo_list, this should read like one of "
        "its items."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "description": (
                    "One short sentence naming the work, in the user's terms — what is being "
                    "built, investigated, or changed. e.g. 'wiring agent-authored summaries into "
                    "the graph'."
                ),
            },
            "status": {
                "type": "string",
                "enum": ["started", "working", "done"],
                "description": (
                    "Optional. 'done' closes the band out; omit (or 'working') while it is "
                    "still in progress."
                ),
            },
        },
        "required": ["summary"],
    },
}

_SUMMARY_RE = re.compile(r"summary['\"]?\s*[:=]\s*['\"]([^'\"]+)", re.IGNORECASE)


def _unwrap_summary(value: Any) -> str:
    """The agent's sentence, however it arrived.

    A model occasionally sends the whole call as ONE string — e.g.
    ``{"summary": "wiring the note tool", "status": "working"}`` — and that repr
    would end up painted on the graph card. Unwrap it instead of storing it.
    """
    if isinstance(value, dict):
        return _unwrap_summary(value.get("summary"))

    if isinstance(value, (list, tuple)) and value:
        return _unwrap_summary(value[0])

    text = " ".join(str(value or "").split())

    if text.startswith("{") and text.endswith("}"):
        for parser in (json.loads, ast.literal_eval):
            try:
                data = parser(text)
            except Exception:
                continue

            if isinstance(data, dict) and data.get("summary") is not None:
                return _unwrap_summary(data["summary"])

        match = _SUMMARY_RE.search(text)

        if match:
            return " ".join(match.group(1).split())

    return text

# ── enforcement ──────────────────────────────────────────────────────────────
# Tools that are NOT "work": they must stay callable before the note so a turn
# can always start (read the task, plan it, ask a question) and so the gate can
# never deadlock.
_UNGATED_TOOLS = frozenset({
    TOOL_NAME,
    "clarify",
    "memory",
    "session_search",
    "skill_view",
    "skills_list",
    "todo_list",
})

# A model that keeps refusing to call the tool must not wedge the session: after
# this many vetoes the gate opens for the rest of the turn. Kept low because a
# session whose tool surface predates this plugin (an open chat from before the
# plugin was enabled) cannot call the note tool at all — there the gate costs a
# couple of retries per turn and then steps aside.
_MAX_DENIALS_PER_PROMPT = int(os.environ.get("STATE_GRAPH_GATE_DENIALS") or 2)

# `STATE_GRAPH_GATE=0` in the environment disables enforcement entirely (the
# tool and the rendering keep working).
_GATE_ENABLED = os.environ.get("STATE_GRAPH_GATE", "").strip().lower() not in {"0", "false", "off", "no"}
_STATE_CAP = 512

# Keyed by SESSION, because `turn_id` advances between agent steps inside one
# user request: the declaration has to cover the whole request, and reset when
# the next prompt arrives. `_last_prompt` is what detects that.
_declared: set = set()
_denials: Dict[str, int] = {}
_injected: set = set()
_last_prompt: Dict[str, str] = {}


def _sid(session_id: Any) -> str:
    return str(session_id or "")


def _prompt_text(user_message: Any) -> str:
    """A stable fingerprint of the prompt that opened this request."""
    if isinstance(user_message, str):
        return " ".join(user_message.split())[:400]

    if isinstance(user_message, dict):
        for key in ("content", "text", "message"):
            if isinstance(user_message.get(key), str):
                return " ".join(user_message[key].split())[:400]

    try:
        return json.dumps(user_message, sort_keys=True, default=str)[:400]
    except Exception:
        return str(user_message)[:400]


def _trim() -> None:
    """Bound the bookkeeping so a long-lived gateway can't grow it forever."""
    while len(_last_prompt) > _STATE_CAP:
        gone = next(iter(_last_prompt))
        _last_prompt.pop(gone)
        _declared.discard(gone)
        _denials.pop(gone, None)
        _injected.discard(gone)


def _note_instruction() -> str:
    return (
        "State Graph: before your FIRST tool call in this turn, call "
        f'`{TOOL_NAME}(summary="<one short sentence naming the work>")` — the user\'s '
        "desktop graph uses that sentence as the task band for everything you do next. "
        "One sentence, no trailing punctuation. Re-call it only when the work changes phase."
    )


def _on_pre_llm_call(*, session_id: str = "", user_message: Any = None, **kwargs: Any):
    """Open a fresh request when the prompt changes, and tell the model to
    declare the work — once per request, not on every model call."""
    sid = _sid(session_id)

    if sid and _last_prompt.get(sid) != _prompt_text(user_message):
        _last_prompt[sid] = _prompt_text(user_message)
        _declared.discard(sid)
        _denials.pop(sid, None)
        _injected.discard(sid)
        _trim()

    if sid in _injected or sid in _declared:
        return None

    _injected.add(sid)

    return {"context": _note_instruction()}


def _on_pre_tool_call(*, tool_name: str = "", session_id: str = "", **kwargs: Any):
    """Veto work until the note lands for THIS prompt. ``{"action": "block"}``
    makes the message the tool result, so the model reads the exact call to make
    and retries."""
    sid = _sid(session_id)

    if tool_name == TOOL_NAME:
        _declared.add(sid)

        return None

    if not _GATE_ENABLED or tool_name in _UNGATED_TOOLS or sid in _declared:
        return None

    denials = _denials.get(sid, 0)

    if denials >= _MAX_DENIALS_PER_PROMPT:
        # Fail open: the request matters more than the label. Sessions whose tool
        # surface predates this plugin can never satisfy the gate, and a stubborn
        # model must not wedge a turn.
        _declared.add(sid)

        return None

    _denials[sid] = denials + 1

    return {
        "action": "block",
        "message": (
            f"BLOCKED before running {tool_name}: declare the work first.\n"
            f'Call {TOOL_NAME}(summary="<one short sentence naming what you are about to do>"), '
            f"then retry this call. The user's State Graph shows that sentence as the task band, "
            f"and the steps after it are grouped underneath."
        ),
    }


def _handle_state_graph_note(summary: Any = "", status: str = "working", **kwargs: Any) -> str:
    """Return a short acknowledgement. The desktop half reads the CALL's args off
    the event stream, so the return value only has to confirm the note landed."""
    text = _unwrap_summary(summary)[:200]

    if not text:
        return json.dumps({"ok": False, "error": "summary is required"})

    state = str(status or "working").strip().lower()
    state = state if state in {"started", "working", "done"} else "working"

    return json.dumps({"ok": True, "summary": text, "status": state})


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)

    ctx.register_tool(
        name=TOOL_NAME,
        toolset="state_graph",
        schema=SCHEMA,
        handler=_handle_state_graph_note,
        description="Declare the work in progress for the desktop State Graph.",
        emoji="🪢",
    )
