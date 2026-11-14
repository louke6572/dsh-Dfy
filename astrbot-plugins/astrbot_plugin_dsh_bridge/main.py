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

    def _sender_id(self, event: AstrMessageEvent) -> str:
        """发送者 QQ 号（黑名单 deny.users 按**人**拦需要它，会话级字段不带发送者）。"""
        try:
            return str(event.get_sender_id() or "").strip()
        except Exception:
            return ""

    async def _ask_dsh(self, key: str, text: str, extra: dict[str, Any] | None = None, sender_id: str = "") -> str | None:
        """转发给 DSH。返回：None = 调用失败（网络/参数/DSH 报错）；字符串 = DSH 的回复（可能为空）。
        把"失败"和"DSH 想完但没说话"区分开：文字消息两者都静默，语音条失败时要回退占位文案。
        DSH 侧问题（文件缺失/地址异常）同样返回 None——内部错误串当角色台词发出去是
        2026-11-14 体检点名修掉的（群里会看到一句旁白腔的"大脑还没就绪"）。"""
        host = _read_host()
        if not host:
            logger.warning("[dsh-bridge] 调用失败：找不到 dsh-bridge.json（DSH 没在跑或插件数据目录不对）")
            return None
        base = str(host.get("baseUrl") or "").rstrip("/")
        api = str(host.get("path") or "/dsh-surfcore/v1/qq-bridge/ask")
        token = str(host.get("token") or "")
        if not base or not token:
            logger.warning("[dsh-bridge] 调用失败：桥接地址或令牌为空")
            return None
        # 发现文件可能被同机进程篡改：只允许 http://回环地址，防止把 token 发到任意主机
        parsed = urlparse(base)
        if parsed.scheme != "http" or (parsed.hostname or "") not in ("127.0.0.1", "localhost", "::1"):
            logger.warning("[dsh-bridge] dsh-bridge.json 的 baseUrl 不是本机回环，已拒绝")
            return None
        timeout_s = float(host.get("timeoutSeconds") or DEFAULT_TIMEOUT_S) + 20
        persona, persona_hash = await self._active_persona()
        payload = {
            "key": key,
            "text": text,
            "timeoutMs": DEFAULT_TIMEOUT_S * 1000,
            "persona": persona,
            "personaHash": persona_hash,
            # 黑名单 deny.users 按发送者拦；拿不到就空串（DSH 侧只按会话拦）
            "senderId": str(sender_id or ""),
        }
        if extra:
            payload.update(extra)
        try:
            data = await asyncio.to_thread(_post_json, base + api, payload, token, timeout_s)
        except Exception as exc:  # 网络/超时：只写日志，不往聊天里发内部错误话术
            logger.warning(f"[dsh-bridge] 调用 DSH 失败：{exc!r}")
            return None
        if not data.get("ok"):
            logger.warning(f"[dsh-bridge] DSH 返回错误：{str(data.get('error'))[:200]}")
            return None
        return str(data.get("reply") or "").strip()

    def _extract_voice(self, event: AstrMessageEvent) -> dict[str, str] | None:
        """找出消息里的语音段（record），只取标识不碰音频。语音下载/解码/转写全在 DSH 侧。
        兼容两条来源：message_obj.raw_message（aiocqhttp 平台是 OneBot 消息数组）和
        AstrBot 的消息组件列表（Record 组件有 file/url 属性）。"""
        try:
            raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
            if isinstance(raw, list):
                for seg in raw:
                    if isinstance(seg, dict) and str(seg.get("type") or "").lower() == "record":
                        data = seg.get("data") or {}
                        fid = str(data.get("file") or "").strip()
                        furl = str(data.get("url") or "").strip()
                        if fid or furl:
                            return {"file": fid, "url": furl}
            comps = list(getattr(getattr(event, "message_obj", None), "message", None) or [])
            for comp in comps:
                ctype = str(getattr(comp, "type", "") or type(comp).__name__).lower()
                if ctype == "record":
                    fid = str(getattr(comp, "file", "") or "").strip()
                    furl = str(getattr(comp, "url", "") or "").strip()
                    if fid or furl:
                        return {"file": fid, "url": furl}
        except Exception as exc:
            logger.debug(f"[dsh-bridge] 识别语音段失败：{exc!r}")
        return None

    async def _ask_voice(self, event: AstrMessageEvent, key: str) -> str | None:
        """语音条 → DSH 转写 → 回复。
        返回 None = 没走语音通道（没有 record 段 / 设置里没开语音识别）→ 调用方回退占位文案；
        "" = 走了通道但没话可说（失败或空回复）→ 静默；其余为回复文本。"""
        voice = self._extract_voice(event)
        if not voice:
            return None
        host = _read_host()
        if not isinstance(host, dict) or host.get("voiceAsrEnabled") is not True:
            return None
        extra: dict[str, Any] = {}
        if voice.get("file"):
            extra["voiceFile"] = voice["file"]
        if voice.get("url"):
            extra["voiceUrl"] = voice["url"]
        if not extra:
            return None
        logger.debug("[dsh-bridge] 收到 QQ 语音条 → DSH 转写")
        try:
            typing = getattr(event, "send_typing", None)
            if callable(typing):
                await typing()
        except Exception:
            pass
        return await self._ask_dsh(key, "", extra=extra, sender_id=self._sender_id(event))

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
        # 关键：跳过 AstrBot 默认 LLM，否则会和 DSH 的回复变成两条。
        # 对语音条路径同样生效（转写成文字走的就是同一条 DSH 通道）。
        try:
            event.should_call_llm(False)
        except Exception:
            event.call_llm = False
            logger.debug("[dsh-bridge] should_call_llm 不可用，已退回设置 call_llm=False")
        text = str(getattr(event, "message_str", "") or "").strip()
        if not text:
            # 纯图片/表情/语音等非文本消息。语音条且「语音识别」开着时转成文字照常对话；
            # 其它情况保持占位文案——**不能什么都不回**，用户发图给机器人会以为它死了。
            voice_reply = await self._ask_voice(event, umo)
            if voice_reply is None:
                try:
                    yield event.plain_result("（图片/语音我收到啦，先用文字跟我说一句吧）")
                except Exception:
                    pass
                return
            if voice_reply:
                yield event.plain_result(voice_reply)
            else:
                logger.info("[dsh-bridge] 语音转写后没有文本输出，跳过发送")
            return
        logger.debug("[dsh-bridge] 收到 QQ 消息 → DSH")
        # 等待 DSH 想完再回：先让 QQ 侧显示「正在输入」，明显降低体感延迟
        try:
            typing = getattr(event, "send_typing", None)
            if callable(typing):
                await typing()
        except Exception:
            pass
        reply = await self._ask_dsh(umo, text, sender_id=self._sender_id(event))
        if reply:
            yield event.plain_result(reply)
        else:
            # 空回复 / 调用失败：静默跳过，只写日志。
            # 以前这里发「（我这边刚才没想出来，你再说一次？）」—— 失败一次刷一次，
            # 格式像旁白，会被当成角色本人说的话，很出戏。
            logger.info("[dsh-bridge] 本轮没有文本输出，跳过发送")
