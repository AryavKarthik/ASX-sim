"""The coach service: checks the request and the budget, then streams Claude's reply.

Two kinds of request:
- "chat": a question, with the conversation so far, on the fast cheap model.
- "review": a full review of the journal and statistics, on the stronger model.

The model call sits behind a small `Backend` protocol so tests never touch the network.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from asxsim.coach.prompts import REVIEW_REQUEST, SYSTEM_PROMPT, user_message
from asxsim.coach.usage import Ledger, Usage
from asxsim.settings import load_env, state_dir

Kind = Literal["chat", "review"]

MAX_QUESTION_CHARS = 4_000
MAX_HISTORY_MESSAGES = 12  # the most recent turns sent back to the model
MAX_HISTORY_CHARS = 8_000  # per message

# Streaming, so there is no timeout pressure: leave room for thinking plus the answer.
MAX_TOKENS = {"chat": 8_000, "review": 16_000}
# Chat should be quick; a review is worth more thought.
EFFORT = {"chat": "low", "review": "medium"}

# Models whose safety classifiers can decline a request and that support re-running it on a
# fallback model server-side.
FALLBACK_MODELS = frozenset(
    {"claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-2"}
)
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class CoachError(Exception):
    """Something the learner should be told in plain words (no key, over budget, ...)."""


@dataclass(frozen=True, slots=True)
class Request:
    model: str
    system: str
    messages: list[dict[str, str]]
    max_tokens: int
    effort: str


@dataclass(frozen=True, slots=True)
class Finished:
    """The last item a backend yields: what the reply used and why it stopped."""

    usage: Usage
    stop_reason: str | None = None


class Backend(Protocol):
    def stream(self, request: Request) -> AsyncIterator[str | Finished]:
        """Yield text as it is written, then one `Finished`."""
        ...


class AnthropicBackend:
    """Claude through the official SDK. The key is read from the environment by the SDK."""

    def __init__(self) -> None:
        import anthropic  # lazy: only needed once a key exists

        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic()

    async def stream(self, request: Request) -> AsyncIterator[str | Finished]:
        anthropic = self._anthropic
        try:
            if request.model in FALLBACK_MODELS:
                manager = self._client.beta.messages.stream(
                    model=request.model,
                    max_tokens=request.max_tokens,
                    system=[
                        {
                            "type": "text",
                            "text": request.system,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    messages=_messages(request),
                    output_config={"effort": _effort(request.effort)},
                    betas=[FALLBACK_BETA],
                    fallbacks="default",
                )
                async with manager as stream:
                    async for text in stream.text_stream:
                        yield text
                    final = await stream.get_final_message()
                    yield _finished(final.usage, final.stop_reason)
            else:
                plain = self._client.messages.stream(
                    model=request.model,
                    max_tokens=request.max_tokens,
                    system=[
                        {
                            "type": "text",
                            "text": request.system,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    messages=_messages(request),
                    output_config={"effort": _effort(request.effort)},
                )
                async with plain as stream:
                    async for text in stream.text_stream:
                        yield text
                    message = await stream.get_final_message()
                    yield _finished(message.usage, message.stop_reason)
        except anthropic.AuthenticationError as exc:
            raise CoachError(
                "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env file."
            ) from exc
        except anthropic.PermissionDeniedError as exc:
            raise CoachError(f"This API key can't use {request.model}.") from exc
        except anthropic.NotFoundError as exc:
            raise CoachError(
                f"The model {request.model} wasn't found. Check the COACH_*_MODEL settings."
            ) from exc
        except anthropic.RateLimitError as exc:
            raise CoachError("The coach is being rate limited. Try again in a minute.") from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500:
                raise CoachError("Anthropic's service had a problem. Try again shortly.") from exc
            raise CoachError(f"The coach request was rejected: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise CoachError("Couldn't reach Anthropic. Check your internet connection.") from exc


class PracticeBackend:
    """A stand-in that streams a fixed reply: no AI, no key, no cost.

    Switched on with COACH_PRACTICE=1 when there is no API key, to try the coach screen or
    record a demo. The reply says plainly that it isn't the real coach.
    """

    REPLY = (
        "[Practice reply: no AI was used.] This is what a coach answer looks like. The real "
        "coach can see your account, positions, journal and statistics, and answers the "
        "question you asked. To switch it on, add ANTHROPIC_API_KEY to your .env file, "
        "remove COACH_PRACTICE, and restart the backend."
    )

    async def stream(self, request: Request) -> AsyncIterator[str | Finished]:
        import asyncio

        for word in self.REPLY.split(" "):
            await asyncio.sleep(0.03)
            yield word + " "
        yield Finished(Usage())


def _messages(request: Request) -> Any:
    # The SDK's message type is a TypedDict union; these plain role/content dicts match it.
    return request.messages


def _effort(effort: str) -> Any:
    return effort


def _finished(usage: Any, stop_reason: str | None) -> Finished:
    return Finished(
        Usage(
            input_tokens=usage.input_tokens or 0,
            output_tokens=usage.output_tokens or 0,
            cache_write_tokens=usage.cache_creation_input_tokens or 0,
            cache_read_tokens=usage.cache_read_input_tokens or 0,
        ),
        stop_reason,
    )


def clean_history(history: object) -> list[dict[str, str]]:
    """The recent conversation as alternating user/assistant turns ending with the coach.

    Anything malformed is dropped rather than sent: the browser holds the conversation, so
    it is untrusted input.
    """
    if not isinstance(history, list):
        return []
    turns: list[dict[str, str]] = []
    for item in history:
        if not isinstance(item, dict):
            return []
        role, content = item.get("role"), item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content:
            return []
        turns.append({"role": role, "content": content[:MAX_HISTORY_CHARS]})
    turns = turns[-MAX_HISTORY_MESSAGES:]
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    while turns and turns[-1]["role"] != "assistant":
        turns.pop()
    alternating = all(
        turn["role"] == ("user" if i % 2 == 0 else "assistant") for i, turn in enumerate(turns)
    )
    return turns if alternating else []


class Coach:
    def __init__(
        self,
        backend: Backend | None,
        ledger: Ledger | None = None,
        chat_model: str = "claude-haiku-5-5",
        review_model: str = "claude-sonnet-5-5",
        monthly_budget_usd: float = 10.0,
    ) -> None:
        self._backend = backend
        self.ledger = ledger or Ledger()
        self.models: dict[str, str] = {"chat": chat_model, "review": review_model}
        self.monthly_budget_usd = monthly_budget_usd

    @property
    def available(self) -> bool:
        return self._backend is not None

    def status(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "chat_model": self.models["chat"],
            "review_model": self.models["review"],
            "spent_usd": round(self.ledger.spent(), 4),
            "budget_usd": self.monthly_budget_usd,
            "calls": self.ledger.calls(),
        }

    def build(
        self, kind: object, question: object, history: object, context: dict[str, Any]
    ) -> Request:
        """Check a request and turn it into what is sent to the model."""
        if self._backend is None:
            raise CoachError(
                "The coach is switched off: add ANTHROPIC_API_KEY to your .env file and "
                "restart the backend."
            )
        if kind not in ("chat", "review"):
            raise CoachError("Unknown coach request")
        if self.ledger.spent() >= self.monthly_budget_usd:
            raise CoachError(
                f"This month's coach budget (US${self.monthly_budget_usd:.2f}) is used up. "
                "Raise COACH_MONTHLY_BUDGET_USD in .env, or wait for next month."
            )
        if kind == "review":
            text, turns = REVIEW_REQUEST, []
        else:
            if not isinstance(question, str) or not question.strip():
                raise CoachError("Type a question for the coach")
            if len(question) > MAX_QUESTION_CHARS:
                raise CoachError(f"Keep questions under {MAX_QUESTION_CHARS:,} characters")
            text, turns = question.strip(), clean_history(history)
        return Request(
            model=self.models[str(kind)],
            system=SYSTEM_PROMPT,
            messages=[*turns, {"role": "user", "content": user_message(text, context)}],
            max_tokens=MAX_TOKENS[str(kind)],
            effort=EFFORT[str(kind)],
        )

    async def reply(self, request: Request) -> AsyncIterator[str]:
        """Stream the reply's text, recording its cost when it finishes."""
        assert self._backend is not None
        wrote = False
        async for item in self._backend.stream(request):
            if isinstance(item, str):
                wrote = wrote or bool(item)
                yield item
                continue
            self.ledger.record(request.model, item.usage)
            if item.stop_reason == "refusal":
                yield (
                    "\n\n[The model declined to answer this one. Try rephrasing the question.]"
                    if wrote
                    else "The model declined to answer this one. Try rephrasing the question."
                )
            elif item.stop_reason == "max_tokens":
                yield "\n\n[The reply was cut off at the length limit. Ask me to continue.]"


def coach_from_env() -> Coach:
    """The coach as configured in `.env` (switched off when there is no API key)."""
    load_env()
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    try:
        budget = float(os.environ.get("COACH_MONTHLY_BUDGET_USD") or 10)
    except ValueError:
        budget = 10.0
    backend: Backend | None = None
    if has_key:
        backend = AnthropicBackend()
    elif os.environ.get("COACH_PRACTICE") == "1":
        backend = PracticeBackend()
    return Coach(
        backend,
        Ledger(state_dir() / "coach_usage.json"),
        chat_model=os.environ.get("COACH_CHAT_MODEL") or "claude-haiku-5-5",
        review_model=os.environ.get("COACH_REVIEW_MODEL") or "claude-sonnet-5-5",
        monthly_budget_usd=budget,
    )
