"""DSH 大脑桥接：把 QQ 消息转给本机 DSH，按 QQ 会话建立 DSH 会话窗口。

为什么这么做：AstrBot 的「OpenAI 兼容 provider」只传 messages，没有「这条消息来自
哪个 QQ 会话」的身份，只能把所有对话塞进一个固定会话；而插件里能拿到
`event.unified_msg_origin`（aiocqhttp:FriendMessage:号码 / GroupMessage:群号）。
所以插件把 (umo, 文本) POST 给 dsh-Dfy 的本地接口，DSH 按 umo 建/复用会话，
回复再交回 AstrBot 发送。

结果：
  · DSH 侧侧栏里每段 QQ 对话一个会话窗口（可切模型、看思考、看上下文）；
  · AstrBot 的插件链照常运行（表情包、延时、收尾等结果类插件）；默认 LLM 被跳过
    （event.call_llm = False），避免 AstrBot 再回一遍。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import urllib.request
from urllib.parse import urlparse
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

# dsh-Dfy 每分钟重写这个文件（端口漂移 / 令牌轮换都靠它）
HOST_FILE = Path.home() / ".dsh" / "surfcore" / "astrbot" / "dsh-bridge.json"
DEFAULT_TIMEOUT_S = 180


def _read_host() -> dict[str, Any] | None:
    try:
        return json.loads(HOST_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _post_json(url: str, payload: dict[str, Any], token: str, timeout_s: float) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 - 只连本机回环
        raw = res.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 不把原始响应回吐到聊天里（可能含内部路径/错误栈）
        return {"ok": False, "error": "bad-response"}


@register(
    "astrbot_plugin_dsh_bridge",
    "dsh-Dfy",
    "把 QQ 消息转给本机 DSH，按 QQ 会话建立 DSH 会话窗口",
    "1.0.0",
)
class DshBridge(Star):
    def __init__(self, context: Context, config: Any = None) -> None:
        super().__init__(context)
        self._config = config

    async def _active_persona(self) -> tuple[str, str]:
        """从 AstrBot 人格系统取当前人格提示词（「人格与语气」页继续对 QQ 生效）。"""
        try:
            manager = getattr(self.context, "persona_manager", None)
            if manager is None:
                return "", ""
            persona = await manager.get_default_persona_v3()
            prompt = str(getattr(persona, "system_prompt", "") or "").strip()
            if not prompt:
                return "", ""
            digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
            return prompt[:8000], digest
        except Exception as exc:
            logger.debug(f"[dsh-bridge] 读取当前人格失败：{exc!r}")
            return "", ""

    async def _ask_dsh(self, key: str, text: str) -> str:
        host = _read_host()
        if not host:
            return "（她的 DSH 大脑还没就绪：找不到 dsh-bridge.json，先确认 DSH 里 dsh-Dfy 插件在跑）"
        base = str(host.get("baseUrl") or "").rstrip("/")
        api = str(host.get("path") or "/dsh-surfcore/v1/qq-bridge/ask")
        token = str(host.get("token") or "")
        if not base or not token:
            return "（她的 DSH 大脑还没就绪：桥接地址或令牌为空）"
        # 发现文件可能被同机进程篡改：只允许 http://回环地址，防止把 token 发到任意主机
        parsed = urlparse(base)
        if parsed.scheme != "http" or (parsed.hostname or "") not in ("127.0.0.1", "localhost", "::1"):
            logger.warning("[dsh-bridge] dsh-bridge.json 的 baseUrl 不是本机回环，已拒绝")
            return "（她的 DSH 桥接地址异常，已拒绝连接：请在 DSH 里重新加载 dsh-Dfy 插件）"
        timeout_s = float(host.get("timeoutSeconds") or DEFAULT_TIMEOUT_S) + 20
        persona, persona_hash = await self._active_persona()
        payload = {
            "key": key,
            "text": text,
            "timeoutMs": DEFAULT_TIMEOUT_S * 1000,
            "persona": persona,
            "personaHash": persona_hash,
        }
        try:
            data = await asyncio.to_thread(_post_json, base + api, payload, token, timeout_s)
        except Exception as exc:  # 网络/超时：日志留细节，聊天里只回固定话术（不回吐内部信息）
            logger.warning(f"[dsh-bridge] 调用 DSH 失败：{exc!r}")
            return "（她那边没接上，稍后再试一次）"
        if not data.get("ok"):
            logger.warning(f"[dsh-bridge] DSH 返回错误：{str(data.get('error'))[:200]}")
            return "（她那边出错了：在 DSH 设置 → 维护 → 诊断体检里看是哪一步）"
        return str(data.get("reply") or "").strip()

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        """QQ 消息 → DSH 会话 → 回复。只跳过 webchat（设置页自测），其它平台都接管。

        注意：umo 的平台段是**平台 ID**（如 `qq-napcat`），不是适配器类型 `aiocqhttp`；
        2026-11 实测踩过：写成 startswith("aiocqhttp") 会让插件一字不处理，消息全落到
        provider 路线（固定会话 + 更慢）。
        """
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        if not umo or umo.startswith("webchat"):
            return
        text = str(getattr(event, "message_str", "") or "").strip()
        if not text:
            # 纯图片/表情/语音等非文本消息：v1 不转发（避免把空文本灌进会话），
            # 但**不能什么都不回**——以前直接 return，用户发图给机器人会以为它死了。
            try:
                yield event.plain_result("（图片/语音我收到啦，先用文字跟我说一句吧）")
            except Exception:
                pass
            return
        # 关键：跳过 AstrBot 默认 LLM，否则会和 DSH 的回复变成两条。
        try:
            event.should_call_llm(False)
        except Exception:
            event.call_llm = False
            logger.debug("[dsh-bridge] should_call_llm 不可用，已退回设置 call_llm=False")
        logger.debug("[dsh-bridge] 收到 QQ 消息 → DSH")
        # 等待 DSH 想完再回：先让 QQ 侧显示「正在输入」，明显降低体感延迟
        try:
            typing = getattr(event, "send_typing", None)
            if callable(typing):
                await typing()
        except Exception:
            pass
        reply = await self._ask_dsh(umo, text)
        if reply:
            yield event.plain_result(reply)
        else:
            # 大脑返回空串时以前什么都不发 → 用户以为被无视。给一句可操作的兜底。
            yield event.plain_result("（我这边刚才没想出来，你再说一次？）")
